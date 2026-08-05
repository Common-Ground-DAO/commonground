// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import crypto from "crypto";
import path from "path";
import sharp from "sharp";
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
//
// What gets classified is a deterministic 224px normalization of the SOURCE
// buffer (not the per-variant resized output): small+large variants of one
// upload therefore agree with each other and with the dedup cache. Animated
// sources are scanned frame by frame (evenly sampled up to MAX_FRAMES_SCANNED
// when they are stored animated) — classifying only the first frame would let
// a benign frame 0 smuggle arbitrary later frames into storage.

/** Labels that count towards the reject score. Covers the baked-in
 * Falconsai model ("nsfw") plus the label sets of common swap-in
 * classifiers, which split the class (e.g. "porn"/"hentai"). */
const NSFW_LABELS = new Set(["nsfw", "porn", "hentai", "explicit"]);

/** Ask for effectively all labels — the pipeline default (top 5) could hide
 * the nsfw labels of a swapped-in many-class model. */
const CLASSIFY_TOP_K = 20;

/** Edge length of the normalized frame handed to the model (the ViT
 * preprocessor squashes to 224x224 anyway; downscaling first bounds the
 * per-frame decode cost and makes the classified bytes deterministic). */
const CLASSIFY_SIZE = 224;

/** Frames scanned per animated image, evenly spaced across the animation
 * (always including the first and last frame). A cap, not a promise to see
 * every frame — at ~20 ms per frame a full scan of long GIFs would be an
 * easy CPU-exhaustion vector. */
const MAX_FRAMES_SCANNED = 16;

/** Concurrent classification jobs (whole images, not frames). Inference and
 * the sharp frame decodes share the libuv threadpool with bcrypt and the
 * upload pipeline itself — unbounded concurrency would let an upload burst
 * starve password logins on small selfhost machines. */
const MAX_CONCURRENT_CLASSIFICATIONS = 2;

const SCORE_CACHE_SIZE = 128;

type LabelScore = { label: string; score: number };

type ClassificationVerdict = {
  /** label scores of the worst (highest nsfw score) scanned frame */
  scores: LabelScore[];
  /** index of that frame (0 for static images) */
  frameIndex: number;
  framesScanned: number;
  /** total frames in the source (1 for static images) */
  pages: number;
};

type Classifier = (
  image: unknown,
  options: { top_k: number },
) => Promise<LabelScore[]>;

let classifierPromise: Promise<Classifier> | null = null;

// Several upload types store two sharp variants (small + large) of the same
// source buffer in one request; keying this LRU by the *source* buffer makes
// that a single classification. Values are promises so the concurrent
// Promise.all([saveImage(small), saveImage(large)]) pattern coalesces too.
const scoreCache = new Map<string, Promise<ClassificationVerdict>>();

function cacheGet(key: string): Promise<ClassificationVerdict> | undefined {
  const value = scoreCache.get(key);
  if (value) {
    // refresh LRU position (Map preserves insertion order)
    scoreCache.delete(key);
    scoreCache.set(key, value);
  }
  return value;
}

