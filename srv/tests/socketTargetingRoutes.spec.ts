// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Socket-scoped targeting at the route level (srv/util/requestSocket.ts): the
 * sites that leave the sender out of their own events, the article rooms, and
 * the extra delivery of call chat and `cliCallEvent new`. Handlers are
 * captured from `registerPostRoute` and called directly; every repository and
 * the event helper are mocked (what the targets select is covered by
 * socketTargeting.spec.ts).
 */

// a module, not a script: its names stay out of the other specs' scope
export {};

type Handler = (request: any, response: any, data: any) => Promise<any>;
const handlers: Record<string, Handler> = {};
let currentDomain = '';

const messageHelper = {
  isChannelInAccessScope: jest.fn(),
  createMessage: jest.fn(),
  loadMessagesById: jest.fn(),
  getChannelMessageNotifyData: jest.fn(),
  editMessage: jest.fn(),
};
const permissionHelper = {
  hasPermissions: jest.fn(),
  hasPermissionsOrThrow: jest.fn(),
  hasTrustOrThrow: jest.fn(),
};
const chatHelper = {
  isUserInChat: jest.fn(),
  getChatById: jest.fn(),
  createChat: jest.fn(),
  closeChat: jest.fn(),
};
const communityHelper = {
  getCommunityChannelRolePermissions: jest.fn(),
  getCallRolePermissions: jest.fn(),
  getCallDataById: jest.fn(),
  getUserBlockState: jest.fn(),
  areUsersCommunityMembers: jest.fn(),
  attemptJoinCommunity: jest.fn(),
  createCommunity: jest.fn(),
  setChannelPinState: jest.fn(),
};
const callHelper = {
  getActiveMemberUserIds: jest.fn(),
  getCallEventExtraTargets: jest.fn(),
  createCall: jest.fn(),
  startScheduledCall: jest.fn(),
  getUserIdsToNotify: jest.fn(),
};
const communityEventHelper = {
  getCommunityEvent: jest.fn(),
};
const eventHelper = {
  emit: jest.fn(),
  sendWsOrWebPushNotificationEvent: jest.fn(),
  userJoinRooms: jest.fn(),
  requestSocketsJoinRooms: jest.fn(),
  requestSocketsLeaveRooms: jest.fn(),
};

jest.mock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, _validator: unknown, handler: Handler) => {
    handlers[`${currentDomain}${path}`] = handler;
  },
  convertEventPermissionToCallPermission: jest.fn(),
}));
jest.mock('../repositories/messages', () => ({ __esModule: true, default: messageHelper }));
jest.mock('../repositories/permissions', () => ({ __esModule: true, default: permissionHelper }));
jest.mock('../repositories/chats', () => ({ __esModule: true, default: chatHelper }));
jest.mock('../repositories/communities', () => ({ __esModule: true, default: communityHelper }));
jest.mock('../repositories/calls', () => ({ __esModule: true, default: callHelper, MEMBER_PERMISSIONS: [], MODERATOR_PERMISSIONS: [] }));
jest.mock('../repositories/communityEvents', () => ({ __esModule: true, default: communityEventHelper }));
jest.mock('../repositories/event', () => ({ __esModule: true, default: eventHelper }));
jest.mock('../repositories/notifications', () => ({ __esModule: true, default: { createNotifications: jest.fn().mockResolvedValue([]) } }));
for (const name of ['files', 'articles', 'bots', 'onchain', 'newsletter', 'users', 'emails']) {
  jest.doMock(`../repositories/${name}`, () => ({ __esModule: true, default: {} }));
}
jest.mock('../api/emails', () => ({ __esModule: true, default: {}, emailEnabled: () => false }));
jest.mock('../util/axios', () => ({ __esModule: true, default: {} }));
jest.mock('../util/botPrincipal', () => ({ allowBotRoute: jest.fn() }));
jest.mock('../util/botRateLimit', () => ({ enforceBotRateLimit: jest.fn() }));
jest.mock('../util/rateLimit', () => ({ __esModule: true, default: () => jest.fn() }));
jest.mock('../redis', () => ({ __esModule: true, default: { get: jest.fn(), getClient: jest.fn() } }));
jest.mock('open-graph-scraper', () => jest.fn());

const ME = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';
const CHANNEL = '00000000-0000-4000-8000-0000000000a1';
const CALL = '00000000-0000-4000-8000-0000000000e1';
const CHAT = '00000000-0000-4000-8000-0000000000b1';
const MESSAGE = '00000000-0000-4000-8000-0000000000d1';
const ARTICLE_1 = '00000000-0000-4000-8000-0000000000f1';
const DEVICE = 'device-1';
const SOCKET = 'AbCdEfGhIj0123456_-x';
const SOCKET_2 = 'ZyXwVuTsRq9876543_-y';

