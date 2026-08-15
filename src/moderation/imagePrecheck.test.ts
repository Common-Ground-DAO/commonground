// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PredictionType } from 'nsfwjs/core';

/**
 * The module that actually decides a client-side verdict.
 *
 * tfjs, the WebGL backend and nsfwjs are mocked away — none of them would run
 * in a node environment, and what needs pinning is this module's own contract,
 * not MobileNetV2's accuracy:
 *
 * - the score is **summed** over the flagged classes against the instance's
 *   threshold, the same aggregation `nsfwScore()` uses server-side. A client
 *   that kept its own hardcoded rule is exactly the divergence this replaced.
 * - a failed model load is **retried** on the next file rather than remembered
 *   forever. The old promise cache turned one flaky fetch into a silently
 *   disabled pre-check for the rest of the page's life.
 * - every failure resolves `'ok'`. This is a courtesy warning in front of the
 *   authoritative server gate; it may never cost a user their upload.
 *
 * The DOM pieces `decodeToCanvas` needs are stubbed rather than pulled in via
 * jsdom (not a dependency, and this is the whole of the surface used).
 */

const state = vi.hoisted(() => ({
  /** predictions the mocked model answers with */
  predictions: [] as PredictionType[],
  /** number of `load()` calls — the observable proof of a retry */
  loadCalls: 0,
  /** how many of the next loads should fail */
  failLoads: 0,
  /** classify() throws instead of answering */
  classifyThrows: false,
  /** the image decodes to 0x0, i.e. an undecodable file */
  decodeFails: false,
  backend: 'webgl' as string,
}));

vi.mock('@tensorflow/tfjs-core', () => ({
  enableProdMode: () => undefined,
  setBackend: async (name: string) => {
    state.backend = name;
    return true;
  },
  ready: async () => undefined,
  getBackend: () => state.backend,
}));
vi.mock('@tensorflow/tfjs-backend-webgl', () => ({}));
vi.mock('@tensorflow/tfjs-backend-cpu', () => ({}));

vi.mock('nsfwjs/core', () => ({
  load: async () => {
    state.loadCalls += 1;
    if (state.failLoads > 0) {
      state.failLoads -= 1;
      throw new Error('model fetch failed');
    }
    return {
      classify: async () => {
        if (state.classifyThrows) throw new Error('inference blew up');
        return state.predictions;
      },
    };
  },
}));

function prediction(className: string, probability: number): PredictionType {
  return { className, probability } as PredictionType;
}

let objectUrlBackup: { create: unknown; revoke: unknown } | undefined;

/** Minimal stand-ins for the four DOM APIs `decodeToCanvas` touches. */
function stubDom() {
  // patched onto the real URL rather than replacing it — vitest's own module
  // machinery needs `new URL(...)` to keep working
  const url = URL as unknown as Record<string, unknown>;
  objectUrlBackup = { create: url.createObjectURL, revoke: url.revokeObjectURL };
  url.createObjectURL = () => 'blob:stub';
  url.revokeObjectURL = () => undefined;
  vi.stubGlobal(
    'Image',
    class {
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      naturalWidth = 0;
      naturalHeight = 0;
      set src(_value: string) {
        // decoding is async in a real browser, and the module relies on that
        queueMicrotask(() => {
          if (state.decodeFails) {
            this.naturalWidth = 0;
            this.naturalHeight = 0;
          } else {
            this.naturalWidth = 800;
            this.naturalHeight = 600;
          }
          this.onload?.();
        });
      }
    },
  );
  vi.stubGlobal('document', {
    createElement: () => ({
      width: 0,
      height: 0,
      getContext: () => ({ drawImage: () => undefined }),
    }),
  });
}

/** Fresh module registry so `modelPromise` starts empty in every test. */
async function loadModule() {
  vi.resetModules();
  return import('./imagePrecheck');
}

function imageFile() {
  return new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' });
}

beforeEach(() => {
  state.predictions = [prediction('Neutral', 1)];
  state.loadCalls = 0;
  state.failLoads = 0;
  state.classifyThrows = false;
  state.decodeFails = false;
  state.backend = 'webgl';
  stubDom();
});

