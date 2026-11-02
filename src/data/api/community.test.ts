// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Community calls the join and channel views make on every visit must not
 * surface as errors: a failed role-claimability check means "nothing
 * claimable".
 */

// `data/util/urls` reads `window.location.href` at module scope, and the test
// environment is `node`.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = { location: { href: '' } };
});

import communityApi from './community';

// `ajax` is protected; the tests replace it to script the server's answer
const ajax = () => vi.spyOn(communityApi as unknown as { ajax: (...args: unknown[]) => Promise<unknown> }, 'ajax');

afterEach(() => vi.restoreAllMocks());

describe('communityApi.checkCommunityRoleClaimability', () => {
  it('passes the server answer through', async () => {
    ajax().mockResolvedValueOnce([{ roleId: 'r', claimable: true }]);
    await expect(communityApi.checkCommunityRoleClaimability({ communityId: 'c' })).resolves.toEqual([{ roleId: 'r', claimable: true }]);
  });

  it('treats a failed check as nothing claimable', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    ajax().mockRejectedValueOnce(new Error('SERVICE_UNAVAILABLE'));
    await expect(communityApi.checkCommunityRoleClaimability({ communityId: 'c' })).resolves.toEqual([]);
  });
});
