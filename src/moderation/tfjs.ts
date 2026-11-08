// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Stand-in for the `@tensorflow/tfjs` meta package.
 *
 * `nsfwjs/core` does `import * as tf from "@tensorflow/tfjs"`, and that meta
 * package pulls in the *whole* TensorFlow.js runtime — layers, every backend,
 * the data pipeline — several megabytes of it. We only ever load a **graph**
 * model and run inference, which needs exactly two of its pieces. The
 * `resolve.alias` entry in vite.config.ts points `@tensorflow/tfjs` at this
 * file so nsfwjs gets those two and nothing else.
 *
 * Deliberately side-effect free: registering a backend is
 * `src/moderation/imagePrecheck.ts`'s job (WebGL, CPU only as a fallback), so
 * the CPU backend stays out of the chunk unless a browser actually needs it.
 *
 * Not re-exported, because we do not use them and they are what the trimming is
 * about: `loadLayersModel`/`model` (tfjs-layers — graph models don't need them;
 * `NSFWJS.load` only calls `loadLayersModel` when `options.type !== 'graph'`,
 * and `infer` only calls `model` for an intermediate `endpoint`, neither of
 * which we do), and the tfjs-data/tfjs-node surface.
 */

export * from '@tensorflow/tfjs-core';
// loadGraphModel + GraphModel. No export-name overlap with tfjs-core.
export * from '@tensorflow/tfjs-converter';
