// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Cross-tab behaviour of the shared entity databases (community, chat,
 * user): two module graphs (importAsNewTab) on one fake IndexedDB act as two
 * tabs that both process the same socket events.
 */

import { describe, expect, it, vi } from 'vitest';
import { Dexie, type Table } from 'dexie';
import { installBrowserEnv } from 'test/env';
import { installFakeIdb } from 'test/fakeIdb';
import { importAsNewTab } from 'test/modules';
import { chatFromApi } from './readStateRows';
import {
  T,
  apiMessage,
  channelFixture,
  chatFixture,
  communityFixture,
  createTabMocks,
  emit,
  message,
  pluginFixture,
  type TabMocks,
} from './entityDbs.testHarness';

vi.mock('data/api/community', () => ({ default: {} }));
vi.mock('data/api/chat', () => ({ default: {} }));
vi.mock('data/api/user', () => ({ default: {} }));
vi.mock('data/managers/communityManager', () => ({ default: {} }));
vi.mock('data/appstate/login', () => ({ default: {} }));

type Tab = TabMocks & {
  community: typeof import('data/databases/community').default;
  chats: typeof import('data/databases/chats').default;
  user: typeof import('data/databases/user').default;
  persistence: typeof import('data/databases/readStatePersistence').default;
};

/**
 * A fresh module graph of the three databases = one tab. The per-tab mocks
 * are registered with vi.doMock right before the import, so every graph gets
 * its own instances (a hoisted vi.mock factory result is shared by graphs).
 */
async function openTab(): Promise<Tab> {
  const mocks = createTabMocks();
  vi.doMock('data/appstate/connection', () => ({
    default: {
      registerClientEventHandler(type: string, fn: (event: unknown) => unknown) {
        if (!mocks.handlers.has(type)) mocks.handlers.set(type, new Set());
        mocks.handlers.get(type)!.add(fn);
      },
      unregisterClientEventHandler() {},
      addListener() {},
      removeListener() {},
    },
  }));
  vi.doMock('data/databases/channel', () => ({
    default: {
      registerAccessForChannel(access: { channelId: string }, data?: { lastRead: string }) {
        // like channel.ts: only a given lastRead replaces the guard value
        if (data) mocks.registeredLastRead.set(access.channelId, data.lastRead);
      },
      setInitialChannelLastRead() {
        throw new Error('entity dbs must not move the in-memory lastRead backwards');
      },
      deleteChannelDatabase: async () => {},
      getAccessForChannel: () => undefined,
      applyStoredReadState(states: { channelId: string }[]) {
        for (const state of states) mocks.storedReadState.set(state.channelId, state);
      },
    },
  }));
  vi.doMock('data/appstate/serviceWorker', () => ({ default: { navigate: mocks.navigate } }));
  const [community, chats, user, persistence] = await importAsNewTab(() => Promise.all([
    import('data/databases/community'),
    import('data/databases/chats'),
    import('data/databases/user'),
    import('data/databases/readStatePersistence'),
  ]));
  return {
    ...mocks,
    community: community.default,
    chats: chats.default,
    user: user.default,
    persistence: persistence.default,
  };
}

async function twoTabs(url?: string) {
  installBrowserEnv({ url });
  installFakeIdb();
  return [await openTab(), await openTab()] as const;
}

const db = (tab: Tab, name: 'community' | 'chats' | 'user') => (tab[name] as any).db;

