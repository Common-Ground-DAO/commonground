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
 * Server snapshots (login data, detail-view fetches) are guarded the same
 * way only for areas, roles, channels and calls, whose stamps come from the
 * database (`bulkPutUnlessNewer`). Communities and list views are not: some
 * community events are stamped with the API process clock instead of the
 * row's `updatedAt`, so a later, correct snapshot can carry an older
 * `updatedAt` than a stored event stamp. Snapshots never delete rows an
 * event wrote after their request started (`LocalWriteStamp`). Read state
 * is merged separately (`readStateRows.ts`).
 *
 * Accepted narrow window: a partial event skipped as older loses the fields
 * only it carries (no per-field stamps), and an API-clock stamp ahead of the
 * database clock can make a newer database-stamped event look older. Both
 * last until the next snapshot of that community (detail-view refresh or
 * login), which is authoritative for community fields.
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

/** the stored row if it is strictly newer by updatedAt, else the incoming one */
export function newerRow<T>(stored: T | undefined, incoming: T): T {
  return stored !== undefined && isOlderThanStored(stored, incoming) ? stored : incoming;
}

/**
 * Client-clock time (ms) at which an event writer (not a snapshot) stored
 * the row. Snapshot writers do not delete rows written after their request
 * started: those may be newer than the snapshot. A plain non-indexed field.
 */
export type LocalWriteStamp = { localWrittenAt?: number };

/**
 * Request start assumed for a snapshot whose caller does not pass one:
 * rows an event wrote in this window before the merge are kept even if the
 * snapshot lacks them (they are deleted by the next snapshot if still gone).
 */
export const SNAPSHOT_REQUEST_MARGIN_MS = 60_000;

export function snapshotRequestStart(requestStartedAt?: number): number {
  return requestStartedAt ?? Date.now() - SNAPSHOT_REQUEST_MARGIN_MS;
}

/** may a snapshot taken at `requestStartedAt` delete this row? */
export function deletableBySnapshot(row: unknown, requestStartedAt: number): boolean {
  const stamp = (row as LocalWriteStamp | undefined)?.localWrittenAt;
  return typeof stamp !== 'number' || stamp < requestStartedAt;
}

export function withLocalWriteStamp<T>(row: T): T & LocalWriteStamp {
  return { ...row, localWrittenAt: Date.now() };
}

/**
 * Snapshot `bulkPut` that keeps stored rows with a newer updatedAt. Call
 * inside a rw transaction on `table`; only for tables whose updatedAt stamps
 * come from the database (areas, roles, channels, calls).
 */
export async function bulkPutUnlessNewer<T, K extends IndexableType>(table: Table<T, K>, rows: T[], keyOf: (row: T) => NoInfer<K>): Promise<void> {
  if (rows.length === 0) return;
  const stored = await table.bulkGet(rows.map(keyOf));
  await table.bulkPut(rows.map((row, i) => newerRow(stored[i], row)));
}

/**
 * Snapshot `bulkDelete` that keeps rows an event wrote after the snapshot's
 * request started. Call inside a rw transaction on `table`. Resolves to the
 * keys it deleted.
 */
export async function bulkDeleteUnlessNewer<T, K extends IndexableType>(table: Table<T, K>, keys: NoInfer<K>[], requestStartedAt: number): Promise<K[]> {
  if (keys.length === 0) return [];
  const stored = await table.bulkGet(keys);
  const deletable = keys.filter((_, i) => stored[i] !== undefined && deletableBySnapshot(stored[i], requestStartedAt));
  await table.bulkDelete(deletable);
  return deletable;
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