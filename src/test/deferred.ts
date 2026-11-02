// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Small async helpers for ordering tests: a promise the test resolves by hand,
 * and a way to let pending promise callbacks run. Both work with and without
 * `vi.useFakeTimers()` (neither uses a timer).
 */

export interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
  /** True once `resolve` or `reject` was called. */
  readonly settled: boolean;
}

export function deferred<T = void>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  let settled = false;
  const promise = new Promise<T>((res, rej) => {
    resolve = (value) => {
      settled = true;
      res(value);
    };
    reject = (reason) => {
      settled = true;
      rej(reason);
    };
  });
  return {
    promise,
    resolve,
    reject,
    get settled() {
      return settled;
    },
  };
}

/**
 * Lets queued promise callbacks (and whatever they chain) run. `rounds` is the
 * number of microtask turns to yield; the default covers the usual
 * `await a(); await b();` depth of the code under test.
 */
export async function flushMicrotasks(rounds = 20): Promise<void> {
  for (let i = 0; i < rounds; i++) {
    await Promise.resolve();
  }
}
