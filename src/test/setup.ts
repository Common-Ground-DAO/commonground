// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { afterEach } from 'vitest';
import { runTeardowns } from './cleanup';

/**
 * Vitest setup file (see `vitest.config.ts`). Only drains the teardown
 * registry of the `src/test/` helpers after each test; it imports nothing
 * heavy, so test files that use no helper pay nothing for it.
 */
afterEach(async () => {
  await runTeardowns();
});