describe('community database across tabs', () => {
  it('adds a plugin once when both tabs process the same plugin event', async () => {
    const [a, b] = await twoTabs();
    await emit(a, { type: 'cliCommunityEvent', action: 'new-or-full-update', data: communityFixture() });
    const event = { type: 'cliPluginEvent', action: 'new', data: pluginFixture() };
    await emit(a, event);
    await emit(b, event);
    await emit(a, event);
    const stored = await db(b, 'community').communities.get('com1');
    expect(stored.plugins.map((p: Models.Plugin.Plugin) => p.id)).toEqual(['p1']);
  });

  it('keeps the newer community data when a tab applies an older update late', async () => {
    const [a, b] = await twoTabs();
    await emit(a, { type: 'cliCommunityEvent', action: 'new-or-full-update', data: communityFixture() });
    const older = { type: 'cliCommunityEvent', action: 'update', data: { id: 'com1', title: 'older', updatedAt: T(1) } };
    const newer = { type: 'cliCommunityEvent', action: 'update', data: { id: 'com1', title: 'newer', updatedAt: T(2) } };
    await emit(a, older);
    await emit(a, newer);
    await emit(b, newer);
    await emit(b, older); // tab b was frozen and replays its queue
    expect((await db(a, 'community').communities.get('com1')).title).toBe('newer');
  });

  it('applies updates without updatedAt (cannot be ordered) as before', async () => {
    const [a] = await twoTabs();
    await emit(a, { type: 'cliCommunityEvent', action: 'new-or-full-update', data: communityFixture({ updatedAt: T(5) }) });
    await emit(a, { type: 'cliCallEvent', action: 'new', data: { id: 'call1', communityId: 'com1', updatedAt: T(5), callMembers: 1 } });
    await emit(a, { type: 'cliCallEvent', action: 'update', data: { id: 'call1', communityId: 'com1', callMembers: 2 } });
    expect((await db(a, 'community').calls.get('call1')).callMembers).toBe(2);
  });

  it('keeps newer areas, roles, channels and calls against older events', async () => {
    const [a, b] = await twoTabs();
    const area = { id: 'a1', communityId: 'com1', title: 'new', order: 0, updatedAt: T(2) };
    await emit(a, { type: 'cliAreaEvent', action: 'new', data: area });
    await emit(b, { type: 'cliAreaEvent', action: 'update', data: { ...area, title: 'old', updatedAt: T(1) } });
    await emit(b, { type: 'cliAreaEvent', action: 'new', data: { ...area, title: 'older new', updatedAt: T(0) } });
    expect((await db(a, 'community').areas.get(['com1', 'a1'])).title).toBe('new');

    const role = { id: 'r1', communityId: 'com1', title: 'Role', type: 'CUSTOM_ROLE', updatedAt: T(2) };
    await emit(a, { type: 'cliRoleEvent', action: 'new', data: role });
    await emit(b, { type: 'cliRoleEvent', action: 'update', data: { ...role, title: 'old', updatedAt: T(1) } });
    expect((await db(a, 'community').roles.get(['com1', 'r1'])).title).toBe('Role');

    await emit(a, { type: 'cliChannelEvent', action: 'new', data: channelFixture({ channelId: 'ch1', title: 'new', updatedAt: T(2) }) });
    await emit(b, { type: 'cliChannelEvent', action: 'update', data: { communityId: 'com1', channelId: 'ch1', title: 'old', updatedAt: T(1) } });
    expect((await db(a, 'community').channels.get(['com1', 'ch1'])).title).toBe('new');
    await emit(b, { type: 'cliChannelEvent', action: 'update', data: { communityId: 'com1', channelId: 'ch1', title: 'newest', updatedAt: T(3) } });
    expect((await db(a, 'community').channels.get(['com1', 'ch1'])).title).toBe('newest');

    await emit(a, { type: 'cliCallEvent', action: 'new', data: { id: 'call1', communityId: 'com1', updatedAt: T(2), previewUserIds: ['x'] } });
    await emit(b, { type: 'cliCallEvent', action: 'update', data: { id: 'call1', communityId: 'com1', updatedAt: T(1), previewUserIds: [] } });
    expect((await db(a, 'community').calls.get('call1')).previewUserIds).toEqual(['x']);
  });

  it('navigates every tab on a community URL change, whichever tab writes first', async () => {
    const [a, b] = await twoTabs('http://localhost:3000/c/old-url/channel/general/?x=1#m');
    await emit(a, { type: 'cliCommunityEvent', action: 'new-or-full-update', data: communityFixture() });
    // tab b shows the community (CommunityProvider resolves it by URL)
    expect(await b.community.getCommunityByUrl('old-url')).toBeDefined();

    const event = { type: 'cliCommunityEvent', action: 'update', data: { id: 'com1', url: 'new-url', updatedAt: T(1) } };
    await emit(a, event);
    await emit(b, event); // the row already has the new URL here
    expect(a.navigations).toEqual(['/c/new-url/channel/general/?x=1#m']);
    expect(b.navigations).toEqual(['/c/new-url/channel/general/?x=1#m']);
    expect((await db(b, 'community').communities.get('com1')).url).toBe('new-url');
  });

  it('does not navigate on an older URL update or for another community', async () => {
    const [a] = await twoTabs('http://localhost:3000/c/old-url/channel/general/');
    await emit(a, { type: 'cliCommunityEvent', action: 'new-or-full-update', data: communityFixture({ updatedAt: T(5) }) });
    await emit(a, { type: 'cliCommunityEvent', action: 'update', data: { id: 'com1', url: 'stale-url', updatedAt: T(1) } });
    await emit(a, { type: 'cliCommunityEvent', action: 'new-or-full-update', data: communityFixture({ id: 'com2', url: 'other' }) });
    await emit(a, { type: 'cliCommunityEvent', action: 'update', data: { id: 'com2', url: 'other-new', updatedAt: T(6) } });
    expect(a.navigations).toEqual([]);
  });
});

