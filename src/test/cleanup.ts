// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Registry of teardown callbacks for the test helpers in `src/test/`.
 *
 * Helpers that install globals (`installBrowserEnv`, `installFakeIdb`, …)
 * register their uninstall here; `src/test/setup.ts` drains the registry
 * after every test, so a test that forgets to clean up cannot leak stubs into
 * the next one. Kept dependency-free on purpose: the setup file imports it for
 * every test file, including the ones that never use a helper.
 */

type Teardown = () => void | Promise<void>;

const teardowns = new Set<Teardown>();

/** Registers `fn` to run after the current test; returns an unregister function. */
export function registerTeardown(fn: Teardown): () => void {
  teardowns.add(fn);
  return () => {
    teardowns.delete(fn);
  };
}

/** Runs and clears every registered teardown, newest first. */
export async function runTeardowns(): Promise<void> {
  const fns = [...teardowns].reverse();
  teardowns.clear();
  const errors: unknown[] = [];
  for (const fn of fns) {
    try {
      await fn();
    } catch (e) {
      errors.push(e);
    }
  }
  if (errors.length === 1) throw errors[0];
  if (errors.length > 1) throw new AggregateError(errors, 'test teardown failed');
}
