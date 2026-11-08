// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The gate in front of the classifier, pinned because the two cheap early
 * returns carry real weight:
 *
 * - `IMAGE_FILTER_ENABLED === false` must not merely skip the check, it must
 *   never *reach* `./imagePrecheck` — that dynamic import is ~170 KB gzip of
 *   tfjs plus a 4.4 MB model fetch, and an instance that turned the filter off
 *   should pay none of it. `precheckModuleEvaluated` is the observable proof:
 *   the mock factory only runs when the module is genuinely imported.
 * - the check must be incapable of rejecting an upload on its own. Every path
 *   here either resolves `true` or hands the decision to the confirmation
 *   dialog, whose answer is passed straight through.
 */

const state = vi.hoisted(() => ({
  imageFilterEnabled: true,
  imageFilterThreshold: 0.8,
  precheckModuleEvaluated: false,
  verdict: 'ok' as 'ok' | 'suspicious',
  precheckThrows: false,
  confirmCalls: 0,
  confirmAnswer: true,
  /** threshold the gate handed to the classifier on the last call */
  thresholdSeen: undefined as number | undefined,
}));

vi.mock('common/config', () => ({
  default: {
    get IMAGE_FILTER_ENABLED() {
      return state.imageFilterEnabled;
    },
    get IMAGE_FILTER_THRESHOLD() {
      return state.imageFilterThreshold;
    },
  },
}));

vi.mock('./imagePrecheck', () => {
  // Runs on import, not on call: this is the "the heavy chunk was fetched" flag.
  state.precheckModuleEvaluated = true;
  return {
    checkImageFile: async (_file: File, threshold: number) => {
      state.thresholdSeen = threshold;
      if (state.precheckThrows) throw new Error('chunk unavailable');
      return state.verdict;
    },
  };
});

vi.mock('./suspiciousImageDialog', () => ({
  confirmSuspiciousImage: async () => {
    state.confirmCalls += 1;
    return state.confirmAnswer;
  },
}));

/** Fresh module registry per call so `precheckModuleEvaluated` is meaningful. */
async function check(file: File) {
  vi.resetModules();
  state.precheckModuleEvaluated = false;
  const { checkImageBeforeUpload } = await import('./checkImageBeforeUpload');
  return checkImageBeforeUpload(file);
}

function file(type: string, name = 'file') {
  return new File([new Uint8Array([1, 2, 3])], name, { type });
}

beforeEach(() => {
  state.imageFilterEnabled = true;
  state.imageFilterThreshold = 0.8;
  state.verdict = 'ok';
  state.precheckThrows = false;
  state.confirmCalls = 0;
  state.confirmAnswer = true;
  state.thresholdSeen = undefined;
});

describe('checkImageBeforeUpload', () => {
  it('passes without loading the classifier when the instance disables the filter', async () => {
    state.imageFilterEnabled = false;
    // would be flagged if it ever got that far
    state.verdict = 'suspicious';

    await expect(check(file('image/png', 'photo.png'))).resolves.toBe(true);
    expect(state.precheckModuleEvaluated).toBe(false);
    expect(state.confirmCalls).toBe(0);
  });

  it('passes non-image files without loading the classifier', async () => {
    state.verdict = 'suspicious';

    await expect(check(file('application/pdf', 'notes.pdf'))).resolves.toBe(true);
    expect(state.precheckModuleEvaluated).toBe(false);
  });

  it.each(['image/svg+xml', 'image/svg'])(
    'passes %s without loading the classifier (canvas-tainting, rasterised server-side)',
    async (type) => {
      state.verdict = 'suspicious';

      await expect(check(file(type, 'drawing.svg'))).resolves.toBe(true);
      expect(state.precheckModuleEvaluated).toBe(false);
    },
  );

  it('loads the classifier for a raster image and passes a clean verdict without asking', async () => {
    await expect(check(file('image/jpeg', 'photo.jpg'))).resolves.toBe(true);
    expect(state.precheckModuleEvaluated).toBe(true);
    expect(state.confirmCalls).toBe(0);
  });

  it('hands the classifier this instance\'s server-side threshold', async () => {
    // the point of shipping it: an operator who tightens
    // IMAGE_MODERATION_THRESHOLD gets an earlier browser warning too, rather
    // than a client that keeps warning at a hardcoded value the server left
    // behind
    state.imageFilterThreshold = 0.5;

    await check(file('image/jpeg', 'photo.jpg'));

    expect(state.thresholdSeen).toBe(0.5);
  });

  it('passes when the classifier itself blows up — it may never cost a user an upload', async () => {
    state.precheckThrows = true;

    await expect(check(file('image/png', 'photo.png'))).resolves.toBe(true);
    expect(state.confirmCalls).toBe(0);
  });

  it('routes a suspicious verdict through the confirmation dialog and follows its answer', async () => {
    state.verdict = 'suspicious';
    state.confirmAnswer = true;

    await expect(check(file('image/jpeg', 'photo.jpg'))).resolves.toBe(true);
    expect(state.confirmCalls).toBe(1);

    state.confirmAnswer = false;
    state.confirmCalls = 0;

    await expect(check(file('image/jpeg', 'photo.jpg'))).resolves.toBe(false);
    expect(state.confirmCalls).toBe(1);
  });
});
