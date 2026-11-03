// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { afterEach, describe, expect, it, vi } from 'vitest';
import { installFakeIdb } from 'test/fakeIdb';
import { useDataLayerFakeTimers } from 'test/timers';
import {
  deleteObsoleteDatabases,
  isObsoleteDatabase,
  OBSOLETE_DATABASE_DELETE_TIMEOUT_MS,
} from './obsoleteDatabases';

const CHUNKED = 'commonGroundDB_chunked_databases';
const MESSAGES = 'commonGroundDB_messages';

/** creates a database with one object store; closed unless `keepOpen` */
function createDb(factory: IDBFactory, name: string, keepOpen = false): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = factory.open(name, 1);
    request.onupgradeneeded = () => request.result.createObjectStore('items');
    request.onsuccess = () => {
      if (!keepOpen) request.result.close();
      resolve(request.result);
    };
    request.onerror = () => reject(request.error);
  });
}

async function names(factory: IDBFactory): Promise<string[]> {
  return (await factory.databases()).map(d => d.name!).sort();
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe('isObsoleteDatabase', () => {
  it('matches the removed caches only', () => {
    expect(isObsoleteDatabase(CHUNKED)).toBe(true);
    expect(isObsoleteDatabase(MESSAGES)).toBe(true);
    expect(isObsoleteDatabase('commonGroundDB_chunked_channel-1')).toBe(true);
    for (const kept of ['commonGroundDB_communities', 'commonGroundDB_chat', 'commonGroundDB_users', 'commonGroundDB_uniques', 'commonGroundDB_signedUrl', 'commonGroundDB_articles', 'other_messages']) {
      expect(isObsoleteDatabase(kept)).toBe(false);
    }
  });
});

describe('deleteObsoleteDatabases', () => {
  it('deletes the removed caches and keeps the entity databases', async () => {
    const idb = installFakeIdb();
    for (const name of [CHUNKED, MESSAGES, 'commonGroundDB_chunked_old', 'commonGroundDB_communities', 'commonGroundDB_users']) {
      await createDb(idb.factory, name);
    }
    const forgotten: string[] = [];
    const result = await deleteObsoleteDatabases({ indexedDB: idb.factory, forget: n => forgotten.push(n) });
    expect(await names(idb.factory)).toEqual(['commonGroundDB_communities', 'commonGroundDB_users']);
    expect(result).toEqual({ [CHUNKED]: 'deleted', [MESSAGES]: 'deleted', commonGroundDB_chunked_old: 'deleted' });
    expect(forgotten.sort()).toEqual([CHUNKED, MESSAGES, 'commonGroundDB_chunked_old'].sort());
  });

  it('is idempotent: nothing there, nothing fails', async () => {
    const idb = installFakeIdb();
    await expect(deleteObsoleteDatabases({ indexedDB: idb.factory })).resolves.toEqual({ [CHUNKED]: 'deleted', [MESSAGES]: 'deleted' });
    await expect(deleteObsoleteDatabases({ indexedDB: idb.factory })).resolves.toEqual({ [CHUNKED]: 'deleted', [MESSAGES]: 'deleted' });
  });

  it('also deletes obsolete names known to the tracker when databases() is missing', async () => {
    const idb = installFakeIdb();
    await createDb(idb.factory, 'commonGroundDB_chunked_v1');
    const factory = new Proxy(idb.factory, {
      get: (target, prop) => (prop === 'databases' ? undefined : Reflect.get(target, prop, target)),
    }) as IDBFactory;
    const result = await deleteObsoleteDatabases({
      indexedDB: factory,
      knownNames: () => ['commonGroundDB_chunked_v1', 'commonGroundDB_communities'],
    });
    expect(Object.keys(result).sort()).toEqual([CHUNKED, MESSAGES, 'commonGroundDB_chunked_v1'].sort());
    expect(await names(idb.factory)).toEqual([]);
  });

  it('a delete blocked by an open connection does not hang and is not forgotten', async () => {
    const idb = installFakeIdb();
    // an old page that keeps the chunked cache open and ignores versionchange
    const open = await createDb(idb.factory, CHUNKED, true);
    open.onversionchange = () => undefined;
    const forget = vi.fn();
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const result = await deleteObsoleteDatabases({ indexedDB: idb.factory, forget });
    expect(result[CHUNKED]).toBe('blocked');
    expect(result[MESSAGES]).toBe('deleted');
    expect(forget).toHaveBeenCalledTimes(1);
    expect(forget).toHaveBeenCalledWith(MESSAGES);
    // the browser finishes the delete once the old page lets go
    open.close();
    await vi.waitFor(async () => expect(await names(idb.factory)).toEqual([]));
  });

  it('a request that never answers times out instead of hanging', async () => {
    useDataLayerFakeTimers();
    const silent = { onsuccess: null, onerror: null, onblocked: null };
    const factory = {
      deleteDatabase: () => silent,
      databases: async () => [],
    } as unknown as IDBFactory;
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const p = deleteObsoleteDatabases({ indexedDB: factory });
    await vi.advanceTimersByTimeAsync(OBSOLETE_DATABASE_DELETE_TIMEOUT_MS);
    await expect(p).resolves.toEqual({ [CHUNKED]: 'timeout', [MESSAGES]: 'timeout' });
  });

  it('never rejects: errors of the factory are swallowed and logged', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const throwing = {
      deleteDatabase: () => { throw new Error('SecurityError'); },
      databases: async () => { throw new Error('not allowed'); },
    } as unknown as IDBFactory;
    await expect(deleteObsoleteDatabases({
      indexedDB: throwing,
      knownNames: () => { throw new Error('bad localStorage'); },
      forget: () => { throw new Error('unreachable'); },
    })).resolves.toEqual({ [CHUNKED]: 'error', [MESSAGES]: 'error' });
    expect(warn).toHaveBeenCalled();
  });

  it('does nothing without IndexedDB', async () => {
    vi.stubGlobal('indexedDB', undefined);
    await expect(deleteObsoleteDatabases()).resolves.toEqual({});
    vi.unstubAllGlobals();
  });
});
