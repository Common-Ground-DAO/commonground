// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * A gateway (docs/auth-identity §12) keeps no local data and leaves the data
 * an old page of the app stored on its origin as it is: the entity databases
 * (community, chat, user, signed URLs) are never opened there — no read on
 * start-up, no version-upgrade clear, no registration in CG_KNOWN_INDEXEDDBS,
 * and a direct access to such a database rejects. A normal
 * instance opens them as before. Real database modules on a pre-seeded fake
 * IndexedDB.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { Dexie, type Table } from 'dexie';
import { installBrowserEnv } from 'test/env';
import { installFakeIdb, type FakeIdb } from 'test/fakeIdb';
import { importAsNewTab } from 'test/modules';
import { chatFromApi } from './readStateRows';
import { T, apiMessage, channelFixture, chatFixture, communityFixture, createTabMocks } from './entityDbs.testHarness';

vi.mock('data/api/community', () => ({ default: {} }));
vi.mock('data/api/chat', () => ({ default: {} }));
vi.mock('data/api/user', () => ({ default: {} }));
vi.mock('data/api/file', () => ({ default: {} }));
vi.mock('data/managers/communityManager', () => ({ default: {} }));
vi.mock('data/appstate/login', () => ({ default: {} }));

const PREFIX = 'commonGroundDB';
const KNOWN_DBS_KEY = 'CG_KNOWN_INDEXEDDBS';
const NAMES = {
  communities: `${PREFIX}_communities`,
  chat: `${PREFIX}_chat`,
  users: `${PREFIX}_users`,
  signedUrl: `${PREFIX}_signedUrl`,
};
/** registered by an old page in a build before 0.9.0: a normal page clears community and user tables */
const KNOWN_DBS = JSON.stringify(Object.fromEntries(Object.values(NAMES).map(name => [
  name, { createdInAppVersion: '0.8.0', createdAtTime: Date.UTC(2025, 0, 1) },
])));

const g = globalThis as { __CG_INSTANCE__?: unknown };
afterEach(() => {
  delete g.__CG_INSTANCE__;
});

type Seeded = {
  idb: FakeIdb;
  /** names passed to indexedDB.open / deleteDatabase since the seed */
  opened: string[];
  deleted: string[];
};

