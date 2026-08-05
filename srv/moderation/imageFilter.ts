// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import crypto from "crypto";
import path from "path";
import config from "../common/config";
import errors from "../common/errors";

// Server-side NSFW image classifier — the authoritative safety gate for every
// image that enters object storage. It runs in-process (no sidecar) via
// @huggingface/transformers + onnxruntime-node against the model directory
// baked into the backend image (config.IMAGE_MODERATION_MODEL_PATH, override
// to swap in any Transformers.js-layout image classifier).
//
// The hook site is fileHelper.saveImage(), which is the single choke point
// for direct uploads and for all server-side URL ingests (URL previews,
// LUKSO LSP3, Twitter/Farcaster avatars). That means this module runs in two
// processes — api and onchain — neither of which has an async startup
// sequence to await a model load in, so the pipeline is loaded lazily on
// first classification and cached as a promise.

/** Labels that count towards the reject score. Covers the baked-in
 * Falconsai model ("nsfw") plus the label sets of common swap-in
 * classifiers, which split the class (e.g. "porn"/"hentai"). */
const NSFW_LABELS = new Set(["nsfw", "porn", "hentai", "explicit"]);

/** Ask for effectively all labels — the pipeline default (top 5) could hide
 * the nsfw labels of a swapped-in many-class model. */
const CLASSIFY_TOP_K = 20;

const SCORE_CACHE_SIZE = 128;

type LabelScore = { label: string; score: number };

type Classifier = (
  image: unknown,
  options: { top_k: number },
) => Promise<LabelScore[]>;

let classifierPromise: Promise<Classifier> | null = null;

// Several upload types store two sharp variants (small + large) of the same
// source buffer in one request; keying this LRU by the *source* buffer makes
// that a single classification. Values are promises so the concurrent
// Promise.all([saveImage(small), saveImage(large)]) pattern coalesces too.
const scoreCache = new Map<string, Promise<LabelScore[]>>();

function cacheGet(key: string): Promise<LabelScore[]> | undefined {
  const value = scoreCache.get(key);
  if (value) {
    // refresh LRU position (Map preserves insertion order)
    scoreCache.delete(key);
    scoreCache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: Promise<LabelScore[]>) {
  scoreCache.delete(key);
  scoreCache.set(key, value);
  while (scoreCache.size > SCORE_CACHE_SIZE) {
    const oldest = scoreCache.keys().next().value;
    if (oldest === undefined) break;
    scoreCache.delete(oldest);
  }
}

// api.js / onchain.js / migrateDb.js — for rejection logs
const processName = path.basename(process.argv[1] || "unknown", ".js");

async function loadClassifier(): Promise<Classifier> {
  const modelDir = path.resolve(config.IMAGE_MODERATION_MODEL_PATH);
  const { env, pipeline } = await import("@huggingface/transformers");
  // the model is baked into the image / mounted locally — the runtime must
  // never fetch weights from the network
  env.allowRemoteModels = false;
  env.localModelPath = path.dirname(modelDir);
  const classifier = await pipeline(
    "image-classification",
    path.basename(modelDir),
    // q8 resolves to onnx/model_quantized.onnx inside the model directory
    { dtype: "q8" },
  );
  return classifier as unknown as Classifier;
}

function getClassifier(): Promise<Classifier> {
  if (!classifierPromise) {
    classifierPromise = loadClassifier();
    // a failed load (missing/broken model dir) must not poison the cache
    // forever — self-hosters can fix the mount without a restart
    classifierPromise.catch(() => {
      classifierPromise = null;
    });
  }
  return classifierPromise;
}

async function classify(imageBuffer: Buffer): Promise<LabelScore[]> {
  const [classifier, { RawImage }] = await Promise.all([
    getClassifier(),
    import("@huggingface/transformers"),
  ]);
  // copy into a plain ArrayBuffer-backed view — Buffer's ArrayBufferLike
  // typing is not a valid BlobPart under the DOM typings RawImage.read uses
  const bytes = new Uint8Array(imageBuffer.byteLength);
  bytes.set(imageBuffer);
  const image = await RawImage.read(new Blob([bytes]));
  return await classifier(image, { top_k: CLASSIFY_TOP_K });
}

function nsfwScore(scores: LabelScore[]): number {
  let total = 0;
  for (const { label, score } of scores) {
    if (NSFW_LABELS.has(label.toLowerCase())) {
      total += score;
    }
  }
  return total;
}

export type ModerationContext = {
  /** upload type from API.Files.UploadOptions (or a synthetic marker) */
  uploadType: string;
  /** uploading user, when the path has one (URL ingests and pre-auth
   * profile uploads do not) */
  userId?: string | null;
};

/**
 * Classifies an image and throws `IMAGE_CONTENT_REJECTED` when its NSFW
 * probability exceeds `config.IMAGE_MODERATION_THRESHOLD`. Resolves silently
 * when the filter is disabled or the image passes.
 *
 * Fails closed: when classification itself fails (model directory missing or
 * unreadable), the image is NOT stored — callers get `INTERNAL`. A broken
 * moderation setup should surface as failing uploads, not as an open gate.
 *
 * @param imageBuffer the post-sharp buffer that is about to be stored
 * @param cacheKeyBuffer identifies the *source* content for the dedup cache;
 *   pass the original input so size variants of one source classify once
 */
async function assertImageAllowed(
  imageBuffer: Buffer,
  cacheKeyBuffer: Buffer,
  context: ModerationContext,
): Promise<void> {
  if (!config.IMAGE_MODERATION_ENABLED) {
    return;
  }
  const key = crypto.createHash("sha256").update(cacheKeyBuffer).digest("hex");
  let scoresPromise = cacheGet(key);
  if (!scoresPromise) {
    scoresPromise = classify(imageBuffer);
    cacheSet(key, scoresPromise);
    scoresPromise.catch(() => {
      scoreCache.delete(key);
    });
  }
  let scores: LabelScore[];
  try {
    scores = await scoresPromise;
  } catch (e) {
    console.error(
      `imageFilter: classification failed (uploadType=${context.uploadType}, process=${processName})`,
      e,
    );
    throw new Error(errors.server.INTERNAL);
  }
  if (nsfwScore(scores) > config.IMAGE_MODERATION_THRESHOLD) {
    // no image data in the log — only scores and routing metadata
    console.error(
      "imageFilter: rejected image",
      JSON.stringify({
        uploadType: context.uploadType,
        userId: context.userId || null,
        process: processName,
        threshold: config.IMAGE_MODERATION_THRESHOLD,
        scores: scores.map(({ label, score }) => ({
          label,
          score: Math.round(score * 10000) / 10000,
        })),
      }),
    );
    throw new Error(errors.server.IMAGE_CONTENT_REJECTED);
  }
}

const imageFilter = {
  assertImageAllowed,
};

export default imageFilter;
