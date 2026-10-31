// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Typing-indicator lookups: channel permissions are cached per community and
 * channel, and the channel of an access object is checked against its scope.
 */

const getCommunityChannelRolePermissions = jest.fn();
const isChannelInAccessScope = jest.fn();

jest.mock('../util/postgres', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/communities', () => ({
  __esModule: true,
  default: { getCommunityChannelRolePermissions: (...args: any[]) => getCommunityChannelRolePermissions(...args) },
}));
jest.mock('../repositories/chats', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/messages', () => ({
  __esModule: true,
  default: { isChannelInAccessScope: (...args: any[]) => isChannelInAccessScope(...args) },
}));

import * as typingCache from '../repositories/typingCache';

const COMMUNITY_A = '00000000-0000-4000-8000-0000000000c1';
const COMMUNITY_B = '00000000-0000-4000-8000-0000000000c2';
const CHANNEL = '00000000-0000-4000-8000-0000000000a1';
const CHAT = '00000000-0000-4000-8000-0000000000b1';

beforeEach(() => {
  jest.clearAllMocks();
  typingCache.invalidateAllChannels();
});

describe('getChannelTypingPerms', () => {
  it('caches per community and channel', async () => {
    getCommunityChannelRolePermissions.mockImplementation(async (communityId: string) =>
      communityId === COMMUNITY_A
        ? [{ roleId: 'r1', roleTitle: 'Member', permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ', 'CHANNEL_WRITE'] }]
        : []);

    const forB = await typingCache.getChannelTypingPerms(COMMUNITY_B, CHANNEL);
    const forA = await typingCache.getChannelTypingPerms(COMMUNITY_A, CHANNEL);
    expect(forB.writerRoleIds).toEqual([]);
    expect(forA.writerRoleIds).toEqual(['r1']);
    expect(getCommunityChannelRolePermissions).toHaveBeenCalledTimes(2);

    await typingCache.getChannelTypingPerms(COMMUNITY_A, CHANNEL);
    expect(getCommunityChannelRolePermissions).toHaveBeenCalledTimes(2);
  });

  it('drops every community\'s entry for an invalidated channel', async () => {
    getCommunityChannelRolePermissions.mockResolvedValue([]);
    await typingCache.getChannelTypingPerms(COMMUNITY_A, CHANNEL);
    await typingCache.getChannelTypingPerms(COMMUNITY_B, CHANNEL);
    typingCache.invalidateChannel(CHANNEL);
    await typingCache.getChannelTypingPerms(COMMUNITY_A, CHANNEL);
    await typingCache.getChannelTypingPerms(COMMUNITY_B, CHANNEL);
    expect(getCommunityChannelRolePermissions).toHaveBeenCalledTimes(4);
  });
});

describe('isChannelInAccessScope', () => {
  it('checks the channel against the named scope and caches the answer', async () => {
    isChannelInAccessScope.mockResolvedValue(false);
    const access = { chatId: CHAT, channelId: CHANNEL };
    await expect(typingCache.isChannelInAccessScope(access as any)).resolves.toBe(false);
    await expect(typingCache.isChannelInAccessScope(access as any)).resolves.toBe(false);
    expect(isChannelInAccessScope).toHaveBeenCalledTimes(1);
    expect(isChannelInAccessScope).toHaveBeenCalledWith(access);
  });

  it('keeps answers for different scopes apart', async () => {
    isChannelInAccessScope.mockImplementation(async (access: any) => access.communityId === COMMUNITY_A);
    await expect(typingCache.isChannelInAccessScope({ communityId: COMMUNITY_B, channelId: CHANNEL } as any)).resolves.toBe(false);
    await expect(typingCache.isChannelInAccessScope({ communityId: COMMUNITY_A, channelId: CHANNEL } as any)).resolves.toBe(true);
  });

  it('has no answer for calls', async () => {
    await expect(typingCache.isChannelInAccessScope({ callId: CHAT, channelId: CHANNEL } as any)).resolves.toBe(false);
    expect(isChannelInAccessScope).not.toHaveBeenCalled();
  });
});
