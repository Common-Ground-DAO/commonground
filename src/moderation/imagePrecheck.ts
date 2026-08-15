// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Client-side NSFW pre-check — the *courtesy* half of the image filter.
 *
 * The server is the authority (`saveImage()` rejects with
 * `IMAGE_CONTENT_REJECTED`); this only exists so a user who is about to upload
 * something explicit finds out before the round trip, in a dialog they can
 * override. It therefore has one hard rule: **it must never break an upload.**
 * Every failure mode — model 404, WebGL unavailable, undecodable file, a
 * hanging fetch — resolves `'ok'`.
 *
 * This module is heavy (~170 KB gzip of tfjs + a 4.4 MB model fetch) and must
 * only ever be reached through the dynamic `import()` in
 * `checkImageBeforeUpload.ts`, which also owns the `IMAGE_FILTER_ENABLED` gate.
 * Importing it statically anywhere would make tfjs eager and, via
 * `assertCgidEntryChunks`, is likely to fail the build outright.
 */

import * as tf from '@tensorflow/tfjs-core';
// Side-effect import: registers the 'webgl' backend. The CPU backend is
// deliberately *not* imported here — see `selectBackend()`.
import '@tensorflow/tfjs-backend-webgl';
import { load, type NSFWJS, type PredictionType } from 'nsfwjs/core';

/** Self-hosted graph model; see public/models/nsfw/README.md. */
const MODEL_URL = '/models/nsfw/model.json';

/** Input edge length the MobileNetV2 graph model expects. */
const MODEL_INPUT_SIZE = 224;

/**
 * Classes that count towards the suspicion score.
 *
 * Still biased towards precision — MobileNetV2 is ~90% accurate and a false
 * positive here means a legitimate upload gets an accusatory dialog — but a
 * little less so than the old single-class ≥ 0.85 rule: summing against a 0.8
 * default fires on cases that rule missed. That is the intended direction
 * (a dialog the user can click through, in exchange for fewer images that pass
 * here and are then refused by the server), and `Sexy`,
 * `Drawing` and `Neutral` are ignored entirely — `Sexy` in particular fires on
 * beachwear and gym photos. Missed borderline content is the server's problem,
 * and after that community moderation's.
 *
 * Their probabilities are **summed**, mirroring `nsfwScore()` in
 * `srv/moderation/imageFilter.ts`. The two models stay different — this is
 * nsfwjs/MobileNetV2, the server runs a ViT — so verdicts can still diverge,
 * but the aggregation no longer does: an image the server scores as a
 * confident 0.9 nsfw, and which this model splits 0.5 `Porn` / 0.45 `Hentai`
 * because it cannot decide which kind it is, now trips both instead of only
 * the server.
 */
const FLAGGED_CLASSES: ReadonlySet<PredictionType['className']> = new Set(['Porn', 'Hentai']);

/**
 * Hard ceiling for the whole check, model download included.
 *
 * Without it a stalled shard fetch would leave the upload waiting forever. On a
 * warm cache the check is 100–300 ms; the first call pays the model download.
 */
const TOTAL_TIMEOUT_MS = 15_000;

export type PrecheckVerdict = 'ok' | 'suspicious';

/**
 * Module singleton: the promise, not the model, so concurrent first calls (a
 * multi-file drop) share one load.
 *
 * Cleared again when that load fails, mirroring `getClassifier()` on the
 * server. Caching the rejection was the tidier-looking option, but it meant one
 * flaky shard fetch silently disabled early warnings for the entire life of the
 * page — the user keeps uploading, every check answers `'ok'` without ever
 * having run, and nothing says so. A retry costs at most one wasted request per
 * selected file, and only while the model is genuinely unreachable.
 */
let modelPromise: Promise<NSFWJS> | undefined;

async function selectBackend(): Promise<void> {
  try {
    await tf.setBackend('webgl');
    await tf.ready();
    if (tf.getBackend() === 'webgl') return;
    throw new Error('webgl backend did not become active');
  } catch {
    // No WebGL (blocked, software-blacklisted, context limit reached). The CPU
    // backend is a separate package, imported here rather than at module scope
    // so it becomes its own chunk (~89 KB on top of what the WebGL backend
    // already pulls in from it) that only a browser without WebGL fetches. It
    // is far slower, but this runs once per selected file, not per frame.
    await import('@tensorflow/tfjs-backend-cpu');
    await tf.setBackend('cpu');
    await tf.ready();
  }
}