describe('user database across tabs', () => {
  it('keeps newer user data when an older cliUserData arrives late', async () => {
    const [a, b] = await twoTabs();
    await db(a, 'user').userData.put({ id: 'u2', onlineStatus: 'offline', updatedAt: T(0) });
    await emit(a, { type: 'cliUserData', data: { id: 'u2', onlineStatus: 'online', updatedAt: T(2) } });
    await emit(b, { type: 'cliUserData', data: { id: 'u2', onlineStatus: 'offline', updatedAt: T(1) } });
    expect((await db(a, 'user').userData.get('u2')).onlineStatus).toBe('online');
  });

  it('keeps newer own data when an older cliUserOwnData arrives late', async () => {
    const [a, b] = await twoTabs();
    const { default: uniqueDb } = await import('data/databases/unique');
    await uniqueDb.uniques.put({ key: 'OwnData', data: { id: 'me', onlineStatus: 'online', updatedAt: T(2) } } as any);
    await emit(b, { type: 'cliUserOwnData', data: { onlineStatus: 'away', updatedAt: T(1) } });
    expect(((await uniqueDb.uniques.get('OwnData')) as any).data.onlineStatus).toBe('online');
    await emit(a, { type: 'cliUserOwnData', data: { onlineStatus: 'away' } });
    expect(((await uniqueDb.uniques.get('OwnData')) as any).data.onlineStatus).toBe('away');
  });
});

/** a community with one channel that was read up to T(0) */
async function seedCommunityChannel(tab: Tab, channel: Partial<Models.Community.Channel> = {}) {
  await emit(tab, {
    type: 'cliCommunityEvent',
    action: 'new-or-full-update',
    data: communityFixture({ channels: [channelFixture({ channelId: 'ch1', ...channel })] }),
  });
}

const channelRow = (tab: Tab, channelId = 'ch1') => db(tab, 'community').channels.get(['com1', channelId]);
const chatRow = (tab: Tab, id = 'chat1') => db(tab, 'chats').chats.get(id);
const msg = (id: string, minute: number, syncSeq?: number, channelId = 'ch1') =>
  message({ id, channelId, createdAt: T(minute), ...(syncSeq !== undefined ? { syncSeq } : {}) });

