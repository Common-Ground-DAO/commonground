// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import config from "common/config";
import { Dexie, type IndexableType, type Table } from "dexie";
import dbTracker from "./dbTracker";

export type IdbSetupInfo = {
  idbName: string;
  createdAt: Date;
  createdInOldAppVersion: boolean;
  createdInAppVersion: string;
};

/*
 * Writers of the shared entity databases (community, chat, user) run in every
 * tab that processes socket events, so the same event can be applied several
 * times and in a different order than the server sent it (a throttled or
 * frozen tab catches up late). The helpers below make the event writers
 * order-safe: an event whose `updatedAt` is older than the stored row's is
 * skipped. Rows or payloads without a parsable `updatedAt` cannot be ordered
 * and are applied as before.
 *
 * Server snapshots (login data, detail-view fetches) are NOT guarded this
 * way: some community events are stamped with the API process clock instead
 * of the row's `updatedAt`, so a later, correct snapshot can carry an older
 * `updatedAt` than a stored event stamp. Snapshots stay authoritative for
 * entity fields; read state is merged separately (`readStateRows.ts`).
 */

function updatedAtMs(row: unknown): number | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const value = (row as { updatedAt?: unknown }).updatedAt;
  if (value instanceof Date) return value.getTime();
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? undefined : ms;
}

/** true if both carry a parsable `updatedAt` and the incoming one is older */
export function isOlderThanStored(stored: unknown, incoming: unknown): boolean {
  const storedMs = updatedAtMs(stored);
  const incomingMs = updatedAtMs(incoming);
  return storedMs !== undefined && incomingMs !== undefined && incomingMs < storedMs;
}

/**
 * `put` unless the stored row is newer (one rw transaction). Resolves to
 * whether it wrote.
 */
export function guardedPut<T, K extends IndexableType>(db: Dexie, table: Table<T, K>, key: NoInfer<K>, row: T): Promise<boolean> {
  return db.transaction('rw', table, async () => {
    const stored = await table.get(key);
    if (stored !== undefined && isOlderThanStored(stored, row)) return false;
    await table.put(row);
    return true;
  });
}

/**
 * `update` of an existing row unless it is newer than the changes (one rw
 * transaction). Resolves to whether it wrote.
 */
export function guardedUpdate<T, K extends IndexableType>(db: Dexie, table: Table<T, K>, key: NoInfer<K>, changes: Partial<T>): Promise<boolean> {
  return db.transaction('rw', table, async () => {
    const stored = await table.get(key);
    if (stored === undefined || isOlderThanStored(stored, changes)) return false;
    await table.update(key, changes as any);
    return true;
  });
}

export default class AbstractDatabase<T extends {
  [name: string]: Dexie.Table
}, V extends string = ''> {
  protected db: Dexie & T;
  protected lastKnownConnectionTime?: number;
  private retrievalData: {
    [key in V]: {
      valuesForNextRetrieval: Set<string>;
      valuesCurrentlyInRetrieval: Set<string>;
      activeRetrievalTimeout?: any;
      nextRetrieval?: {
        promise: Promise<void>;
        resolve: () => void;
        reject: (e: any) => void;
      };
    }
  } = {} as any;
  protected debounceRetrievalPeriod = 200;

  constructor(dbName: string) {
    const __dbName = `${config.IDB_PREFIX}_${dbName}`;
    this.db = new Dexie(__dbName, { cache: 'immutable' }) as any;
    const registrationData = dbTracker.registerDatabase(__dbName);

    this.setUpDb({ ...registrationData, idbName: __dbName });
    this.setUpHandlers();
  }

  protected setUpDb(info: IdbSetupInfo): void {
    throw new Error('Needs to be implemented by subclass');
  }

  protected setUpHandlers(): void {
    throw new Error('Needs to be implemented by subclass');
  }

  protected onConnectionLoss(lastKnownConnectionTime: number) {
    throw new Error('Needs to be implemented by subclass');
  }

  protected onConnectionRestored() {
    throw new Error('Needs to be implemented by subclass');
  }

  private renewRetrievalPromise(key: V) {
    const o = {} as {
      promise: Promise<void>;
      resolve: () => void;
      reject: (e: any) => void;
    };
    const promise = new Promise<void>((resolve, reject) => {
      o.resolve = resolve;
      o.reject = reject;
    });
    o.promise = promise;
    this.retrievalData[key].nextRetrieval = o;
  }

  protected scheduleRetrieval(key: V, ids: string[]) {
    if (!this.retrievalData[key]) {
      this.retrievalData[key] = {
        valuesForNextRetrieval: new Set<string>(),
        valuesCurrentlyInRetrieval: new Set<string>(),
      }
    }
    const data = this.retrievalData[key];
    for (const id of ids) {
      data.valuesForNextRetrieval.add(id);
    }
    if (!data.activeRetrievalTimeout && data.valuesForNextRetrieval.size > 0) {
      this.renewRetrievalPromise(key);

      const retrieve = async () => {
        const time = Date.now();
        try {
          await this._retrieveMissing(key);
          data.nextRetrieval?.resolve();
        } catch (e) {
          data.nextRetrieval?.reject(e);
          delete data.activeRetrievalTimeout;
          throw e;
        }
        const duration = Date.now() - time;
        if (data.valuesForNextRetrieval.size > 0) {
          this.renewRetrievalPromise(key);
          data.activeRetrievalTimeout = setTimeout(retrieve, Math.max(this.debounceRetrievalPeriod - duration, 0));
        } else {
          delete data.nextRetrieval;
          delete data.activeRetrievalTimeout;
        }
      }
      data.activeRetrievalTimeout = setTimeout(retrieve, this.debounceRetrievalPeriod);
    }
  }

  protected async awaitNextRetrieval(key: V) {
    const data = this.retrievalData[key];
    if (!!data && !!data.nextRetrieval) {
      await data.nextRetrieval;
    }
  }

  private async _retrieveMissing(key: V) {
    const data = this.retrievalData[key];
    const valuesToRetrieve = data.valuesForNextRetrieval;
    data.valuesForNextRetrieval = new Set();
    // only user ids that are not already in retrieval
    const values = Array.from(valuesToRetrieve).filter(v => !data.valuesCurrentlyInRetrieval.has(v));
    for (const v of values) {
      data.valuesCurrentlyInRetrieval.add(v);
    }
    try {
      await this.retrieveMissing(key, values);
    } catch (e) {
      throw e;
    } finally {
      for (const id of values) {
        data.valuesCurrentlyInRetrieval.delete(id);
      }
    }
  }

  /**
   * This function should retrieve the items defined by key + values,
   * e.g. retrieveMissing('signedUrls', [<...values>]), and add them to
   * the correct dexie database.
   * @param key 
   * @param values 
   */
  protected retrieveMissing(key: V, values: string[]): Promise<void> {
    throw new Error('Needs to be implemented by subclass');
  }
}