function loadModel(): Promise<NSFWJS> {
  if (!modelPromise) {
    const pending = (async () => {
      // Drops shape/dtype assertions and the WebGL debug paths.
      tf.enableProdMode();
      await selectBackend();
      return load(MODEL_URL, { size: MODEL_INPUT_SIZE, type: 'graph' });
    })();
    modelPromise = pending;
    pending.catch(() => {
      // only drop our own attempt — a later call may already have replaced it
      if (modelPromise === pending) modelPromise = undefined;
    });
  }
  return modelPromise;
}

/**
 * Decodes `file` into a `MODEL_INPUT_SIZE`² canvas.
 *
 * Done here rather than handing the full-resolution image to nsfwjs on purpose:
 * `tf.browser.fromPixels` would allocate a tensor for every pixel of a 12 MP
 * photo before resizing it. Squashing to a square (rather than cropping or
 * letterboxing) is what nsfwjs' own `resizeBilinear` path does, so the model
 * sees the geometry it was trained and calibrated on.
 *
 * Returns `undefined` for anything the browser will not decode — SVGs with
 * external references, corrupt files, formats this browser lacks.
 */
function decodeToCanvas(file: File): Promise<HTMLCanvasElement | undefined> {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const image = new Image();

    const finish = (result: HTMLCanvasElement | undefined) => {
      URL.revokeObjectURL(url);
      resolve(result);
    };

    image.onload = () => {
      try {
        // An SVG without intrinsic dimensions decodes to 0×0.
        if (!image.naturalWidth || !image.naturalHeight) return finish(undefined);
        const canvas = document.createElement('canvas');
        canvas.width = MODEL_INPUT_SIZE;
        canvas.height = MODEL_INPUT_SIZE;
        const context = canvas.getContext('2d');
        if (!context) return finish(undefined);
        context.drawImage(image, 0, 0, MODEL_INPUT_SIZE, MODEL_INPUT_SIZE);
        finish(canvas);
      } catch {
        // Tainted canvas, out of memory, …
        finish(undefined);
      }
    };
    image.onerror = () => finish(undefined);
    image.src = url;
  });
}

/** Exported for tests — pure, and the one place the verdict is actually decided. */
export function isSuspicious(predictions: PredictionType[], threshold: number): boolean {
  const score = predictions.reduce(
    (total, prediction) =>
      FLAGGED_CLASSES.has(prediction.className) ? total + prediction.probability : total,
    0,
  );
  // `>` not `>=`, matching the server's `nsfwScore(...) > threshold`: a
  // threshold of 1 must mean "never warn" on both sides, not "warn on a
  // perfect score here but not there"
  return score > threshold;
}

/** Exported for tests. */
export function withTimeout<T>(promise: Promise<T>, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), TOTAL_TIMEOUT_MS);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

/**
 * Classifies one already-selected file. Never rejects, never throws.
 *
 * `threshold` is this instance's server-side `IMAGE_MODERATION_THRESHOLD`,
 * passed in rather than read from `common/config` so this module stays free of
 * app imports — it is a lazily fetched chunk, and its only dependency should be
 * the classifier.
 *
 * Callers should go through `checkImageBeforeUpload()` instead of calling this
 * directly — it owns the instance-config gate and the confirmation dialog.
 */
export function checkImageFile(file: File, threshold: number): Promise<PrecheckVerdict> {
  return withTimeout(
    (async (): Promise<PrecheckVerdict> => {
      const canvas = await decodeToCanvas(file);
      if (!canvas) return 'ok';
      const model = await loadModel();
      // Default topk is 5 = every class the model has; the two we care about
      // are always in there.
      const predictions = await model.classify(canvas);
      return isSuspicious(predictions, threshold) ? 'suspicious' : 'ok';
    })(),
    'ok',
  );
}
