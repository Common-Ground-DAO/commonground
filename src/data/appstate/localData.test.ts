// SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md
import { describe, expect, it } from 'vitest';
import { vi } from 'vitest';
import { importAsNewTab } from 'test/modules';
import { useDataLayerFakeTimers } from 'test/timers';
import { deferred, flushMicrotasks } from 'test/deferred';

describe('local persistence coordination', () => {
  it('tracks every concurrent writer, even after the UI deadline', async () => {
    useDataLayerFakeTimers();
    const { default: data, LOCAL_DATA_TIMEOUT_MS } = await importAsNewTab(() => import('./localData'));
    const a = deferred<void>(), b = deferred<void>();
    const outcome = Promise.allSettled([data.run(() => a.promise), data.run(() => b.promise)]);
    let idle = false;
    const idleWait = data.whenIdle().then(() => { idle = true; });
    a.resolve();
    await flushMicrotasks();
    expect(idle).toBe(false);
    await vi.advanceTimersByTimeAsync(LOCAL_DATA_TIMEOUT_MS);
    expect((await outcome).map(x => x.status)).toEqual(['fulfilled', 'rejected']);
    expect(idle).toBe(false);
    const writer = vi.fn(async () => {});
    await expect(data.run(writer)).rejects.toThrow('Local data');
    expect(writer).not.toHaveBeenCalled();
    b.resolve();
    await idleWait;
    expect(idle).toBe(true);
    expect(data.error).not.toBeNull();
  });

  it('releases completed work without a later spurious timeout', async () => {
    useDataLayerFakeTimers();
    const { default: data, LOCAL_DATA_TIMEOUT_MS } = await importAsNewTab(() => import('./localData'));
    const listener = vi.fn();
    const unsubscribe = data.subscribe(listener);
    expect(await data.run(async () => 42)).toBe(42);
    await data.whenIdle();
    await vi.advanceTimersByTimeAsync(LOCAL_DATA_TIMEOUT_MS * 2);
    expect(data.error).toBeNull();
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });
});
