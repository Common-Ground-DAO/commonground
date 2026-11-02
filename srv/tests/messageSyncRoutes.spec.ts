// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * chat-sync behaviour of the message routes, with the handlers captured from
 * `registerPostRoute` and every repository mocked: `getChanges` (access,
 * validation), the idempotent `createMessage` (a retry emits nothing),
 * `setChannelLastRead` (access, response, event) and `syncSeq` in events.
 */

const handlers: Record<string, (request: any, response: any, data: any) => Promise<any>> = {};
const validatorsByPath: Record<string, any> = {};

const messageHelper = {
  isChannelInAccessScope: jest.fn(),
  getChanges: jest.fn(),
  createMessage: jest.fn(),
  getOwnStoredMessage: jest.fn(),
  loadMessagesById: jest.fn(),
  getChannelMessageNotifyData: jest.fn(),
  setChannelLastRead: jest.fn(),
  editMessage: jest.fn(),
  getMessageOwnership: jest.fn(),
  deleteMessage: jest.fn(),
  deleteAllUserMessages: jest.fn(),
  setReaction: jest.fn(),
};
const permissionHelper = {
  hasPermissions: jest.fn(),
  hasPermissionsOrThrow: jest.fn(),
  hasTrustOrThrow: jest.fn(),
};
const chatHelper = {
  isUserInChat: jest.fn(),
  getChatById: jest.fn(),
  getChatByChannelId: jest.fn(),
};
const communityHelper = {
  getCommunityChannelRolePermissions: jest.fn(),
  getCallRolePermissions: jest.fn(),
  getUserBlockState: jest.fn(),
  areUsersCommunityMembers: jest.fn(),
};
const eventHelper = {
  emit: jest.fn(),
  sendWsOrWebPushNotificationEvent: jest.fn(),
};
const notificationHelper = {
  createNotifications: jest.fn(),
};
const allowBotRoute = jest.fn();

jest.mock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, validator: unknown, handler: any) => {
    handlers[path] = handler;
    validatorsByPath[path] = validator;
  },
}));
jest.mock('../repositories/messages', () => ({ __esModule: true, default: messageHelper }));
jest.mock('../repositories/permissions', () => ({ __esModule: true, default: permissionHelper }));
jest.mock('../repositories/chats', () => ({ __esModule: true, default: chatHelper }));
jest.mock('../repositories/communities', () => ({ __esModule: true, default: communityHelper }));
jest.mock('../repositories/event', () => ({ __esModule: true, default: eventHelper }));
jest.mock('../repositories/notifications', () => ({ __esModule: true, default: notificationHelper }));
jest.mock('../repositories/files', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/articles', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/bots', () => ({ __esModule: true, default: {} }));
jest.mock('../util/botPrincipal', () => ({ allowBotRoute: (...args: any[]) => allowBotRoute(...args) }));
jest.mock('../util/botRateLimit', () => ({ enforceBotRateLimit: jest.fn() }));
jest.mock('../util/rateLimit', () => ({ __esModule: true, default: () => jest.fn() }));
jest.mock('../redis', () => ({ __esModule: true, default: { get: jest.fn(), getClient: jest.fn() } }));
jest.mock('open-graph-scraper', () => jest.fn());

import '../api/messages';
import { deleteResultEvents } from '../api/messages';
import { ChannelPermission } from '../common/enums';

// recorded while api/messages loaded (beforeEach clears the mocks)
const botRoutes: string[] = allowBotRoute.mock.calls.map(call => call[1]);

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';
const CHANNEL = '00000000-0000-4000-8000-0000000000a1';
const CHAT = '00000000-0000-4000-8000-0000000000b1';
const MESSAGE = '00000000-0000-4000-8000-0000000000d1';
const PARENT = '00000000-0000-4000-8000-0000000000d2';

const communityAccess = { communityId: COMMUNITY, channelId: CHANNEL };
const asUser = (id: string) => ({ session: { user: { id, deviceId: 'device-1' } } });
const anonymous = { session: {} };

const storedMessage = {
  id: MESSAGE,
  creatorId: ME,
  channelId: CHANNEL,
  body: { version: '1', content: [{ type: 'mention', userId: OTHER, alias: 'other' }] },
  attachments: [],
  createdAt: '2026-11-02T12:00:00.000Z',
  updatedAt: '2026-11-02T12:00:00.000Z',
  editedAt: null,
  parentMessageId: null,
  reactions: {},
  ownReaction: null,
  syncSeq: 17,
};

