// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { afterEach, describe, expect, it, vi } from 'vitest';

/**
 * Community calls the join and channel views make on every visit must not
 * surface as errors: a failed role-claimability check means "nothing
 * claimable", and a member list reply without a list is an empty list.
 */

// `data/util/urls` reads `window.location.href` at module scope, and the test
// environment is `node`.
vi.hoisted(() => {
  (globalThis as Record<string, unknown>).window = { location: { href: '' } };
});

import communityApi from './community';
import { emptyChannelMemberList, emptyMemberList } from 'common/memberLists';

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

describe('communityApi.getChannelMemberList', () => {
  const request = { communityId: 'c', channelId: 'ch', offset: 0, limit: 10 };

  it('turns a reply without a list into an empty list', async () => {
    for (const reply of [undefined, null, '']) {
      ajax().mockResolvedValueOnce(reply);
      await expect(communityApi.getChannelMemberList(request)).resolves.toEqual(emptyChannelMemberList());
    }
  });

  it('passes a list through and still rejects a failed request', async () => {
    const list = { ...emptyChannelMemberList(), count: 1 };
    ajax().mockResolvedValueOnce(list);
    await expect(communityApi.getChannelMemberList(request)).resolves.toBe(list);
    ajax().mockRejectedValueOnce(new Error('UNKNOWN'));
    await expect(communityApi.getChannelMemberList(request)).rejects.toThrow('UNKNOWN');
  });
});

describe('communityApi.getMemberList', () => {
  const request = { communityId: 'c', offset: 0, limit: 10 };

  it('turns a reply without a list into an empty list', async () => {
    for (const reply of [undefined, null, '']) {
      ajax().mockResolvedValueOnce(reply);
      await expect(communityApi.getMemberList(request)).resolves.toEqual(emptyMemberList());
    }
  });

  it('passes a list through and still rejects a failed request', async () => {
    const list = { ...emptyMemberList(), totalCount: 1 };
    ajax().mockResolvedValueOnce(list);
    await expect(communityApi.getMemberList(request)).resolves.toBe(list);
    ajax().mockRejectedValueOnce(new Error('UNKNOWN'));
    await expect(communityApi.getMemberList(request)).rejects.toThrow('UNKNOWN');
  });
});