afterEach(() => {
  if (objectUrlBackup) {
    const url = URL as unknown as Record<string, unknown>;
    url.createObjectURL = objectUrlBackup.create;
    url.revokeObjectURL = objectUrlBackup.revoke;
    objectUrlBackup = undefined;
  }
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('isSuspicious', () => {
  it('sums the flagged classes instead of taking the single highest', async () => {
    const { isSuspicious } = await loadModule();
    const split = [prediction('Porn', 0.5), prediction('Hentai', 0.45), prediction('Neutral', 0.05)];

    // neither class clears 0.8 alone — together they do, which is the case the
    // old single-class rule missed and the server always caught
    expect(isSuspicious(split, 0.8)).toBe(true);
    expect(isSuspicious([prediction('Porn', 0.5)], 0.8)).toBe(false);
  });

  it('ignores the classes that are not flagged, however confident', async () => {
    const { isSuspicious } = await loadModule();
    const benign = [prediction('Sexy', 0.99), prediction('Drawing', 0.9), prediction('Neutral', 0.8)];

    expect(isSuspicious(benign, 0.5)).toBe(false);
  });

  it('follows the threshold it is given', async () => {
    const { isSuspicious } = await loadModule();
    const mild = [prediction('Porn', 0.6)];

    expect(isSuspicious(mild, 0.8)).toBe(false);
    expect(isSuspicious(mild, 0.5)).toBe(true);
  });

  it('treats the threshold as exclusive, like the server does', async () => {
    const { isSuspicious } = await loadModule();

    expect(isSuspicious([prediction('Porn', 0.8)], 0.8)).toBe(false);
    // a threshold of 1 must mean "never warn"
    expect(isSuspicious([prediction('Porn', 1)], 1)).toBe(false);
  });
});

describe('withTimeout', () => {
  it('passes a resolved value straight through', async () => {
    const { withTimeout } = await loadModule();

    await expect(withTimeout(Promise.resolve('value'), 'fallback')).resolves.toBe('value');
  });

  it('answers with the fallback when the promise rejects', async () => {
    const { withTimeout } = await loadModule();

    await expect(withTimeout(Promise.reject(new Error('nope')), 'fallback')).resolves.toBe(
      'fallback',
    );
  });

  it('answers with the fallback when the promise never settles', async () => {
    const { withTimeout } = await loadModule();
    vi.useFakeTimers();

    const pending = withTimeout(new Promise<string>(() => undefined), 'fallback');
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(pending).resolves.toBe('fallback');
  });
});

describe('checkImageFile', () => {
  it('flags a file whose summed score clears the instance threshold', async () => {
    const { checkImageFile } = await loadModule();
    state.predictions = [prediction('Porn', 0.9), prediction('Neutral', 0.1)];

    await expect(checkImageFile(imageFile(), 0.8)).resolves.toBe('suspicious');
  });

  it('passes a clean file', async () => {
    const { checkImageFile } = await loadModule();
    state.predictions = [prediction('Neutral', 0.97), prediction('Porn', 0.03)];

    await expect(checkImageFile(imageFile(), 0.8)).resolves.toBe('ok');
  });

  it('warns earlier when the instance lowered its threshold', async () => {
    const { checkImageFile } = await loadModule();
    state.predictions = [prediction('Porn', 0.6), prediction('Neutral', 0.4)];

    await expect(checkImageFile(imageFile(), 0.8)).resolves.toBe('ok');
    await expect(checkImageFile(imageFile(), 0.5)).resolves.toBe('suspicious');
  });

  it('retries the model load after a failure instead of staying broken all session', async () => {
    const { checkImageFile } = await loadModule();
    state.predictions = [prediction('Porn', 0.95)];
    state.failLoads = 1;

    // first file: the load fails, and the check fails open
    await expect(checkImageFile(imageFile(), 0.8)).resolves.toBe('ok');
    expect(state.loadCalls).toBe(1);

    // second file: loads again and this time really classifies
    await expect(checkImageFile(imageFile(), 0.8)).resolves.toBe('suspicious');
    expect(state.loadCalls).toBe(2);
  });

  it('loads the model once for a successful session', async () => {
    const { checkImageFile } = await loadModule();

    await Promise.all([
      checkImageFile(imageFile(), 0.8),
      checkImageFile(imageFile(), 0.8),
      checkImageFile(imageFile(), 0.8),
    ]);

    expect(state.loadCalls).toBe(1);
  });

  it('passes undecodable files without classifying them', async () => {
    const { checkImageFile } = await loadModule();
    state.decodeFails = true;
    state.predictions = [prediction('Porn', 0.99)];

    await expect(checkImageFile(imageFile(), 0.8)).resolves.toBe('ok');
    expect(state.loadCalls).toBe(0);
  });

  it('passes when inference itself throws', async () => {
    const { checkImageFile } = await loadModule();
    state.classifyThrows = true;

    await expect(checkImageFile(imageFile(), 0.8)).resolves.toBe('ok');
  });
});