beforeEach(() => {
  jest.clearAllMocks();
  messageHelper.isChannelInAccessScope.mockResolvedValue(true);
  messageHelper.getChannelMessageNotifyData.mockResolvedValue([]);
  permissionHelper.hasPermissions.mockResolvedValue(true);
  chatHelper.isUserInChat.mockResolvedValue(true);
  chatHelper.getChatById.mockResolvedValue({ userIds: [ME, OTHER] });
  communityHelper.getCommunityChannelRolePermissions.mockResolvedValue([
    { roleId: 'r1', roleTitle: 'Member', permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ'] },
  ]);
  communityHelper.getUserBlockState.mockResolvedValue(null);
  communityHelper.areUsersCommunityMembers.mockResolvedValue([{ userId: OTHER, isInCommunity: true }]);
  notificationHelper.createNotifications.mockResolvedValue([{ id: 'n1', createdAt: '', updatedAt: '' }]);
});

describe('/getChanges', () => {
  const getChanges = (request: any, data: any) => handlers['/getChanges'](request, {}, data);
  const validate = (data: unknown) => validatorsByPath['/getChanges'].validate(data);

  it('is not available to bots', () => {
    expect(botRoutes).toContain('/BotV1/messages/loadMessages');
    expect(botRoutes.some(route => route.includes('getChanges'))).toBe(false);
  });

  it('checks read access like loadMessages and passes the user', async () => {
    const answer = { reset: true };
    messageHelper.getChanges.mockResolvedValue(answer);
    await expect(getChanges(asUser(ME), { access: communityAccess, cursor: null })).resolves.toBe(answer);
    expect(permissionHelper.hasPermissions).toHaveBeenCalledWith(expect.objectContaining({
      userId: ME,
      communityId: COMMUNITY,
      channelId: CHANNEL,
      permissions: [ChannelPermission.CHANNEL_EXISTS, ChannelPermission.CHANNEL_READ],
    }));
    expect(messageHelper.getChanges).toHaveBeenCalledWith(ME, { access: communityAccess, cursor: null });
  });

  it('refuses a channel the user cannot read', async () => {
    permissionHelper.hasPermissions.mockResolvedValue(false);
    await expect(getChanges(asUser(ME), { access: communityAccess, cursor: '1:3' })).rejects.toThrow('NOT_ALLOWED');
    expect(messageHelper.getChanges).not.toHaveBeenCalled();
  });

  it('refuses a channel outside the access scope', async () => {
    messageHelper.isChannelInAccessScope.mockResolvedValue(false);
    await expect(getChanges(asUser(ME), { access: communityAccess, cursor: '1:3' })).rejects.toThrow('NOT_ALLOWED');
  });

  it('serves public channels to visitors without a session user, like loadMessages', async () => {
    messageHelper.getChanges.mockResolvedValue({});
    await getChanges(anonymous, { access: communityAccess, cursor: null });
    expect(messageHelper.getChanges).toHaveBeenCalledWith(undefined, expect.anything());
  });

  it('refuses a DM without a session user', async () => {
    await expect(getChanges(anonymous, { access: { chatId: CHAT, channelId: CHANNEL }, cursor: null }))
      .rejects.toThrow('LOGIN_REQUIRED');
  });

  it('validates the request', () => {
    expect(validate({ access: communityAccess, cursor: null }).error).toBeUndefined();
    expect(validate({ access: communityAccess, cursor: '1:42', limit: 200 }).error).toBeUndefined();
    // an unknown cursor format is answered with a reset, not rejected
    expect(validate({ access: communityAccess, cursor: '2:abc' }).error).toBeUndefined();
    expect(validate({ access: communityAccess }).error).toBeDefined();
    expect(validate({ access: communityAccess, cursor: 'x'.repeat(65) }).error).toBeDefined();
    expect(validate({ access: communityAccess, cursor: null, limit: 0 }).error).toBeDefined();
    expect(validate({ access: communityAccess, cursor: null, limit: 201 }).error).toBeDefined();
    expect(validate({ access: communityAccess, cursor: null, limit: '5' }).error).toBeDefined();
    expect(validate({ access: communityAccess, cursor: null, extra: 1 }).error).toBeDefined();
  });
});

describe('/createMessage idempotency', () => {
  const createMessage = (data: any) => handlers['/createMessage'](asUser(ME), {}, data);
  const request = {
    id: MESSAGE,
    access: communityAccess,
    body: storedMessage.body,
    parentMessageId: null,
    attachments: [],
  };

  it('a first create emits the message (with syncSeq) and the notifications', async () => {
    messageHelper.createMessage.mockResolvedValue({ message: storedMessage, userAlias: 'me', created: true });
    await expect(createMessage(request)).resolves.toBe(storedMessage);
    expect(eventHelper.emit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'new', data: expect.objectContaining({ id: MESSAGE, syncSeq: 17 }) }),
      expect.anything(),
      expect.anything(),
    );
    expect(eventHelper.sendWsOrWebPushNotificationEvent).toHaveBeenCalled();
  });

  it('a retry returns the stored message without events or notifications', async () => {
    messageHelper.createMessage.mockResolvedValue({ message: storedMessage, userAlias: '', created: false });
    await expect(createMessage(request)).resolves.toBe(storedMessage);
    expect(eventHelper.emit).not.toHaveBeenCalled();
    expect(eventHelper.sendWsOrWebPushNotificationEvent).not.toHaveBeenCalled();
    expect(notificationHelper.createNotifications).not.toHaveBeenCalled();
  });

  it('passes NOT_ALLOWED through for an id of another user or channel', async () => {
    messageHelper.createMessage.mockRejectedValue(new Error('NOT_ALLOWED'));
    await expect(createMessage(request)).rejects.toThrow('NOT_ALLOWED');
    expect(eventHelper.emit).not.toHaveBeenCalled();
  });

  it('a retry whose parent was deleted meanwhile returns the stored message', async () => {
    messageHelper.loadMessagesById.mockResolvedValue([]);
    messageHelper.getOwnStoredMessage.mockResolvedValue(storedMessage);
    await expect(createMessage({ ...request, parentMessageId: PARENT })).resolves.toBe(storedMessage);
    expect(messageHelper.getOwnStoredMessage).toHaveBeenCalledWith(ME, CHANNEL, MESSAGE);
    expect(messageHelper.createMessage).not.toHaveBeenCalled();
    expect(eventHelper.emit).not.toHaveBeenCalled();
  });

  it('a new message with a missing parent is still NOT_FOUND', async () => {
    messageHelper.loadMessagesById.mockResolvedValue([]);
    messageHelper.getOwnStoredMessage.mockResolvedValue(undefined);
    await expect(createMessage({ ...request, parentMessageId: PARENT })).rejects.toThrow('NOT_FOUND');
    expect(messageHelper.createMessage).not.toHaveBeenCalled();
  });
});

