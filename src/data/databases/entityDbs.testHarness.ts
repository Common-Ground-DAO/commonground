// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Fixtures and helpers for the entity-database tests (community, chat, user).
 * The module mocks live in the test files (vi.mock is per file); they store
 * each tab's mock instances in the object built by `createTabRegistry()`.
 */

export type EventHandler = (event: any) => unknown;

/** what the connection/channel/serviceWorker mocks of one tab expose */
export type TabMocks = {
  handlers: Map<string, Set<EventHandler>>;
  /** registerAccessForChannel: channelId -> last `data.lastRead` passed (the guard seed) */
  registeredLastRead: Map<string, string | undefined>;
  /** applyStoredReadState: channelId -> last merged read state handed to the in-memory store */
  storedReadState: Map<string, { channelId: string }>;
  navigate: (path: string) => void;
  navigations: string[];
};

export function createTabMocks(): TabMocks {
  const navigations: string[] = [];
  return {
    handlers: new Map(),
    registeredLastRead: new Map(),
    storedReadState: new Map(),
    navigations,
    navigate: (path: string) => { navigations.push(path); },
  };
}

/** dispatch one socket event to every handler of a tab and wait for their writes */
export async function emit(mocks: TabMocks, event: { type: string } & Record<string, unknown>): Promise<void> {
  const handlers = [...(mocks.handlers.get(event.type) ?? [])];
  if (handlers.length === 0) throw new Error(`no handler for ${event.type}`);
  await Promise.all(handlers.map(fn => fn(event)));
}

export const T = (minute: number) => new Date(Date.UTC(2026, 10, 2, 12, minute)).toISOString();

export function channelFixture(overrides: Partial<Models.Community.Channel> & { channelId: string }): Models.Community.Channel {
  return {
    communityId: 'com1',
    areaId: null,
    title: overrides.channelId,
    url: null,
    order: 0,
    description: null,
    emoji: null,
    updatedAt: T(0),
    unread: 0,
    lastRead: T(0),
    lastMessageDate: null,
    pinnedMessageIds: null,
    rolePermissions: [],
    pinType: null,
    notifyType: null,
    pinnedUntil: null,
    ...overrides,
  };
}

export function communityFixture(overrides: Partial<Models.Community.DetailViewFromApi> = {}): Models.Community.DetailViewFromApi {
  return {
    id: 'com1',
    url: 'old-url',
    title: 'Community',
    logoSmallId: null,
    logoLargeId: null,
    headerImageId: null,
    shortDescription: '',
    memberCount: 1,
    tags: [],
    official: false,
    allowUserBots: false,
    createdAt: T(0),
    updatedAt: T(0),
    premium: null,
    description: '',
    links: [],
    creatorId: 'u1',
    myRoleIds: ['r1'],
    tokens: [],
    pointBalance: 0,
    blockState: { state: null, until: null },
    enablePersonalNewsletter: false,
    plugins: [],
    calls: [],
    channels: [],
    areas: [],
    roles: [],
    ...overrides,
  } as Models.Community.DetailViewFromApi;
}

export function pluginFixture(overrides: Partial<Models.Plugin.Plugin> = {}): Models.Plugin.Plugin {
  return {
    id: 'p1',
    communityId: 'com1',
    pluginId: 'plugin-1',
    ownerCommunityId: 'com1',
    name: 'Plugin',
    description: null,
    imageId: null,
    config: null,
    url: 'https://plugin.example',
    tags: null,
    permissions: null,
    clonable: false,
    appstoreEnabled: false,
    warnAbusive: false,
    requiresIsolationMode: false,
    reportFlagged: false,
    ...overrides,
  };
}

export function apiMessage(overrides: Partial<Models.Message.ApiMessage> & { id: string; channelId: string; createdAt: string }): Models.Message.ApiMessage {
  return {
    creatorId: 'other',
    body: { version: '2', content: [] } as any,
    attachments: [],
    updatedAt: overrides.createdAt,
    editedAt: null,
    reactions: {},
    ownReaction: null,
    parentMessageId: null,
    ...overrides,
  } as Models.Message.ApiMessage;
}

export function message(overrides: Partial<Models.Message.ApiMessage> & { id: string; channelId: string; createdAt: string }): Models.Message.Message {
  const m = apiMessage(overrides);
  return { ...m, createdAt: new Date(m.createdAt), updatedAt: new Date(m.updatedAt) } as Models.Message.Message;
}

export function chatFixture(overrides: Partial<Models.Chat.ChatFromApi> & { id: string; channelId: string }): Models.Chat.ChatFromApi {
  return {
    userIds: ['me', 'other'],
    adminIds: [],
    createdAt: T(0),
    updatedAt: T(0),
    unread: 0,
    lastRead: T(0),
    lastMessage: null,
    ...overrides,
  };
}