/** a logged-in request; `socketId` goes into the x-cg-socket-id header */
function asUser(socketId?: unknown, session: Record<string, unknown> = {}): any {
  return {
    headers: socketId === undefined ? {} : { 'x-cg-socket-id': socketId },
    session: { user: { id: ME, deviceId: DEVICE }, ...session },
  };
}
const SOCKET_EXCEPT = { deviceSockets: [{ deviceId: DEVICE, socketId: SOCKET }] };
const DEVICE_EXCEPT = { deviceIds: [DEVICE] };

/** runs a handler, then lets the emits it does not wait for go out */
async function call(path: string, request: any, data: any) {
  const result = await handlers[path](request, {}, data);
  await new Promise(resolve => setImmediate(resolve));
  return result;
}

beforeAll(() => {
  currentDomain = 'Message';
  require('../api/messages');
  currentDomain = 'Chat';
  require('../api/chats');
  currentDomain = 'Community';
  require('../api/community');
  currentDomain = '';
});

beforeEach(() => {
  jest.clearAllMocks();
  messageHelper.isChannelInAccessScope.mockResolvedValue(true);
  messageHelper.getChannelMessageNotifyData.mockResolvedValue([]);
  permissionHelper.hasPermissions.mockResolvedValue(true);
  communityHelper.getCommunityChannelRolePermissions.mockResolvedValue([
    { roleId: 'r-member', roleTitle: 'Member', permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ'] },
  ]);
  communityHelper.getUserBlockState.mockResolvedValue(null);
  communityHelper.areUsersCommunityMembers.mockResolvedValue([]);
  communityHelper.getCallDataById.mockResolvedValue({ id: CALL, communityId: COMMUNITY, endedAt: null });
  callHelper.getActiveMemberUserIds.mockResolvedValue([]);
  callHelper.getCallEventExtraTargets.mockResolvedValue({ activeMemberUserIds: [], publicCommunityId: null });
});

describe('echo exclusion of the request\'s own events', () => {
  const storedMessage = {
    id: MESSAGE, creatorId: ME, channelId: CHANNEL, body: { version: '1', content: [] }, attachments: [],
    createdAt: '', updatedAt: '', editedAt: null, parentMessageId: null, reactions: {}, ownReaction: null, syncSeq: 1,
  };
  const create = { id: MESSAGE, access: { communityId: COMMUNITY, channelId: CHANNEL }, body: storedMessage.body, parentMessageId: null, attachments: [] };
  const lastExcept = () => eventHelper.emit.mock.calls[eventHelper.emit.mock.calls.length - 1][2];

  beforeEach(() => {
    messageHelper.createMessage.mockResolvedValue({ message: storedMessage, userAlias: 'me', created: true });
    messageHelper.editMessage.mockResolvedValue({ updatedAt: 'u', editedAt: 'e', syncSeq: 2 });
    chatHelper.createChat.mockResolvedValue({ id: CHAT, userIds: [ME, OTHER] });
    chatHelper.getChatById.mockResolvedValue({ id: CHAT, userIds: [ME, OTHER] });
    communityHelper.attemptJoinCommunity.mockResolvedValue({ id: COMMUNITY });
    communityHelper.createCommunity.mockResolvedValue({ id: COMMUNITY, roles: [], logoLargeId: null });
  });

  const sites: [string, (request: any) => Promise<unknown>][] = [
    ['createMessage', request => call('Message/createMessage', request, create)],
    ['createModerationMessage', request => call('Message/createModerationMessage', request, create)],
    ['editMessage', request => call('Message/editMessage', request, { access: create.access, id: MESSAGE, body: storedMessage.body })],
    ['startChat', request => call('Chat/startChat', request, { otherUserId: OTHER })],
    ['closeChat', request => call('Chat/closeChat', request, { chatId: CHAT })],
    ['joinCommunity', request => call('Community/joinCommunity', request, { id: COMMUNITY })],
    ['createCommunity', request => call('Community/createCommunity', request, { title: 'x' })],
    ['setChannelPinState', request => call('Community/setChannelPinState', request, { communityId: COMMUNITY, channelId: CHANNEL, pinType: 'autopin' })],
  ];

  describe.each(sites)('%s', (_name, run) => {
    it('excludes only the named socket', async () => {
      await run(asUser(SOCKET));
      expect(eventHelper.emit).toHaveBeenCalled();
      expect(lastExcept()).toEqual(SOCKET_EXCEPT);
    });

    it('excludes the device without the header', async () => {
      await run(asUser());
      expect(lastExcept()).toEqual(DEVICE_EXCEPT);
    });

    it('excludes the device for a malformed header', async () => {
      await run(asUser('not-a-socket-id'));
      expect(lastExcept()).toEqual(DEVICE_EXCEPT);
    });
  });

  it('bot requests keep the device exclusion even with the header', async () => {
    const request = { ...asUser(SOCKET), botPrincipal: { kind: 'bot-token' } };
    await call('Message/editMessage', request, { access: create.access, id: MESSAGE, body: storedMessage.body });
    expect(lastExcept()).toEqual(DEVICE_EXCEPT);
  });
});

describe('call chat delivery', () => {
  const access = { callId: CALL, channelId: CHANNEL };
  const edit = (request: any) => call('Message/editMessage', request, { access, id: MESSAGE, body: { version: '1', content: [] } });

  beforeEach(() => {
    messageHelper.editMessage.mockResolvedValue({ updatedAt: 'u', editedAt: 'e', syncSeq: 2 });
  });

  it('reaches the reader roles and the present members in one emit', async () => {
    communityHelper.getCallRolePermissions.mockResolvedValue([
      { roleId: 'r-member', roleTitle: 'Member', communityId: COMMUNITY, permissions: ['CALL_EXISTS', 'CHANNEL_READ'] },
      { roleId: 'r-muted', roleTitle: 'Muted', communityId: COMMUNITY, permissions: ['CALL_EXISTS'] },
    ]);
    callHelper.getActiveMemberUserIds.mockResolvedValue([ME, OTHER]);
    await edit(asUser(SOCKET));
    expect(callHelper.getActiveMemberUserIds).toHaveBeenCalledWith(CALL, ['CALL_EXISTS', 'CHANNEL_READ']);
    expect(eventHelper.emit).toHaveBeenCalledTimes(1);
    expect(eventHelper.emit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'update' }),
      { roleIds: ['r-member'], userIds: [ME, OTHER], communityIds: [] },
      SOCKET_EXCEPT,
    );
  });

  it('adds the community room when Public may read the call chat', async () => {
    communityHelper.getCallRolePermissions.mockResolvedValue([
      { roleId: 'r-public', roleTitle: 'Public', communityId: COMMUNITY, permissions: ['CALL_EXISTS', 'CHANNEL_READ'] },
    ]);
    await edit(asUser());
    expect(eventHelper.emit).toHaveBeenCalledWith(
      expect.anything(),
      { roleIds: ['r-public'], userIds: [], communityIds: [COMMUNITY] },
      DEVICE_EXCEPT,
    );
  });

  it('a failed member query still reaches the role rooms and the community', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    communityHelper.getCallRolePermissions.mockResolvedValue([
      { roleId: 'r-public', roleTitle: 'Public', communityId: COMMUNITY, permissions: ['CALL_EXISTS', 'CHANNEL_READ'] },
    ]);
    callHelper.getActiveMemberUserIds.mockRejectedValue(new Error('db down'));
    await edit(asUser());
    expect(eventHelper.emit).toHaveBeenCalledWith(
      expect.anything(),
      { roleIds: ['r-public'], userIds: [], communityIds: [COMMUNITY] },
      DEVICE_EXCEPT,
    );
    errorSpy.mockRestore();
  });

  it('a failed role query still reaches the present members', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    communityHelper.getCallRolePermissions.mockRejectedValue(new Error('db down'));
    callHelper.getActiveMemberUserIds.mockResolvedValue([OTHER]);
    await edit(asUser());
    expect(eventHelper.emit).toHaveBeenCalledWith(
      expect.anything(),
      { roleIds: [], userIds: [OTHER], communityIds: [] },
      DEVICE_EXCEPT,
    );
    errorSpy.mockRestore();
  });

  it('a failed target query of any channel kind is logged, never an unhandled rejection', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      communityHelper.getCommunityChannelRolePermissions.mockRejectedValue(new Error('db down'));
      messageHelper.editMessage.mockResolvedValue({ updatedAt: 'u', editedAt: 'e', syncSeq: 2 });
      await call('Message/editMessage', asUser(), { access: { communityId: COMMUNITY, channelId: CHANNEL }, id: MESSAGE, body: { version: '1', content: [] } });
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(eventHelper.emit).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith('Error emitting message events', expect.any(Error));
    } finally {
      process.off('unhandledRejection', unhandled);
      errorSpy.mockRestore();
    }
  });

  it('a new call-chat message goes to the same targets', async () => {
    communityHelper.getCallRolePermissions.mockResolvedValue([
      { roleId: 'r-public', roleTitle: 'Public', communityId: COMMUNITY, permissions: ['CALL_EXISTS', 'CHANNEL_READ'] },
    ]);
    callHelper.getActiveMemberUserIds.mockResolvedValue([OTHER]);
    messageHelper.createMessage.mockResolvedValue({
      message: { id: MESSAGE, channelId: CHANNEL, body: { version: '1', content: [] }, attachments: [] },
      userAlias: 'me',
      created: true,
    });
    await call('Message/createMessage', asUser(SOCKET), { id: MESSAGE, access, body: { version: '1', content: [] }, parentMessageId: null, attachments: [] });
    expect(eventHelper.emit).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'new' }),
      { roleIds: ['r-public'], userIds: [OTHER], communityIds: [COMMUNITY] },
      SOCKET_EXCEPT,
    );
  });
});

