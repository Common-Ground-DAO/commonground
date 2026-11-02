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
 */
export function useDataLayerFakeTimers(config: Omit<FakeTimerConfig, 'toFake'> = {}): void {
  vi.useFakeTimers({ ...config, toFake: [...DATA_LAYER_FAKED_TIMERS] });
  registerTeardown(() => {
    vi.useRealTimers();
  });
}
