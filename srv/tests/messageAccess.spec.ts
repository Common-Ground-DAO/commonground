// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Message routes take an access object naming a community, chat, call or
 * article plus the channel the messages live in. Permissions are evaluated for
 * the former, queries run against the latter, so both have to agree; deletion
 * additionally derives creator and channel from the stored message.
 *
 * The route handlers are captured from `registerPostRoute` and called
 * directly, with every repository mocked.
 */

const handlers: Record<string, (request: any, response: any, data: any) => Promise<any>> = {};

const messageHelper = {
  getMessageOwnership: jest.fn(),
  isChannelInAccessScope: jest.fn(),
  deleteMessage: jest.fn(),
  loadMessages: jest.fn(),
};
const permissionHelper = {
  hasPermissions: jest.fn(),
  hasPermissionsOrThrow: jest.fn(),
};
const chatHelper = {
  isUserInChat: jest.fn(),
  getChatById: jest.fn(),
};

jest.mock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, _validator: unknown, handler: any) => {
    handlers[path] = handler;
  },
}));
jest.mock('../repositories/messages', () => ({ __esModule: true, default: messageHelper }));
jest.mock('../repositories/permissions', () => ({ __esModule: true, default: permissionHelper }));
jest.mock('../repositories/chats', () => ({ __esModule: true, default: chatHelper }));
jest.mock('../repositories/communities', () => ({
  __esModule: true,
  default: {
    getCommunityChannelRolePermissions: jest.fn().mockResolvedValue([]),
    getCallRolePermissions: jest.fn().mockResolvedValue([]),
  },
}));
jest.mock('../repositories/event', () => ({ __esModule: true, default: { emit: jest.fn() } }));
jest.mock('../repositories/notifications', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/files', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/articles', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/bots', () => ({ __esModule: true, default: {} }));
jest.mock('../util/botPrincipal', () => ({ allowBotRoute: jest.fn() }));
jest.mock('../util/botRateLimit', () => ({ enforceBotRateLimit: jest.fn() }));
jest.mock('../util/rateLimit', () => ({ __esModule: true, default: () => jest.fn() }));
jest.mock('../redis', () => ({ __esModule: true, default: { get: jest.fn(), getClient: jest.fn() } }));
jest.mock('open-graph-scraper', () => jest.fn());

import '../api/messages';
import { ChannelPermission } from '../common/enums';

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';
const CHANNEL = '00000000-0000-4000-8000-0000000000a1';
const FOREIGN_CHANNEL = '00000000-0000-4000-8000-0000000000a2';
const CHAT = '00000000-0000-4000-8000-0000000000b1';
const MESSAGE = '00000000-0000-4000-8000-0000000000d1';

const asUser = (id: string) => ({ session: { user: { id } } });

beforeEach(() => {
  jest.clearAllMocks();
  messageHelper.isChannelInAccessScope.mockResolvedValue(true);
  messageHelper.deleteMessage.mockResolvedValue({ deletedIds: [MESSAGE], deletedSyncSeqs: [1], updatedParentIdToNull: [], updatedParents: [], dbNow: '' });
  messageHelper.loadMessages.mockResolvedValue([]);
  permissionHelper.hasPermissions.mockResolvedValue(true);
  chatHelper.isUserInChat.mockResolvedValue(true);
  chatHelper.getChatById.mockResolvedValue({ userIds: [ME, OTHER] });
});

describe('/deleteMessage', () => {
  const deleteMessage = (userId: string, data: any) => handlers['/deleteMessage'](asUser(userId), {}, data);

  it('deletes an own message, scoped to the access channel', async () => {
    messageHelper.getMessageOwnership.mockResolvedValue({ creatorId: ME, channelId: CHANNEL });
    await deleteMessage(ME, {
      access: { communityId: COMMUNITY, channelId: CHANNEL },
      messageId: MESSAGE,
      creatorId: ME,
    });
    expect(permissionHelper.hasPermissions).toHaveBeenCalledWith(expect.objectContaining({
      communityId: COMMUNITY,
      channelId: CHANNEL,
      permissions: expect.not.arrayContaining([ChannelPermission.CHANNEL_MODERATE]),
    }));
    expect(messageHelper.deleteMessage).toHaveBeenCalledWith({
      messageId: MESSAGE,
      channelId: CHANNEL,
      creatorId: ME,
    });
  });

  it('refuses a message that lives in a different channel than the access object', async () => {
    messageHelper.getMessageOwnership.mockResolvedValue({ creatorId: OTHER, channelId: FOREIGN_CHANNEL });
    await expect(deleteMessage(ME, {
      access: { communityId: COMMUNITY, channelId: CHANNEL },
      messageId: MESSAGE,
      creatorId: OTHER,
    })).rejects.toThrow('NOT_FOUND');
    expect(messageHelper.deleteMessage).not.toHaveBeenCalled();
  });

  it('requires moderation rights when the stored creator is another user', async () => {
    messageHelper.getMessageOwnership.mockResolvedValue({ creatorId: OTHER, channelId: CHANNEL });
    permissionHelper.hasPermissions.mockImplementation(async ({ permissions }: { permissions: string[] }) =>
      !permissions.includes(ChannelPermission.CHANNEL_MODERATE));
    await expect(deleteMessage(ME, {
      access: { communityId: COMMUNITY, channelId: CHANNEL },
      messageId: MESSAGE,
      creatorId: ME,
    })).rejects.toThrow('NOT_ALLOWED');
    expect(messageHelper.deleteMessage).not.toHaveBeenCalled();
  });

  it('lets a moderator delete another user\'s message in the moderated channel', async () => {
    messageHelper.getMessageOwnership.mockResolvedValue({ creatorId: OTHER, channelId: CHANNEL });
    await deleteMessage(ME, {
      access: { communityId: COMMUNITY, channelId: CHANNEL },
      messageId: MESSAGE,
      creatorId: OTHER,
    });
    expect(permissionHelper.hasPermissions).toHaveBeenCalledWith(expect.objectContaining({
      permissions: expect.arrayContaining([ChannelPermission.CHANNEL_MODERATE]),
    }));
    expect(messageHelper.deleteMessage).toHaveBeenCalledWith({
      messageId: MESSAGE,
      channelId: CHANNEL,
      creatorId: OTHER,
    });
  });

  it('refuses when the channel does not belong to the named call/chat/community', async () => {
    messageHelper.getMessageOwnership.mockResolvedValue({ creatorId: OTHER, channelId: FOREIGN_CHANNEL });
    messageHelper.isChannelInAccessScope.mockResolvedValue(false);
    await expect(deleteMessage(ME, {
      access: { callId: COMMUNITY, channelId: FOREIGN_CHANNEL },
      messageId: MESSAGE,
      creatorId: OTHER,
    })).rejects.toThrow('NOT_ALLOWED');
    expect(messageHelper.deleteMessage).not.toHaveBeenCalled();
  });

  it('refuses an already deleted or unknown message', async () => {
    messageHelper.getMessageOwnership.mockResolvedValue(undefined);
    await expect(deleteMessage(ME, {
      access: { chatId: CHAT, channelId: CHANNEL },
      messageId: MESSAGE,
      creatorId: ME,
    })).rejects.toThrow('NOT_FOUND');
    expect(messageHelper.deleteMessage).not.toHaveBeenCalled();
  });
});

describe('message reads', () => {
  it('do not load a channel that is not the chat\'s channel', async () => {
    messageHelper.isChannelInAccessScope.mockResolvedValue(false);
    await expect(handlers['/loadMessages'](asUser(ME), {}, {
      access: { chatId: CHAT, channelId: FOREIGN_CHANNEL },
    })).rejects.toThrow('NOT_ALLOWED');
    expect(messageHelper.loadMessages).not.toHaveBeenCalled();
  });

  it('do not load a channel that is not the article\'s channel, for anonymous readers', async () => {
    messageHelper.isChannelInAccessScope.mockResolvedValue(false);
    await expect(handlers['/loadMessages']({ session: {} }, {}, {
      access: { articleId: MESSAGE, articleUserId: OTHER, channelId: FOREIGN_CHANNEL },
    })).rejects.toThrow('NOT_ALLOWED');
    expect(messageHelper.loadMessages).not.toHaveBeenCalled();
  });

  it('load the chat channel for a chat member', async () => {
    await handlers['/loadMessages'](asUser(ME), {}, {
      access: { chatId: CHAT, channelId: CHANNEL },
    });
    expect(messageHelper.isChannelInAccessScope).toHaveBeenCalledWith({ chatId: CHAT, channelId: CHANNEL }, ME);
    expect(messageHelper.loadMessages).toHaveBeenCalled();
  });
});