describe('cliCallEvent new', () => {
  const callData = { id: CALL, channelId: CHANNEL, communityId: COMMUNITY, title: 't', communityUrl: 'u', communityTitle: 'c', rolePermissions: [{ roleId: 'r-member', permissions: ['CALL_EXISTS'] }] };
  const callEvents = () => eventHelper.emit.mock.calls.filter(([event]) => event.type === 'cliCallEvent');

  beforeEach(() => {
    callHelper.createCall.mockResolvedValue(callData);
    callHelper.startScheduledCall.mockResolvedValue(callData);
    callHelper.getUserIdsToNotify.mockResolvedValue([]);
    communityEventHelper.getCommunityEvent.mockResolvedValue({ communityId: COMMUNITY, rolePermissions: [{ roleId: 'r-preview', permissions: ['EVENT_PREVIEW'] }] });
  });

  it('startCall: role rooms plus present members and, for Public calls, the community', async () => {
    callHelper.getCallEventExtraTargets.mockResolvedValue({ activeMemberUserIds: [ME], publicCommunityId: COMMUNITY });
    await call('Community/startCall', asUser(), { communityId: COMMUNITY });
    expect(callHelper.getCallEventExtraTargets).toHaveBeenCalledWith(CALL);
    expect(callEvents()).toEqual([[
      { type: 'cliCallEvent', action: 'new', data: callData },
      { roleIds: ['r-member'], userIds: [ME], communityIds: [COMMUNITY] },
    ]]);
  });

  it('startCall: a non-public call without members stays on its role rooms', async () => {
    await call('Community/startCall', asUser(), { communityId: COMMUNITY });
    expect(callEvents()[0][1]).toEqual({ roleIds: ['r-member'], userIds: [], communityIds: [] });
  });

  it('startScheduledCall: the event roles plus the extra targets', async () => {
    callHelper.getCallEventExtraTargets.mockResolvedValue({ activeMemberUserIds: [], publicCommunityId: COMMUNITY });
    await call('Community/startScheduledCall', asUser(), { communityEventId: 'ev-1' });
    expect(callEvents()[0][1]).toEqual({ roleIds: ['r-preview'], userIds: [], communityIds: [COMMUNITY] });
  });

  it('still reaches the role rooms when the extra targets cannot be read', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    callHelper.getCallEventExtraTargets.mockRejectedValue(new Error('db down'));
    await expect(call('Community/startCall', asUser(), { communityId: COMMUNITY })).resolves.toBe(callData);
    expect(callEvents()[0][1]).toEqual({ roleIds: ['r-member'], userIds: [], communityIds: [] });
    errorSpy.mockRestore();
  });
});