describe('/setChannelLastRead', () => {
  const setLastRead = (userId: string, data: any) => handlers['/setChannelLastRead'](asUser(userId), {}, data);
  const stored = { lastRead: '2026-11-02T12:00:00.000Z', unread: 2, syncSeq: 40 };
  const validate = (data: unknown) => validatorsByPath['/setChannelLastRead'].validate(data);

  it('checks read access before writing', async () => {
    permissionHelper.hasPermissions.mockResolvedValue(false);
    await expect(setLastRead(ME, { access: communityAccess, lastRead: stored.lastRead })).rejects.toThrow('NOT_ALLOWED');
    expect(messageHelper.setChannelLastRead).not.toHaveBeenCalled();
    expect(eventHelper.emit).not.toHaveBeenCalled();
  });

  it('refuses a DM the user is not part of', async () => {
    chatHelper.isUserInChat.mockResolvedValue(false);
    await expect(setLastRead(ME, { access: { chatId: CHAT, channelId: CHANNEL }, lastRead: stored.lastRead }))
      .rejects.toThrow('NOT_ALLOWED');
    expect(messageHelper.setChannelLastRead).not.toHaveBeenCalled();
  });

  it('answers with the stored value, unread and syncSeq and echoes them with the community', async () => {
    messageHelper.setChannelLastRead.mockResolvedValue(stored);
    const data = { access: communityAccess, lastRead: '2026-11-02T11:00:00.000Z', messageId: MESSAGE };
    await expect(setLastRead(ME, data)).resolves.toEqual(stored);
    expect(messageHelper.setChannelLastRead).toHaveBeenCalledWith(ME, data);
    expect(eventHelper.emit).toHaveBeenCalledWith({
      type: 'cliChannelLastRead',
      channelId: CHANNEL,
      communityId: COMMUNITY,
      ...stored,
    }, { userIds: [ME] });
  });

  it('echoes the chat id for a DM', async () => {
    messageHelper.setChannelLastRead.mockResolvedValue(stored);
    await setLastRead(ME, { access: { chatId: CHAT, channelId: CHANNEL }, lastRead: stored.lastRead });
    expect(eventHelper.emit).toHaveBeenCalledWith({
      type: 'cliChannelLastRead',
      channelId: CHANNEL,
      chatId: CHAT,
      ...stored,
    }, { userIds: [ME] });
  });

  it('accepts an optional message id', () => {
    expect(validate({ access: communityAccess, lastRead: stored.lastRead }).error).toBeUndefined();
    expect(validate({ access: communityAccess, lastRead: stored.lastRead, messageId: MESSAGE }).error).toBeUndefined();
    expect(validate({ access: communityAccess, lastRead: stored.lastRead, messageId: 'nope' }).error).toBeDefined();
    expect(validate({ access: communityAccess, messageId: MESSAGE }).error).toBeDefined();
  });
});

