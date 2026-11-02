// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Cross-tab behaviour of the shared entity databases (community, chat,
 * user): two module graphs (importAsNewTab) on one fake IndexedDB act as two
 * tabs that both process the same socket events.
 */

import { describe, expect, it, vi } from 'vitest';
import { installBrowserEnv } from 'test/env';
import { installFakeIdb } from 'test/fakeIdb';
import { importAsNewTab } from 'test/modules';
import {
  T,
  channelFixture,
  communityFixture,
  createTabMocks,
  emit,
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
        mocks.registeredLastRead.set(access.channelId, data?.lastRead);
      },
      setInitialChannelLastRead() {
        throw new Error('entity dbs must not move the in-memory lastRead backwards');
      },
      deleteChannelDatabase: async () => {},
      getAccessForChannel: () => undefined,
    },
  }));
  vi.doMock('data/appstate/serviceWorker', () => ({ default: { navigate: mocks.navigate } }));
  const [community, chats, user] = await importAsNewTab(() => Promise.all([
    import('data/databases/community'),
    import('data/databases/chats'),
    import('data/databases/user'),
  ]));
  return { ...mocks, community: community.default, chats: chats.default, user: user.default };
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