describe('community channel read state across tabs', () => {
  it('counts a new message once when both tabs process the same event', async () => {
    const [a, b] = await twoTabs();
    await seedCommunityChannel(a);
    await a.community.newMessageReceived('ch1', msg('m1', 1, 11), false);
    await b.community.newMessageReceived('ch1', msg('m1', 1, 11), false);
    // an older server sends no syncSeq: counted only if newer than every message seen
    await a.community.newMessageReceived('ch1', msg('m2', 2), false);
    await b.community.newMessageReceived('ch1', msg('m2', 2), false);
    expect(await channelRow(a)).toMatchObject({ unread: 2, lastMessageDate: T(2), readCounted: [11] });
    expect(await a.community.areCommunitiesUnread(['com1'])).toBe(true);
  });

  it('counts out-of-order seqs once each', async () => {
    const [a, b] = await twoTabs();
    await seedCommunityChannel(a);
    await a.community.newMessageReceived('ch1', msg('m12', 2, 12), false);
    await b.community.newMessageReceived('ch1', msg('m11', 1, 11), false);
    await a.community.newMessageReceived('ch1', msg('m11', 1, 11), false);
    await b.community.newMessageReceived('ch1', msg('m12', 2, 12), false);
    expect(await channelRow(b)).toMatchObject({ unread: 2, readCounted: [11, 12], lastMessageDate: T(2) });
  });

  it('keeps messages counted during a sync snapshot round trip', async () => {
    const [a, b] = await twoTabs();
    await seedCommunityChannel(a);
    await a.persistence.apply({ kind: 'snapshot', channelId: 'ch1', lastRead: T(0), unread: 0, syncSeq: 10, lastMessageDate: T(0) });
    await a.community.newMessageReceived('ch1', msg('m11', 1, 11), false);
    await b.community.newMessageReceived('ch1', msg('m12', 2, 12), false);
    // the snapshot was taken at seq 11: it counts m11, not m12
    await b.persistence.apply({ kind: 'snapshot', channelId: 'ch1', lastRead: T(0), unread: 1, syncSeq: 11, lastMessageDate: T(1) });
    expect(await channelRow(a)).toMatchObject({ unread: 2, readSeq: 11, readCounted: [12] });
    // a late, older snapshot does not lower it
    await a.persistence.apply({ kind: 'snapshot', channelId: 'ch1', lastRead: T(0), unread: 0, syncSeq: 10, lastMessageDate: T(0) });
    expect(await channelRow(a)).toMatchObject({ unread: 2, readSeq: 11 });
    expect(await a.persistence.get('ch1')).toMatchObject({ unread: 2, seq: 11, counted: [12], lastMessageDate: T(2) });
  });

  it('own messages and read marks clear the count, older marks change nothing', async () => {
    const [a, b] = await twoTabs();
    await seedCommunityChannel(a);
    await a.community.newMessageReceived('ch1', msg('m1', 1, 11), false);
    await b.community.newMessageReceived('ch1', message({ id: 'm2', channelId: 'ch1', createdAt: T(2), syncSeq: 12, creatorId: 'me' }), true);
    expect(await channelRow(a)).toMatchObject({ unread: 0, lastRead: T(2) });
    await a.community.newMessageReceived('ch1', msg('m3', 3, 13), false);
    await b.community.setChannelLastRead('ch1', new Date(T(3)));
    await a.community.setChannelLastRead('ch1', new Date(T(1)));
    expect(await channelRow(a)).toMatchObject({ unread: 0, lastRead: T(3) });
  });

  it('an older detail-view or login snapshot does not undo a newer local read (R2)', async () => {
    const [a, b] = await twoTabs();
    await seedCommunityChannel(a);
    await a.community.newMessageReceived('ch1', msg('m1', 4, 11), false);
    await a.community.setChannelLastRead('ch1', new Date(T(5)));
    // tab b got this snapshot before the mark reached the server
    const stale = communityFixture({
      channels: [channelFixture({ channelId: 'ch1', title: 'renamed', lastRead: T(3), unread: 2, lastMessageDate: T(4) })],
    });
    await emit(b, { type: 'cliCommunityEvent', action: 'new-or-full-update', data: stale });
    expect(await channelRow(a)).toMatchObject({ title: 'renamed', unread: 0, lastRead: T(5), lastMessageDate: T(4) });
    // the send guard holds what the server knows (T3), so the T5 mark is re-sent
    expect(b.registeredLastRead.get('ch1')).toBe(T(3));

    await b.community.setupAfterLogin([stale]);
    expect(await channelRow(a)).toMatchObject({ unread: 0, lastRead: T(5) });
    // the merged row (not the stale snapshot) is mirrored into the in-memory store
    expect(b.storedReadState.get('ch1')).toMatchObject({ unread: 0, lastRead: T(5) });
    // the send guard holds what the server knows (T3), so the T5 mark is re-sent
    expect(b.registeredLastRead.get('ch1')).toBe(T(3));

    // a newer snapshot (read on another device, new messages after it) is taken
    const fresh = communityFixture({
      channels: [channelFixture({ channelId: 'ch1', title: 'renamed', lastRead: T(6), unread: 1, lastMessageDate: T(7) })],
    });
    await a.community.setupAfterLogin([fresh]);
    expect(await channelRow(b)).toMatchObject({ unread: 1, lastRead: T(6), lastMessageDate: T(7) });
  });

  it('a channel event does not reset local read state', async () => {
    const [a, b] = await twoTabs();
    await seedCommunityChannel(a);
    await a.community.newMessageReceived('ch1', msg('m1', 1, 11), false);
    // permissions changed: the server re-sends the channel as "new"
    await emit(b, { type: 'cliChannelEvent', action: 'new', data: channelFixture({ channelId: 'ch1', lastRead: T(0), updatedAt: T(1), unread: undefined }) });
    expect(await channelRow(a)).toMatchObject({ unread: 1, readCounted: [11], updatedAt: T(1) });
    await emit(b, { type: 'cliChannelEvent', action: 'update', data: { communityId: 'com1', channelId: 'ch1', unread: 0, lastRead: T(0), updatedAt: T(2) } });
    expect(await channelRow(a)).toMatchObject({ unread: 1, updatedAt: T(2) });
  });
});

