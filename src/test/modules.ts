// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { vi } from 'vitest';

/**
 * Loads a module graph afresh, as a new browser tab would: module singletons
 * (managers, databases, the websocket) get their own instance. Install the
 * globals they read (`installBrowserEnv`, `installFakeIdb`) first; node_modules
 * dependencies (Dexie, …) stay shared, as they are not re-evaluated.
 *
 *   const tabA = await importAsNewTab(() => import('data/databases/community'));
 *   const tabB = await importAsNewTab(() => import('data/databases/community'));
 *
 * The loader must be an inline `() => import('…')` so Vite resolves the path
 * relative to the test file.
 */
export async function importAsNewTab<T>(loader: () => Promise<T>): Promise<T> {
  vi.resetModules();
  return loader();
}