describe('article rooms', () => {
  const access = (articleId: string) => ({ articleId, articleCommunityId: COMMUNITY, channelId: CHANNEL });
  const join = (request: any, articleId = ARTICLE_1) => call('Message/joinArticleEventRoom', request, { access: access(articleId) });
  const leave = (request: any, articleId = ARTICLE_1) => call('Message/leaveArticleEventRoom', request, { access: access(articleId) });
  const article = (n: number) => `00000000-0000-4000-8000-0000000001${n.toString().padStart(2, '0')}`;

  it('join and leave act on the named socket only', async () => {
    const request = asUser(SOCKET);
    await join(request);
    expect(eventHelper.requestSocketsJoinRooms).toHaveBeenCalledWith({ deviceId: DEVICE, socketId: SOCKET }, { articleIds: [ARTICLE_1] });
    expect(request.session.socketArticleRooms).toEqual([{ articleId: ARTICLE_1, socketId: SOCKET }]);
    expect(request.session.temporaryArticleIds).toBeUndefined();
    await leave(request);
    expect(eventHelper.requestSocketsLeaveRooms).toHaveBeenCalledWith({ deviceId: DEVICE, socketId: SOCKET }, { articleIds: [ARTICLE_1] });
    expect(request.session.socketArticleRooms).toEqual([]);
  });

  it("a tab's leave keeps the other tab's entry", async () => {
    const session = { socketArticleRooms: [{ articleId: ARTICLE_1, socketId: SOCKET }, { articleId: ARTICLE_1, socketId: SOCKET_2 }] };
    const request = asUser(SOCKET, session);
    await leave(request);
    expect(request.session.socketArticleRooms).toEqual([{ articleId: ARTICLE_1, socketId: SOCKET_2 }]);
  });

  it('the limit of 5 is per socket: the sixth room leaves the oldest room of that socket only', async () => {
    const otherTab = { articleId: article(0), socketId: SOCKET_2 };
    const request = asUser(SOCKET, {
      socketArticleRooms: [otherTab, ...[1, 2, 3, 4, 5].map(n => ({ articleId: article(n), socketId: SOCKET }))],
    });
    await join(request, article(6));
    expect(eventHelper.requestSocketsLeaveRooms).toHaveBeenCalledTimes(1);
    expect(eventHelper.requestSocketsLeaveRooms).toHaveBeenCalledWith({ deviceId: DEVICE, socketId: SOCKET }, { articleIds: [article(1)] });
    expect(request.session.socketArticleRooms).toEqual([
      otherTab,
      ...[2, 3, 4, 5, 6].map(n => ({ articleId: article(n), socketId: SOCKET })),
    ]);
  });

  it("another tab's join does not evict this tab's rooms", async () => {
    const rooms = [1, 2, 3, 4, 5].map(n => ({ articleId: article(n), socketId: SOCKET }));
    const request = asUser(SOCKET_2, { socketArticleRooms: [...rooms] });
    await join(request, article(6));
    expect(eventHelper.requestSocketsLeaveRooms).not.toHaveBeenCalled();
    expect(request.session.socketArticleRooms).toEqual([...rooms, { articleId: article(6), socketId: SOCKET_2 }]);
  });

  it('the session keeps at most 50 entries, oldest (closed tabs) first', async () => {
    const stale = Array.from({ length: 50 }, (_, n) => ({ articleId: article(n), socketId: `staleTab${n.toString().padStart(12, '0')}` }));
    const request = asUser(SOCKET, { socketArticleRooms: [...stale] });
    await join(request, article(99));
    expect(eventHelper.requestSocketsLeaveRooms).toHaveBeenCalledTimes(1);
    expect(eventHelper.requestSocketsLeaveRooms).toHaveBeenCalledWith({ deviceId: DEVICE, socketId: stale[0].socketId }, { articleIds: [article(0)] });
    expect(request.session.socketArticleRooms).toHaveLength(50);
    expect(request.session.socketArticleRooms[49]).toEqual({ articleId: article(99), socketId: SOCKET });
  });

  it('joining the same article twice from one socket keeps one entry', async () => {
    const request = asUser(SOCKET);
    await join(request);
    await join(request);
    expect(request.session.socketArticleRooms).toEqual([{ articleId: ARTICLE_1, socketId: SOCKET }]);
  });

  it('without the header the device joins and leaves, as before', async () => {
    const request = asUser();
    await join(request);
    expect(eventHelper.requestSocketsJoinRooms).toHaveBeenCalledWith({ deviceId: DEVICE, socketId: null }, { articleIds: [ARTICLE_1] });
    expect(request.session.temporaryArticleIds).toEqual([ARTICLE_1]);
    await leave(request);
    expect(eventHelper.requestSocketsLeaveRooms).toHaveBeenCalledWith({ deviceId: DEVICE, socketId: null }, { articleIds: [ARTICLE_1] });
    expect(request.session.temporaryArticleIds).toEqual([]);
  });

  it('checks read access before joining', async () => {
    permissionHelper.hasPermissions.mockResolvedValue(false);
    await expect(join(asUser(SOCKET))).rejects.toThrow();
    expect(eventHelper.requestSocketsJoinRooms).not.toHaveBeenCalled();
  });
});