describe('syncSeq in message events', () => {
  it('a delete carries the highest syncSeq and all of them; replies get their own', () => {
    expect(deleteResultEvents(CHANNEL, {
      deletedIds: [MESSAGE, PARENT],
      deletedSyncSeqs: [21, 22],
      updatedParentIdToNull: [OTHER],
      updatedParents: [{ id: OTHER, syncSeq: 23 }],
      dbNow: 'now',
    })).toEqual([
      {
        type: 'cliMessageEvent',
        action: 'delete',
        data: { channelId: CHANNEL, deletedIds: [MESSAGE, PARENT], syncSeq: 22, syncSeqs: [21, 22] },
      },
      {
        type: 'cliMessageEvent',
        action: 'update',
        data: { id: OTHER, channelId: CHANNEL, parentMessageId: null, updatedAt: 'now', syncSeq: 23 },
      },
    ]);
  });

  it('nothing deleted: no delete event', () => {
    expect(deleteResultEvents(CHANNEL, {
      deletedIds: [], deletedSyncSeqs: [], updatedParentIdToNull: [], updatedParents: [], dbNow: 'now',
    })).toEqual([]);
  });

  it('an edit carries editedAt and syncSeq in the event and the response', async () => {
    messageHelper.editMessage.mockResolvedValue({ updatedAt: 'u', editedAt: 'e', syncSeq: 30 });
    const result = await handlers['/editMessage'](asUser(ME), {}, {
      access: communityAccess, id: MESSAGE, body: storedMessage.body,
    });
    expect(result).toEqual({ editedAt: 'e', updatedAt: 'u', syncSeq: 30 });
    expect(eventHelper.emit).toHaveBeenCalledWith(
      expect.objectContaining({
        action: 'update',
        data: expect.objectContaining({ id: MESSAGE, updatedAt: 'u', editedAt: 'e', syncSeq: 30 }),
      }),
      expect.anything(),
      expect.anything(),
    );
  });

  it('a reaction carries the syncSeq in both copies', async () => {
    messageHelper.setReaction.mockResolvedValue({ updatedAt: 'u', reactions: { a: 1 }, syncSeq: 31 });
    await handlers['/setReaction'](asUser(ME), {}, { access: communityAccess, messageId: MESSAGE, reaction: 'a' });
    const sent = eventHelper.emit.mock.calls.map(call => call[0].data);
    expect(sent).toHaveLength(2);
    for (const data of sent) {
      expect(data).toEqual(expect.objectContaining({ id: MESSAGE, syncSeq: 31 }));
    }
  });

  it('a delete route emits the seqs of the deleted rows', async () => {
    messageHelper.getMessageOwnership.mockResolvedValue({ creatorId: ME, channelId: CHANNEL });
    messageHelper.deleteMessage.mockResolvedValue({
      deletedIds: [MESSAGE], deletedSyncSeqs: [44], updatedParentIdToNull: [], updatedParents: [], dbNow: 'now',
    });
    await handlers['/deleteMessage'](asUser(ME), {}, { access: communityAccess, messageId: MESSAGE, creatorId: ME });
    expect(eventHelper.emit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'delete', data: expect.objectContaining({ deletedIds: [MESSAGE], syncSeq: 44, syncSeqs: [44] }) }),
      expect.anything(),
      undefined,
    );
  });
});
