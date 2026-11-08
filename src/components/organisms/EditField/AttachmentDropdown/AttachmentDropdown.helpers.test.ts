// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Regression tests for `addFiles`.
 *
 * The load-bearing detail: React executes setState *updaters* at render time,
 * not when setState is called. The fake `setAttachments` below therefore
 * queues updaters and applies them on a macrotask — the exact timing that
 * once revealed a bug where `addFiles` read the kept-set synchronously,
 * always saw an empty list, and left every attachment in `precheckPending`
 * forever (frozen "Uploading…", no upload request, no dialog).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { InMemoryAttachment } from '../useAttachments/useAttachments';

const checkImageBeforeUpload = vi.fn(async (_file: File) => true);
vi.mock('moderation/checkImageBeforeUpload', () => ({
  checkImageBeforeUpload: (file: File) => checkImageBeforeUpload(file),
}));

import { addFiles } from './AttachmentDropdown.helpers';

function makeFile(name: string): File {
  return new File(['x'], name, { type: 'image/png' });
}

/** React-like state harness: updaters run deferred, like at render time. */
function makeDeferredState() {
  let state: InMemoryAttachment[] = [];
  const pending: Array<(prev: InMemoryAttachment[]) => InMemoryAttachment[]> = [];
  const setState = (updater: any) => {
    pending.push(typeof updater === 'function' ? updater : () => updater);
    setTimeout(() => {
      while (pending.length) state = pending.shift()!(state);
    }, 0);
  };
  return { get: () => state, setState };
}

describe('addFiles', () => {
  beforeEach(() => {
    checkImageBeforeUpload.mockClear();
    checkImageBeforeUpload.mockResolvedValue(true);
  });

  it('clears precheckPending even though updaters run deferred (the frozen-spinner regression)', async () => {
    const { get, setState } = makeDeferredState();
    const files = [makeFile('a.png'), makeFile('b.png')];

    await addFiles(setState, () => {}, files, 10);
    await new Promise((r) => setTimeout(r, 0));

    expect(checkImageBeforeUpload).toHaveBeenCalledTimes(2);
    expect(get()).toHaveLength(2);
    expect(get().every((att) => att.precheckPending === false)).toBe(true);
  });

  it('drops declined files from the list', async () => {
    const { get, setState } = makeDeferredState();
    const [a, b] = [makeFile('a.png'), makeFile('b.png')];
    checkImageBeforeUpload.mockImplementation(async (file: File) => file !== a);

    await addFiles(setState, () => {}, [a, b], 10);
    await new Promise((r) => setTimeout(r, 0));

    expect(get()).toHaveLength(1);
    expect(get()[0].tentativeFile).toBe(b);
    expect(get()[0].precheckPending).toBe(false);
  });

  it('does not pre-check files clipped by the attachment limit', async () => {
    const { get, setState } = makeDeferredState();
    const files = Array.from({ length: 5 }, (_, i) => makeFile(`f${i}.png`));
    const setError = vi.fn();

    await addFiles(setState, setError, files, 3);
    await new Promise((r) => setTimeout(r, 0));

    expect(setError).toHaveBeenCalled();
    expect(get()).toHaveLength(3);
    expect(checkImageBeforeUpload).toHaveBeenCalledTimes(3);
    expect(get().every((att) => att.precheckPending === false)).toBe(true);
  });
});