function cacheSet(key: string, value: Promise<ClassificationVerdict>) {
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

// minimal FIFO semaphore for MAX_CONCURRENT_CLASSIFICATIONS
let activeJobs = 0;
const jobQueue: (() => void)[] = [];

async function withClassificationSlot<T>(job: () => Promise<T>): Promise<T> {
  if (activeJobs >= MAX_CONCURRENT_CLASSIFICATIONS) {
    await new Promise<void>((resolve) => jobQueue.push(resolve));
  }
  activeJobs++;
  try {
    return await job();
  } finally {
    activeJobs--;
    jobQueue.shift()?.();
  }
}

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
    {
      // q8 resolves to onnx/model_quantized.onnx inside the model directory
      dtype: "q8",
      // keep ORT's intra-op parallelism modest — see
      // MAX_CONCURRENT_CLASSIFICATIONS; latency per frame is ~20 ms either way
      session_options: { intraOpNumThreads: 2 },
    },
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

/** Evenly spaced frame indices, always including first and last. */
function sampleFrameIndices(pages: number, maxFrames: number): number[] {
  if (pages <= maxFrames) {
    return Array.from({ length: pages }, (_, i) => i);
  }
  const indices = new Set<number>();
  for (let i = 0; i < maxFrames; i++) {
    indices.add(Math.round((i * (pages - 1)) / (maxFrames - 1)));
  }
  return [...indices].sort((a, b) => a - b);
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

async function classifyFrame(
  classifier: Classifier,
  rawImage: { read: (input: Blob) => Promise<unknown> },
  imageBuffer: Buffer,
  page: number | undefined,
): Promise<LabelScore[]> {
  const frame = await sharp(imageBuffer, page === undefined ? {} : { page })
    .resize(CLASSIFY_SIZE, CLASSIFY_SIZE, { fit: "inside" })
    .webp()
    .toBuffer();
  // copy into a plain ArrayBuffer-backed view — Buffer's ArrayBufferLike
  // typing is not a valid BlobPart under the DOM typings RawImage.read uses
  const bytes = new Uint8Array(frame.byteLength);
  bytes.set(frame);
  const image = await rawImage.read(new Blob([bytes]));
  return await classifier(image, { top_k: CLASSIFY_TOP_K });
}

async function classifySource(
  imageBuffer: Buffer,
  animated: boolean,
): Promise<ClassificationVerdict> {
  const [classifier, { RawImage }] = await Promise.all([
    getClassifier(),
    import("@huggingface/transformers"),
  ]);
  return await withClassificationSlot(async () => {
    let pages = 1;
    if (animated) {
      const metadata = await sharp(imageBuffer, { animated: true }).metadata();
      if (metadata.pages && metadata.pages > 1) {
        pages = metadata.pages;
      }
    }
    if (pages === 1) {
      const scores = await classifyFrame(classifier, RawImage, imageBuffer, undefined);
      return { scores, frameIndex: 0, framesScanned: 1, pages };
    }
    const frameIndices = sampleFrameIndices(pages, MAX_FRAMES_SCANNED);
    let worst: ClassificationVerdict | null = null;
    for (const frameIndex of frameIndices) {
      const scores = await classifyFrame(classifier, RawImage, imageBuffer, frameIndex);
      if (!worst || nsfwScore(scores) > nsfwScore(worst.scores)) {
        worst = { scores, frameIndex, framesScanned: frameIndices.length, pages };
      }
      // already over the threshold — no need to scan further frames
      if (nsfwScore(worst.scores) > config.IMAGE_MODERATION_THRESHOLD) {
        break;
      }
    }
    return worst!;
  });
}

export type ModerationContext = {
  /** upload type from API.Files.UploadOptions (or a synthetic marker) */
  uploadType: string;
  /** uploading user, when the path has one (URL ingests and pre-auth
   * profile uploads do not) */
  userId?: string | null;
  /** whether the image is stored with all its frames (saveImage's `animated`
   * option) — only then are later frames scanned; a static store keeps
   * frame 0 only, and rejecting it for frames that never persist would be a
   * false positive by construction */
  animated?: boolean;
};

/**
 * Classifies the source image and throws `IMAGE_CONTENT_REJECTED` when the
 * NSFW probability of any scanned frame exceeds
 * `config.IMAGE_MODERATION_THRESHOLD`. Resolves silently when the filter is
 * disabled or the image passes.
 *
 * Fails closed: when classification itself fails (model directory missing or
 * unreadable, undecodable buffer), the image is NOT stored — callers get
 * `INTERNAL`. A broken moderation setup should surface as failing uploads,
 * not as an open gate.
 */
async function assertImageAllowed(
  imageBuffer: Buffer,
  context: ModerationContext,
): Promise<void> {
  if (!config.IMAGE_MODERATION_ENABLED) {
    return;
  }
  const animated = context.animated || false;
  // the animated flag changes what is scanned, so it is part of the key
  const key =
    crypto.createHash("sha256").update(imageBuffer).digest("hex") +
    (animated ? ":animated" : ":static");
  let verdictPromise = cacheGet(key);
  if (!verdictPromise) {
    verdictPromise = classifySource(imageBuffer, animated);
    cacheSet(key, verdictPromise);
    verdictPromise.catch(() => {
      // only evict our own promise — the slot may have been reused
      if (scoreCache.get(key) === verdictPromise) {
        scoreCache.delete(key);
      }
    });
  }
  let verdict: ClassificationVerdict;
  try {
    verdict = await verdictPromise;
  } catch (e) {
    console.error(
      `imageFilter: classification failed (uploadType=${context.uploadType}, process=${processName})`,
      e,
    );
    throw new Error(errors.server.INTERNAL);
  }
  if (nsfwScore(verdict.scores) > config.IMAGE_MODERATION_THRESHOLD) {
    // no image data in the log — only scores and routing metadata
    console.error(
      "imageFilter: rejected image",
      JSON.stringify({
        uploadType: context.uploadType,
        userId: context.userId || null,
        process: processName,
        threshold: config.IMAGE_MODERATION_THRESHOLD,
        frameIndex: verdict.frameIndex,
        framesScanned: verdict.framesScanned,
        pages: verdict.pages,
        scores: verdict.scores.map(({ label, score }) => ({
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
