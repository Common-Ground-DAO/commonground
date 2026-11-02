// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { vi } from 'vitest';
import { registerTeardown } from './cleanup';

/**
 * Timers `useDataLayerFakeTimers()` fakes. Deliberately not `setImmediate`:
 * fake-indexeddb schedules every IndexedDB task with
 * `globalThis.setImmediate`, so faking it (what a plain `vi.useFakeTimers()`
 * does) leaves every Dexie operation hanging. `queueMicrotask` and
 * `nextTick` stay real as in vitest's default.
 */
export const DATA_LAYER_FAKED_TIMERS = ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] as const;

type FakeTimerConfig = NonNullable<Parameters<typeof vi.useFakeTimers>[0]>;

/**
 * `vi.useFakeTimers()` that keeps fake-indexeddb (and so Dexie) working.
 * Real timers are restored after the test.
 *
 * Exception: Dexie's `liveQuery` runs its first query via `setTimeout(…, 0)`,
 * so a subscription emits nothing until fake time moves — call
 * `await flushLiveQueries()`. Updates driven by later commits need no timer.
 */
export function useDataLayerFakeTimers(config: Omit<FakeTimerConfig, 'toFake'> = {}): void {
  vi.useFakeTimers({ ...config, toFake: [...DATA_LAYER_FAKED_TIMERS] });
  registerTeardown(() => {
    vi.useRealTimers();
  });
}

// captured at load, before a test can fake it
const realSetImmediate = globalThis.setImmediate;

/**
 * Lets pending liveQuery work finish: advances fake time by 0 (when fake
 * timers are on), which starts queued first queries, then yields a few real
 * `setImmediate` turns so fake-indexeddb answers them. Repeats `rounds` times.
 */
export async function flushLiveQueries(rounds = 3): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    if (vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(0);
    for (let j = 0; j < 5; j++) await new Promise<void>(resolve => realSetImmediate(() => resolve()));
  }
}
