// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { defineConfig } from 'vitest/config';
import { baseUrlResolve } from './vite/baseUrlResolve';

/**
 * Minimal Vitest setup — the successor to the single CRA boilerplate test that
 * was deleted in Phase 1, and a place for a test culture to start.
 *
 * Deliberately a standalone config rather than a `test` block inside
 * `vite.config.ts`: the app config carries the React, SVGR, node-polyfill,
 * HTML-entry and service-worker plugins, none of which a unit test needs, and
 * loading them would make every run pay for the full build plumbing.
 *
 * What it *does* reuse is `baseUrlResolve` — the plugin that reimplements
 * `tsconfig`'s `baseUrl: "src"` for the ~1945 bare import lines in `src/`. It
 * is the single largest piece of migration-specific machinery in the repo, so
 * tests import through it rather than around it.
 *
 * `environment: 'node'` on purpose: nothing here needs a DOM, and jsdom would
 * add seconds of startup to every run. Adding a jsdom project later is a
 * two-line change.
 */
export default defineConfig({
  plugins: [baseUrlResolve('src')],
  test: {
    environment: 'node',
    include: ['src/**/*.test.{ts,tsx}'],
  },
});
