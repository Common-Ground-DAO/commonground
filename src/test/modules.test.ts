// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import { importAsNewTab } from './modules';
import * as staticDeferred from 'test/deferred';

describe('importAsNewTab', () => {
  it('gives every call its own module instance', async () => {
    const tabA = await importAsNewTab(() => import('./deferred'));
    const tabB = await importAsNewTab(() => import('./deferred'));
    expect(tabA.deferred).not.toBe(tabB.deferred);
    expect(tabA.deferred).not.toBe(staticDeferred.deferred);
  });
});
