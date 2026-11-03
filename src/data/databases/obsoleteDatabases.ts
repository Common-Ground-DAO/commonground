// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Deletes the IndexedDB databases of client caches that no longer exist:
 * the chunked message/notification cache (`<prefix>_chunked_databases`, and
 * per-name `<prefix>_chunked_*` databases of even older builds) and the
 * legacy message cache (`<prefix>_messages`). Messages and notifications are
 * memory + server only now (data/chat); there is nothing to migrate.
 *
 * Fire-and-forget: connectionManager runs it once per page,
 * OBSOLETE_DATABASE_CLEANUP_DELAY_MS after startup; nothing waits for it. Deleting is idempotent, so every tab
 * may run it. A delete that is `blocked` (an old page still has the database
 * open) is not waited for: the browser finishes it once that page closes it.
 */

import config from "common/config";

/** fixed names of the removed caches */
export const OBSOLETE_DATABASE_NAMES: readonly string[] = [
  `${config.IDB_PREFIX}_chunked_databases`,
  `${config.IDB_PREFIX}_messages`,
];
/** every database of the chunked cache, of any build */
export const OBSOLETE_DATABASE_PREFIX = `${config.IDB_PREFIX}_chunked_`;
/** after startup, so the page's own work comes first and old pages had time to reload */
export const OBSOLETE_DATABASE_CLEANUP_DELAY_MS = 10_000;
/** a request that reports nothing in this time is left to the browser */
export const OBSOLETE_DATABASE_DELETE_TIMEOUT_MS = 10_000;

export function isObsoleteDatabase(name: string): boolean {
  return OBSOLETE_DATABASE_NAMES.includes(name) || name.startsWith(OBSOLETE_DATABASE_PREFIX);
}

export type DeleteOutcome = 'deleted' | 'blocked' | 'error' | 'timeout';

export type ObsoleteDatabaseCleanupDeps = {
  indexedDB?: IDBFactory;
  /** names the app registered before (dbTracker); obsolete ones are deleted too */
  knownNames?: () => Iterable<string>;
  /** called for each name whose delete succeeded */
  forget?: (name: string) => void;
  timeoutMs?: number;
};

function deleteOne(factory: IDBFactory, name: string, timeoutMs: number): Promise<DeleteOutcome> {
  return new Promise(resolve => {
    let done = false;
    const finish = (outcome: DeleteOutcome) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    const timer = setTimeout(() => finish('timeout'), timeoutMs);
    try {
      const request = factory.deleteDatabase(name);
      request.onsuccess = () => finish('deleted');
      request.onerror = (event) => {
        // handled here: do not let it surface as an unhandled error
        event.preventDefault?.();
        finish('error');
      };
      request.onblocked = () => finish('blocked');
    } catch {
      finish('error');
    }
  });
}

/**
 * Deletes every obsolete database it can find (the fixed names, the known
 * names, and `indexedDB.databases()` where supported). Never rejects;
 * resolves with the outcome per name.
 */
export async function deleteObsoleteDatabases(deps: ObsoleteDatabaseCleanupDeps = {}): Promise<Record<string, DeleteOutcome>> {
  const result: Record<string, DeleteOutcome> = {};
  try {
    const factory = deps.indexedDB ?? globalThis.indexedDB;
    if (!factory) return result;
    const names = new Set<string>(OBSOLETE_DATABASE_NAMES);
    try {
      for (const name of deps.knownNames?.() ?? []) {
        if (isObsoleteDatabase(name)) names.add(name);
      }
    } catch (e) {
      console.warn("Obsolete IndexedDB cleanup: could not read the known databases", e);
    }
    if (typeof factory.databases === 'function') {
      try {
        for (const { name } of await factory.databases()) {
          if (name && isObsoleteDatabase(name)) names.add(name);
        }
      } catch (e) {
        console.warn("Obsolete IndexedDB cleanup: could not list databases", e);
      }
    }
    const timeoutMs = deps.timeoutMs ?? OBSOLETE_DATABASE_DELETE_TIMEOUT_MS;
    await Promise.all([...names].map(async name => {
      const outcome = await deleteOne(factory, name, timeoutMs);
      result[name] = outcome;
      if (outcome === 'deleted') {
        try {
          deps.forget?.(name);
        } catch {
          // bookkeeping only
        }
      } else {
        console.warn(`Obsolete IndexedDB cleanup: ${name}: ${outcome}`);
      }
    }));
  } catch (e) {
    console.warn("Obsolete IndexedDB cleanup failed", e);
  }
  return result;
}
