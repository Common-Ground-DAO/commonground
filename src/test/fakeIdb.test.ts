// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
import { Dexie, liveQuery, type DexieOptions, type EntityTable } from 'dexie';
import { installFakeIdb } from './fakeIdb';
import { flushMicrotasks } from './deferred';
import { flushLiveQueries, useDataLayerFakeTimers } from './timers';

type Channel = { id: string; lastRead: number };

function openChannels(options: Pick<DexieOptions, 'indexedDB' | 'IDBKeyRange'>) {
  const db = new Dexie('cg_test_channels', options) as Dexie & { channels: EntityTable<Channel, 'id'> };
  db.version(1).stores({ channels: 'id' });
  return db;
}

/** Monotonic read-state writer, the kind of idempotent upsert entity-dbs needs. */
async function markRead(db: ReturnType<typeof openChannels>, id: string, lastRead: number) {
  await db.transaction('rw', db.channels, async () => {
    const current = await db.channels.get(id);
    if (!current || current.lastRead < lastRead) await db.channels.put({ id, lastRead });
  });
}

describe('installFakeIdb', () => {
  it('gives two tabs one shared database', async () => {
    const idb = installFakeIdb();
    const [tabA, tabB] = idb.tabs(2, openChannels);
    await Promise.all([markRead(tabA, 'c1', 5), markRead(tabB, 'c1', 3), markRead(tabB, 'c1', 7), markRead(tabA, 'c1', 6)]);
    expect(await tabA.channels.get('c1')).toEqual({ id: 'c1', lastRead: 7 });
    expect(await tabB.channels.get('c1')).toEqual({ id: 'c1', lastRead: 7 });
    expect(await idb.databaseNames()).toEqual(['cg_test_channels']);
  });

  it('starts every test with an empty factory', async () => {
    const idb = installFakeIdb();
    expect(await idb.databaseNames()).toEqual([]);
    const tab = idb.tab(openChannels);
    expect(await tab.channels.count()).toBe(0);
  });

  it('points Dexie defaults and the globals at the fake, so app code needs no options', async () => {
    const idb = installFakeIdb();
    expect(globalThis.indexedDB).toBe(idb.factory);
    const db = new Dexie('cg_test_plain') as Dexie & { kv: EntityTable<{ k: string }, 'k'> };
    db.version(1).stores({ kv: 'k' });
    await db.kv.put({ k: 'x' });
    expect(await idb.databaseNames()).toContain('cg_test_plain');
    // not created through tab(): uninstall still closes its connection
  });

  it('propagates writes of one tab to a liveQuery in the other', async () => {
    const idb = installFakeIdb();
    const [tabA, tabB] = idb.tabs(2, openChannels);
    const seen: (number | undefined)[] = [];
    const subscription = liveQuery(() => tabB.channels.get('c1').then(c => c?.lastRead)).subscribe(v => seen.push(v));
    await tabB.open();
    await new Promise(resolve => setTimeout(resolve, 20));
    await markRead(tabA, 'c1', 4);
    for (let i = 0; i < 50 && seen[seen.length - 1] !== 4; i++) {
      await new Promise(resolve => setTimeout(resolve, 5));
      await flushMicrotasks();
    }
    subscription.unsubscribe();
    expect(seen[0]).toBeUndefined();
    expect(seen[seen.length - 1]).toBe(4);
  });

  it('restores everything on uninstall', async () => {
    const before = Dexie.dependencies.indexedDB;
    const idb = installFakeIdb();
    await idb.uninstall();
    expect(Dexie.dependencies.indexedDB).toBe(before);
    await expect(installFakeIdb().uninstall()).resolves.toBeUndefined();
  });
});

describe('fake timers', () => {
  it('Dexie keeps working under useDataLayerFakeTimers()', async () => {
    useDataLayerFakeTimers();
    const idb = installFakeIdb();
    const tab = idb.tab(openChannels);
    await markRead(tab, 'c1', 1);
    expect(await tab.channels.get('c1')).toEqual({ id: 'c1', lastRead: 1 });
    expect(vi.isFakeTimers()).toBe(true);
  });

  it('liveQuery emits under useDataLayerFakeTimers() once flushLiveQueries() moves time', async () => {
    useDataLayerFakeTimers();
    const idb = installFakeIdb();
    const tab = idb.tab(openChannels);
    await markRead(tab, 'c1', 1);
    const seen: (number | undefined)[] = [];
    const subscription = liveQuery(() => tab.channels.get('c1').then(c => c?.lastRead)).subscribe(v => seen.push(v));
    for (let i = 0; i < 10; i++) await new Promise<void>(resolve => queueMicrotask(resolve));
    expect(seen).toEqual([]); // the first query waits for setTimeout(…, 0)
    await flushLiveQueries();
    expect(seen).toEqual([1]);
    await markRead(tab, 'c1', 2);
    await flushLiveQueries();
    expect(seen).toEqual([1, 2]);
    subscription.unsubscribe();
  });

  it('a faked setImmediate fails fast instead of hanging', async () => {
    const idb = installFakeIdb();
    vi.useFakeTimers();
    try {
      await expect(idb.tab(openChannels).channels.count()).rejects.toThrow(/useDataLayerFakeTimers/);
    } finally {
      vi.useRealTimers();
    }
  });

  it('restores real timers after the test', () => {
    expect(vi.isFakeTimers()).toBe(false);
  });
});

describe('isolation between tests', () => {
  const leaked: (number | undefined)[] = [];

  it('a test leaves a liveQuery subscribed on a database the app opened itself', async () => {
    installFakeIdb();
    const tab = openChannels({});
    liveQuery(() => tab.channels.get('c1').then(c => c?.lastRead)).subscribe({ next: v => leaked.push(v), error: e => leaked.push(-1 * (e ? 1 : 0)) });
    await markRead(tab, 'c1', 1);
    for (let i = 0; i < 50 && leaked[leaked.length - 1] !== 1; i++) await new Promise(r => setTimeout(r, 5));
    expect(leaked[leaked.length - 1]).toBe(1);
  });

  it('the next test\'s writes to the same database name do not reach it', async () => {
    const seenBefore = leaked.length;
    const idb = installFakeIdb();
    const tab = idb.tab(openChannels);
    await markRead(tab, 'c1', 9);
    await new Promise(r => setTimeout(r, 30));
    expect(leaked.length).toBe(seenBefore);
  });
});
