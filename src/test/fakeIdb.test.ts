// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import { Dexie, liveQuery, type DexieOptions, type EntityTable } from 'dexie';
import { installFakeIdb } from './fakeIdb';
import { flushMicrotasks } from './deferred';

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

  it('restores everything on uninstall', () => {
    const before = Dexie.dependencies.indexedDB;
    const idb = installFakeIdb();
    idb.uninstall();
    expect(Dexie.dependencies.indexedDB).toBe(before);
    expect(() => installFakeIdb().uninstall()).not.toThrow();
  });
});