describe('chat read state across tabs', () => {
  async function seedChat(tab: Tab, overrides: Partial<Models.Chat.ChatFromApi> = {}) {
    await emit(tab, { type: 'cliChatEvent', action: 'new', data: chatFixture({ id: 'chat1', channelId: 'dm1', ...overrides }) });
  }

  it('counts a DM message once and keeps the newest lastMessage', async () => {
    const [a, b] = await twoTabs();
    await seedChat(a);
    await a.chats.newMessageReceived('dm1', msg('m2', 2, 12, 'dm1'), false);
    await b.chats.newMessageReceived('dm1', msg('m1', 1, 11, 'dm1'), false);
    await b.chats.newMessageReceived('dm1', msg('m2', 2, 12, 'dm1'), false);
    const row = await chatRow(a);
    expect(row).toMatchObject({ unread: 2, lastMessageDate: T(2) });
    expect(row.lastMessage.id).toBe('m2');
    expect(await a.persistence.get('dm1')).toMatchObject({ unread: 2, counted: [11, 12] });
  });

  it('a read mark clears a restored count again; older snapshots do not restore it (R3)', async () => {
    const [a, b] = await twoTabs();
    await seedChat(a);
    await a.chats.newMessageReceived('dm1', msg('m1', 4, 11, 'dm1'), false);
    await a.chats.setChannelLastRead('dm1', new Date(T(5)));
    expect(await chatRow(a)).toMatchObject({ unread: 0, lastRead: T(5) });

    const stale = chatFixture({ id: 'chat1', channelId: 'dm1', lastRead: T(3), unread: 2, lastMessage: apiMessage({ id: 'm0', channelId: 'dm1', createdAt: T(3) }) });
    await b.chats.setupAfterLogin([stale]);
    const row = await chatRow(a);
    expect(row).toMatchObject({ unread: 0, lastRead: T(5) });
    expect(row.lastMessage.id).toBe('m1');
    expect(b.registeredLastRead.get('dm1')).toBe(T(3));
    expect(b.storedReadState.get('dm1')).toMatchObject({ unread: 0, lastRead: T(5) });

    // a count restored by an older build: the same mark clears it, every time
    await db(a, 'chats').chats.update('chat1', { unread: 3 });
    await a.chats.setChannelLastRead('dm1', new Date(T(5)));
    expect((await chatRow(a)).unread).toBe(0);
    await db(a, 'chats').chats.update('chat1', { unread: 3 });
    await a.chats.setChannelLastRead('dm1', new Date(T(5)));
    expect((await chatRow(a)).unread).toBe(0);
  });

  it('setupAfterLogin deletes chats the snapshot no longer has', async () => {
    const [a] = await twoTabs();
    await seedChat(a);
    // the request started after the chat was stored
    await a.chats.setupAfterLogin([chatFixture({ id: 'chat2', channelId: 'dm2', lastRead: T(0), unread: 1, lastMessage: apiMessage({ id: 'x', channelId: 'dm2', createdAt: T(1) }) })], { requestStartedAt: Date.now() + 1 });
    expect(await chatRow(a)).toBeUndefined();
    expect(await chatRow(a, 'chat2')).toMatchObject({ unread: 1, lastMessageDate: T(1) });
  });
});

