// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Typing-indicator lookups: channel permissions are cached per community and
 * channel, and the channel of an access object is checked against its scope.
 * The LISTEN connection that drops cached entries on permission changes is
 * set up again when the database closes it.
 */

import { EventEmitter } from 'events';

const getCommunityChannelRolePermissions = jest.fn();
const isChannelInAccessScope = jest.fn();
const poolConnect = jest.fn();

jest.mock('../util/postgres', () => ({ __esModule: true, default: { connect: (...args: any[]) => poolConnect(...args) } }));
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

/** a held pool connection: LISTEN and the keepalive go through `query` */
class FakeListenClient extends EventEmitter {
  queries: string[] = [];
  released: unknown[] = [];
  failQueries?: Error;
  /** runs inside `query` before it answers (e.g. emits the connection's `error`) */
  duringQuery?: (sql: string) => void;
  async query(sql: string) {
    this.queries.push(sql);
    this.duringQuery?.(sql);
    if (this.failQueries) throw this.failQueries;
    return { rows: [] };
  }
  release(error?: unknown) {
    this.released.push(error ?? 'returned');
  }
}

describe('LISTEN connection', () => {
  const LISTENS = ['LISTEN channelrolepermissionchange', 'LISTEN rolechange'];
  let fresh: typeof typingCache;
  let errorLog: jest.SpyInstance;

  beforeEach(() => {
    jest.useFakeTimers();
    errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    // a module of its own per test: whether it listens is module state
    jest.isolateModules(() => {
      fresh = require('../repositories/typingCache');
    });
  });
  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    errorLog.mockRestore();
  });

  /** connections the pool hands out, in order; `null` = the database refuses */
  function connections(...clients: (FakeListenClient | null)[]) {
    for (const client of clients) {
      poolConnect.mockImplementationOnce(async () => {
        if (!client) throw new Error('connect ECONNREFUSED');
        return client;
      });
    }
  }

  async function cachedLookups(): Promise<number> {
    getCommunityChannelRolePermissions.mockResolvedValue([]);
    await fresh.getChannelTypingPerms(COMMUNITY_A, CHANNEL);
    return getCommunityChannelRolePermissions.mock.calls.length;
  }

  it('a failing connection is given up and LISTEN set up again on a new one; the cached channels are dropped', async () => {
    const first = new FakeListenClient();
    const second = new FakeListenClient();
    connections(first, second);
    await fresh.initTypingCacheInvalidation();
    expect(first.queries).toEqual(LISTENS);
    expect(await cachedLookups()).toBe(1);
    expect(await cachedLookups()).toBe(1);

    // the database restarted: the connection's error event, not the process's end
    expect(() => first.emit('error', new Error('terminating connection due to administrator command'))).not.toThrow();
    expect(first.released).toEqual([true]);
    expect(await cachedLookups()).toBe(2);
    // cached again while nobody listens
    expect(await cachedLookups()).toBe(2);

    await jest.advanceTimersByTimeAsync(fresh.RELISTEN_DELAY_MS);
    expect(poolConnect).toHaveBeenCalledTimes(2);
    expect(second.queries).toEqual(LISTENS);
    // listening again: what was cached during the gap may have missed a notification
    expect(await cachedLookups()).toBe(3);
    expect(await cachedLookups()).toBe(3);
    // notifications arrive over the new connection, not the old one
    first.emit('notification', { payload: JSON.stringify({ type: 'rolechange' }) });
    expect(await cachedLookups()).toBe(3);
    second.emit('notification', { payload: JSON.stringify({ type: 'channelrolepermissionchange', channelId: CHANNEL }) });
    expect(await cachedLookups()).toBe(4);
    // one error listener on the live connection, none left on the dead one but its own
    expect(second.listenerCount('error')).toBe(1);
  });

  it('a failing keepalive is a lost connection as well', async () => {
    const first = new FakeListenClient();
    const second = new FakeListenClient();
    connections(first, second);
    await fresh.initTypingCacheInvalidation();
    first.failQueries = new Error('Connection terminated unexpectedly');
    await jest.advanceTimersByTimeAsync(60_000);
    expect(first.released).toEqual([true]);
    await jest.advanceTimersByTimeAsync(fresh.RELISTEN_DELAY_MS);
    expect(second.queries).toEqual(LISTENS);
    // one loss, one new connection: a later error of the old one changes nothing
    first.emit('error', new Error('again'));
    await jest.advanceTimersByTimeAsync(fresh.RELISTEN_MAX_DELAY_MS);
    expect(poolConnect).toHaveBeenCalledTimes(2);
  });

  it('a connection that dies during the setup: its error events are taken, it is released, the next one listens', async () => {
    const dying = new FakeListenClient();
    const next = new FakeListenClient();
    // between the two LISTENs: the error event, then the next query fails (twice: pg can emit it twice)
    dying.duringQuery = (sql) => {
      if (sql === 'LISTEN rolechange') {
        dying.emit('error', new Error('terminating connection due to administrator command'));
        dying.emit('error', new Error('Connection terminated unexpectedly'));
        dying.failQueries = new Error('Client has encountered a connection error and is not queryable');
      }
    };
    connections(dying, next);
    const started = fresh.initTypingCacheInvalidation();
    await jest.advanceTimersByTimeAsync(fresh.RELISTEN_DELAY_MS);
    await started;
    expect(dying.released).toEqual([true]);
    // a late error of the dead connection still has a listener
    expect(() => dying.emit('error', new Error('late'))).not.toThrow();
    expect(next.queries).toEqual(LISTENS);
    expect(next.listenerCount('error')).toBe(1);
    expect(poolConnect).toHaveBeenCalledTimes(2);
  });

  it('a connection that fails right after its setup is a lost connection at once', async () => {
    const flaky = new FakeListenClient();
    const next = new FakeListenClient();
    // the error event during the last LISTEN, which still answers
    flaky.duringQuery = (sql) => {
      if (sql === 'LISTEN rolechange') flaky.emit('error', new Error('terminating connection'));
    };
    connections(flaky, next);
    await fresh.initTypingCacheInvalidation();
    expect(flaky.released).toEqual([true]);
    expect(flaky.listenerCount('notification')).toBe(0);
    await jest.advanceTimersByTimeAsync(fresh.RELISTEN_DELAY_MS);
    expect(next.queries).toEqual(LISTENS);
  });

  it('after a loss it keeps trying while the database is down, with a growing delay', async () => {
    const first = new FakeListenClient();
    const later = new FakeListenClient();
    connections(first, null, null, null, null, null, null, null, null, null, null, null, later);
    await fresh.initTypingCacheInvalidation();
    first.emit('error', new Error('terminating connection'));
    // more attempts than a fixed budget would allow, with the delay capped
    await jest.advanceTimersByTimeAsync(12 * fresh.RELISTEN_MAX_DELAY_MS);
    expect(poolConnect).toHaveBeenCalledTimes(13);
    expect(later.queries.slice(0, 2)).toEqual(LISTENS);
  });

  it('at start-up it keeps trying until the database accepts connections', async () => {
    const later = new FakeListenClient();
    connections(null, null, null, null, null, null, null, null, null, null, null, later);
    const started = fresh.initTypingCacheInvalidation();
    await jest.advanceTimersByTimeAsync(12 * fresh.RELISTEN_MAX_DELAY_MS);
    await started;
    expect(poolConnect).toHaveBeenCalledTimes(12);
    expect(later.queries.slice(0, 2)).toEqual(LISTENS);
  });
});