/** the data an old page of the app left on this origin */
async function seedOldPage(): Promise<Seeded> {
  installBrowserEnv({ url: 'https://app.test/' });
  const idb = installFakeIdb();
  const communities = idb.tab(o => {
    const d = new Dexie(NAMES.communities, o) as Dexie & { communities: Table; channels: Table; calls: Table };
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
  await communities.communities.put(communityFixture());
  await communities.channels.put(channelFixture({ channelId: 'ch1', unread: 4, lastRead: T(0) }));
  await communities.calls.put({ id: 'call1', communityId: 'com1', channelId: 'callch1' });
  const chats = idb.tab(o => {
    const d = new Dexie(NAMES.chat, o) as Dexie & { chats: Table };
    d.version(2).stores({ chats: '&id,channelId' });
    return d;
  });
  await chats.chats.put(chatFromApi(chatFixture({ id: 'chat1', channelId: 'dm1', unread: 2, lastMessage: apiMessage({ id: 'm', channelId: 'dm1', createdAt: T(2) }) })));
  const users = idb.tab(o => {
    const d = new Dexie(NAMES.users, o) as Dexie & { userData: Table };
    d.version(3).stores({ userData: '&id', status: '&id' });
    return d;
  });
  await users.userData.put({ id: 'u2', displayAccount: 'cg' });
  const signedUrls = idb.tab(o => {
    const d = new Dexie(NAMES.signedUrl, o) as Dexie & { signedUrls: Table };
    d.version(1).stores({ signedUrls: '&objectId,validUntil' });
    return d;
  });
  // stale: a normal page deletes it on start-up
  await signedUrls.signedUrls.put({ objectId: 'f1', url: 'https://s3.test/f1', validUntil: new Date(Date.UTC(2025, 0, 1)) });
  for (const d of [communities, chats, users, signedUrls]) d.close();
  localStorage.setItem(KNOWN_DBS_KEY, KNOWN_DBS);

  const opened: string[] = [];
  const deleted: string[] = [];
  const open = idb.factory.open.bind(idb.factory);
  idb.factory.open = (name: string, version?: number) => {
    opened.push(name);
    return open(name, version);
  };
  const deleteDatabase = idb.factory.deleteDatabase.bind(idb.factory);
  idb.factory.deleteDatabase = (name: string) => {
    deleted.push(name);
    return deleteDatabase(name);
  };
  return { idb, opened, deleted };
}

/** what is in the old page's databases now (read on a connection of the test's own) */
async function snapshot(idb: FakeIdb) {
  const read = async (name: string, version: number, stores: Record<string, string>) => {
    const d = idb.tab(o => {
      const db = new Dexie(name, o);
      db.version(version).stores(stores);
      return db;
    });
    const result: Record<string, number> = {};
    for (const table of d.tables) result[table.name] = await table.count();
    d.close();
    return result;
  };
  return {
    communities: await read(NAMES.communities, 3, {
      communities: '&id,url', areas: '&[communityId+id],id,communityId', channels: '&[communityId+channelId],channelId,communityId',
      roles: '&[communityId+id],[title+type],id,communityId', calls: '&id,communityId', communityListViews: '&id,url',
      communityMembers: '&[communityId+userId],communityId', status: '&id',
    }),
    chat: await read(NAMES.chat, 2, { chats: '&id,channelId' }),
    users: await read(NAMES.users, 3, { userData: '&id', status: '&id' }),
    signedUrl: await read(NAMES.signedUrl, 1, { signedUrls: '&objectId,validUntil' }),
  };
}

const SEEDED = {
  communities: { communities: 1, areas: 0, channels: 1, roles: 0, calls: 1, communityListViews: 0, communityMembers: 0, status: 0 },
  chat: { chats: 1 },
  users: { userData: 1, status: 0 },
  signedUrl: { signedUrls: 1 },
};

/** the four database modules as a page loads them (one module graph) */
async function openPage() {
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
  const registered: string[] = [];
  vi.doMock('data/databases/channel', () => ({
    default: {
      registerAccessForChannel(access: { channelId: string }) {
        registered.push(access.channelId);
      },
      deleteChannelDatabase: async () => {},
      getAccessForChannel: () => undefined,
      applyStoredReadState(states: { channelId: string }[]) {
        for (const state of states) registered.push(state.channelId);
      },
    },
  }));
  vi.doMock('data/appstate/serviceWorker', () => ({ default: { navigate: mocks.navigate } }));
  const [community, chats, user, signedUrls] = await importAsNewTab(() => Promise.all([
    import('data/databases/community'),
    import('data/databases/chats'),
    import('data/databases/user'),
    import('data/databases/signedUrls'),
  ]));
  return {
    mocks,
    registered,
    community: community.default,
    chats: chats.default,
    user: user.default,
    signedUrls: signedUrls.default,
  };
}

/** lets the start-up work of the modules (reads, upgrade clears, deletes) run */
async function settle() {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

describe('the old page data on a gateway origin', () => {
  it('a gateway page neither opens nor registers the entity databases', async () => {
    const seeded = await seedOldPage();
    g.__CG_INSTANCE__ = { deployment: 'prod', appUrl: 'https://app.test', gatewayTargetUrl: 'https://new.test' };
    const page = await openPage();
    await settle();

    expect(seeded.opened).toEqual([]);
    expect(seeded.deleted).toEqual([]);
    expect(localStorage.getItem(KNOWN_DBS_KEY)).toBe(KNOWN_DBS);
    // no stored rows handed to the chat stores, no socket event handlers
    expect(page.registered).toEqual([]);
    expect(page.mocks.handlers.size).toBe(0);
    expect(await snapshot(seeded.idb)).toEqual(SEEDED);
  });

  it('a direct access on a gateway page reads and deletes nothing', async () => {
    const seeded = await seedOldPage();
    g.__CG_INSTANCE__ = { deployment: 'prod', appUrl: 'https://app.test', gatewayTargetUrl: 'https://new.test' };
    const page = await openPage();
    await settle();

    // the database itself cannot be opened (login.ts's _clear does not call
    // the clears on a gateway, login.test.ts)
    await expect(page.chats.clear()).rejects.toBeDefined();
    await expect(page.chats.registerStoredChats()).resolves.toBeUndefined();
    await expect(page.community.registerStoredChannels()).resolves.toBeUndefined();
    await settle();

    expect(seeded.opened).toEqual([]);
    expect(page.registered).toEqual([]);
    expect(await snapshot(seeded.idb)).toEqual(SEEDED);
  });

  it('a normal page opens them as before: stored rows read, old tables cleared, stale URLs deleted', async () => {
    const seeded = await seedOldPage();
    const page = await openPage();
    await settle();
    await page.community.registerStoredChannels();
    await settle();

    expect([...new Set(seeded.opened)].sort()).toEqual(Object.values(NAMES).sort());
    expect(page.mocks.handlers.has('cliCommunityEvent')).toBe(true);
    // the stored DM was handed to the chat stores on start-up
    expect(page.registered).toContain('dm1');
    // registered in this build, and the 0.8.0 community and user tables cleared
    const known = JSON.parse(localStorage.getItem(KNOWN_DBS_KEY)!);
    expect(known[NAMES.communities].createdInAppVersion).not.toBe('0.8.0');
    const after = await snapshot(seeded.idb);
    expect(after.communities).toMatchObject({ communities: 0, channels: 0, calls: 0, status: 1 });
    expect(after.users).toEqual({ userData: 0, status: 1 });
    expect(after.chat).toEqual({ chats: 1 });
    expect(after.signedUrl).toEqual({ signedUrls: 0 });
  });
});