describe('schema compatibility', () => {
  it('opens databases written by the current build and keeps their rows', async () => {
    installBrowserEnv();
    const idb = installFakeIdb();
    const { default: config } = await import('common/config');
    // the stores as the build before this change declared them
    const oldCommunities = idb.tab(o => {
      const d = new Dexie(`${config.IDB_PREFIX}_communities`, o) as Dexie & { channels: Table };
      d.version(3).stores({
        communities: '&id,url',
        areas: '&[communityId+id],id,communityId',
        channels: '&[communityId+channelId],channelId,communityId',
        roles: '&[communityId+id],[title+type],id,communityId',
        calls: '&id,communityId',
        communityListViews: '&id,url',
        communityMembers: '&[communityId+userId],communityId',
        status: '&id',
      });
      return d;
    });
    await oldCommunities.channels.put(channelFixture({ channelId: 'ch1', unread: 4, lastRead: T(0), lastMessageDate: T(3) }));
    const oldChats = idb.tab(o => {
      const d = new Dexie(`${config.IDB_PREFIX}_chat`, o) as Dexie & { chats: Table };
      d.version(2).stores({ chats: '&id,channelId' });
      return d;
    });
    await oldChats.chats.put(chatFromApi(chatFixture({ id: 'chat1', channelId: 'dm1', unread: 2, lastMessage: apiMessage({ id: 'm', channelId: 'dm1', createdAt: T(2) }) })));

    // the old tab stays open next to the new one
    const tab = await openTab();
    expect(await channelRow(tab)).toMatchObject({ unread: 4, lastMessageDate: T(3) });
    expect(await tab.persistence.get('ch1')).toEqual({ channelId: 'ch1', lastRead: T(0), unread: 4, seq: 0, counted: [], lastMessageDate: T(3) });
    expect(await tab.persistence.get('dm1')).toMatchObject({ unread: 2, seq: 0, lastMessageDate: T(2) });
    await tab.community.newMessageReceived('ch1', msg('m4', 4, 20), false);
    expect(await channelRow(tab)).toMatchObject({ unread: 5, readCounted: [20] });
    expect(oldCommunities.isOpen()).toBe(true);
    expect(await oldCommunities.channels.count()).toBe(1);
  });
});

describe('review fixes', () => {
  it('a lagging tab replaying an older URL change still leaves the dead URL', async () => {
    const [a, b] = await twoTabs('http://localhost:3000/c/old-url/channel/general/');
    await emit(a, { type: 'cliCommunityEvent', action: 'new-or-full-update', data: communityFixture() });
    expect(await b.community.getCommunityByUrl('old-url')).toBeDefined();
    const e1 = { type: 'cliCommunityEvent', action: 'update', data: { id: 'com1', url: 'new-url', updatedAt: T(1) } };
    const e2 = { type: 'cliCommunityEvent', action: 'update', data: { id: 'com1', membersPendingApproval: 3, updatedAt: T(2) } };
    await emit(a, e1);
    await emit(a, e2);
    await emit(b, e1); // older than the row now
    await emit(b, e2);
    expect(b.navigations).toEqual(['/c/new-url/channel/general/']);
    expect(a.navigations).toEqual(['/c/new-url/channel/general/']);
  });

  it('a lagging tab navigates to the current URL, not the one in the old event', async () => {
    const [a, b] = await twoTabs('http://localhost:3000/c/old-url/channel/general/');
    await emit(a, { type: 'cliCommunityEvent', action: 'new-or-full-update', data: communityFixture() });
    expect(await b.community.getCommunityByUrl('old-url')).toBeDefined();
    const e1 = { type: 'cliCommunityEvent', action: 'update', data: { id: 'com1', url: 'url-1', updatedAt: T(1) } };
    const e2 = { type: 'cliCommunityEvent', action: 'update', data: { id: 'com1', url: 'url-2', updatedAt: T(2) } };
    await emit(a, e1);
    await emit(a, e2);
    await emit(b, e1);
    expect(b.navigations).toEqual(['/c/url-2/channel/general/']);
  });

  it('seeds the send guard from the server-known lastRead, so a lost mark is sent again', async () => {
    const [a] = await twoTabs();
    await seedCommunityChannel(a, { lastRead: T(3), unread: 1, lastMessageDate: T(4) });
    await emit(a, { type: 'cliChatEvent', action: 'new', data: chatFixture({ id: 'chat1', channelId: 'dm1', lastRead: T(3) }) });
    // local marks; the API call never happens (tab closed before the debounce)
    await a.community.setChannelLastRead('ch1', new Date(T(5)));
    await a.chats.setChannelLastRead('dm1', new Date(T(5)));
    expect(await channelRow(a)).toMatchObject({ lastRead: T(5), unread: 0, serverLastRead: T(3) });

    // reload: the new tab's guard starts at the server's value
    const reloaded = await openTab();
    await vi.waitFor(() => {
      expect(reloaded.registeredLastRead.get('ch1')).toBe(T(3));
      expect(reloaded.registeredLastRead.get('dm1')).toBe(T(3));
    });
    // the next login snapshot still knows T3 only
    await reloaded.community.setupAfterLogin([communityFixture({ channels: [channelFixture({ channelId: 'ch1', lastRead: T(3), unread: 1, lastMessageDate: T(4) })] })]);
    expect(reloaded.registeredLastRead.get('ch1')).toBe(T(3));
    expect(await channelRow(reloaded)).toMatchObject({ lastRead: T(5), unread: 0 });

    // a server answer (with a count) and own messages move it forward
    await reloaded.persistence.apply({ kind: 'lastRead', channelId: 'ch1', lastRead: T(5), unread: 0, syncSeq: 3 });
    await reloaded.chats.newMessageReceived('dm1', message({ id: 'own', channelId: 'dm1', createdAt: T(6), creatorId: 'me' }), true);
    const third = await openTab();
    await vi.waitFor(() => {
      expect(third.registeredLastRead.get('ch1')).toBe(T(5));
      expect(third.registeredLastRead.get('dm1')).toBe(T(6));
    });
  });

  it('a stale chat snapshot does not delete a chat another tab got by event', async () => {
    const [a, b] = await twoTabs();
    const requestStartedAt = Date.now();
    await emit(a, { type: 'cliChatEvent', action: 'new', data: chatFixture({ id: 'chat1', channelId: 'dm1' }) });
    await emit(a, { type: 'cliChatEvent', action: 'new', data: chatFixture({ id: 'chat2', channelId: 'dm2' }) });
    // tab b's getChats started before chat2 existed
    await b.chats.setupAfterLogin([chatFixture({ id: 'chat1', channelId: 'dm1' })], { requestStartedAt });
    expect(await chatRow(a, 'chat2')).toBeDefined();
  });

  it('a stale detail view neither deletes rows created meanwhile nor regresses newer ones', async () => {
    const [a, b] = await twoTabs();
    const area = { id: 'a1', communityId: 'com1', title: 'Area', order: 0, updatedAt: T(1) };
    const role = { id: 'r1', communityId: 'com1', title: 'Role', type: 'CUSTOM_ROLE', updatedAt: T(1), permissions: [] };
    await emit(a, { type: 'cliCommunityEvent', action: 'new-or-full-update', data: communityFixture({ areas: [area], roles: [role] as any }) });
    // events after tab b's fetch started
    await emit(a, { type: 'cliAreaEvent', action: 'update', data: { ...area, title: 'Area renamed', updatedAt: T(2) } });
    await emit(a, { type: 'cliRoleEvent', action: 'update', data: { ...role, title: 'Role renamed', updatedAt: T(2) } });
    await emit(a, { type: 'cliAreaEvent', action: 'new', data: { ...area, id: 'a2', title: 'New area', updatedAt: T(2) } });
    await emit(a, { type: 'cliChannelEvent', action: 'new', data: channelFixture({ channelId: 'ch2', updatedAt: T(2) }) });
    await emit(a, { type: 'cliCallEvent', action: 'new', data: { id: 'call1', communityId: 'com1', channelId: 'cc1', updatedAt: T(2), previewUserIds: [] } });

    // tab b applies its older detail view (the default margin covers the fetch)
    await emit(b, { type: 'cliCommunityEvent', action: 'new-or-full-update', data: communityFixture({ areas: [area], roles: [role] as any }) });
    const tables = db(a, 'community');
    expect((await tables.areas.get(['com1', 'a1'])).title).toBe('Area renamed');
    expect((await tables.roles.get(['com1', 'r1'])).title).toBe('Role renamed');
    expect(await tables.areas.get(['com1', 'a2'])).toBeDefined();
    expect(await tables.channels.get(['com1', 'ch2'])).toBeDefined();
    expect(await tables.calls.get('call1')).toBeDefined();

    // a login snapshot whose request started after those writes deletes them
    await b.community.setupAfterLogin([communityFixture({ areas: [{ ...area, updatedAt: T(3) }], roles: [role] as any })], { requestStartedAt: Date.now() + 1 });
    expect(await tables.areas.get(['com1', 'a2'])).toBeUndefined();
    expect(await tables.channels.get(['com1', 'ch2'])).toBeUndefined();
    expect(await tables.calls.get('call1')).toBeUndefined();
    expect((await tables.areas.get(['com1', 'a1'])).updatedAt).toBe(T(3));
    expect((await tables.roles.get(['com1', 'r1'])).title).toBe('Role renamed');
  });
});

describe('community URL taken over by another community', () => {
  it('does not navigate away from a community that now owns a URL another one gave up', async () => {
    const [a, b] = await twoTabs('http://localhost:3000/c/foo/channel/general/');
    await emit(a, { type: 'cliCommunityEvent', action: 'new-or-full-update', data: communityFixture({ id: 'com1', url: 'foo' }) });
    expect(await b.community.getCommunityByUrl('foo')).toBeDefined();
    // com1 is renamed foo -> bar (both tabs follow), then com2 claims "foo"
    const rename = { type: 'cliCommunityEvent', action: 'update', data: { id: 'com1', url: 'bar', updatedAt: T(1) } };
    await emit(a, rename);
    await emit(b, rename);
    a.navigations.length = 0;
    b.navigations.length = 0;
    await emit(a, { type: 'cliCommunityEvent', action: 'new-or-full-update', data: communityFixture({ id: 'com2', url: 'foo', updatedAt: T(2) }) });
    // tab b browses com2 at /c/foo/… (still the global location)
    expect((await b.community.getCommunityByUrl('foo'))?.id).toBe('com2');

    // a later com1 edit carries its url again (the request is spread into the payload)
    const edit = { type: 'cliCommunityEvent', action: 'update', data: { id: 'com1', url: 'bar', description: 'x', updatedAt: T(3) } };
    await emit(a, edit);
    await emit(b, edit);
    expect(a.navigations).toEqual([]);
    expect(b.navigations).toEqual([]);
  });

  it('does not navigate even if this tab never looked the new owner up', async () => {
    const [a, b] = await twoTabs('http://localhost:3000/c/foo/channel/general/');
    await emit(a, { type: 'cliCommunityEvent', action: 'new-or-full-update', data: communityFixture({ id: 'com1', url: 'foo' }) });
    expect(await b.community.getCommunityByUrl('foo')).toBeDefined();
    await emit(a, { type: 'cliCommunityEvent', action: 'update', data: { id: 'com1', url: 'bar', updatedAt: T(1) } });
    // only tab a stored com2 with "foo"; tab b still lists foo for com1
    await emit(a, { type: 'cliCommunityEvent', action: 'new-or-full-update', data: communityFixture({ id: 'com2', url: 'foo', updatedAt: T(2) }) });
    await emit(b, { type: 'cliCommunityEvent', action: 'update', data: { id: 'com1', url: 'bar', description: 'x', updatedAt: T(3) } });
    expect(b.navigations).toEqual([]);
  });
});


describe('slow snapshot recovery', () => {
  it('preserves the cache during a slow read and completes after the former seven second timeout', async () => {
    installBrowserEnv(); installFakeIdb();
    const tab = await openTab();
    await tab.community.setupAfterLogin([communityFixture()]);
    const { default: uniques } = await import('data/databases/unique');
    const original = uniques.uniques.get.bind(uniques.uniques);
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void;
    const waiting = new Promise<void>(resolve => { entered = resolve; });
    let delayed = false;
    const spy = vi.spyOn(uniques.uniques, 'get').mockImplementation((async (key: any) => {
      const row = await original(key);
      if (key === 'OwnCommunityIds' && !delayed) { delayed = true; entered(); await gate; }
      return row;
    }) as any);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const first = tab.community.setupAfterLogin([communityFixture({ title: 'New title', updatedAt: T(3) })]);
    try {
      await waiting;
      await vi.advanceTimersByTimeAsync(8000);
      expect(await tab.community.getOwnCommunities()).toHaveLength(1);
      expect(tab.community.setupAfterLogin([])).toBe(first);
      release();
      await first;
      expect((await tab.community.getOwnCommunities())[0].title).toBe('New title');
    } finally { release(); await first; spy.mockRestore(); vi.useRealTimers(); }
  });

  it('allows a fresh merge after an actual failed read without clearing cached communities', async () => {
    installBrowserEnv(); installFakeIdb();
    const tab = await openTab();
    await tab.community.setupAfterLogin([communityFixture()]);
    const { default: uniques } = await import('data/databases/unique');
    const spy = vi.spyOn(uniques.uniques, 'get').mockRejectedValueOnce(new Error('Injected read failure'));
    await expect(tab.community.setupAfterLogin([])).rejects.toThrow('Injected read failure');
    spy.mockRestore();
    expect(await tab.community.getOwnCommunities()).toHaveLength(1);
    await tab.community.setupAfterLogin([communityFixture({ title: 'Recovered', updatedAt: T(3) })]);
    expect((await tab.community.getOwnCommunities())[0].title).toBe('Recovered');
  });
});
