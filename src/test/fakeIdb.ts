// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Dexie, type DexieOptions } from 'dexie';
import { IDBFactory as FakeIDBFactory, IDBKeyRange as FakeIDBKeyRange } from 'fake-indexeddb';
import { registerTeardown } from './cleanup';

/**
 * A fresh, empty fake-indexeddb per test, wired into Dexie.
 *
 * `installFakeIdb()` points `Dexie.dependencies` (what `new Dexie(name)`
 * without options uses — all app databases are built that way) and the
 * globals `indexedDB`/`IDBKeyRange` at a new factory. `tab()` opens an extra
 * Dexie instance on the same factory: two instances of one database name
 * behave like two browser tabs sharing one origin's IndexedDB (separate
 * connections, `versionchange` between them, Dexie's in-process liveQuery
 * propagation). Everything is closed and restored after the test.
 *
 * Module singletons (`data/databases/community` …) are one per module graph;
 * for a second tab of those, see `importAsNewTab` in `src/test/modules.ts`.
 */

export interface FakeIdb {
  readonly factory: IDBFactory;
  readonly IDBKeyRange: typeof IDBKeyRange;
  /** Options to pass to `new Dexie(name, opts)` explicitly. */
  readonly dexieOptions: Pick<DexieOptions, 'indexedDB' | 'IDBKeyRange'>;
  /**
   * Creates a Dexie instance on this factory (closed on uninstall). `create`
   * receives the options to spread into the Dexie constructor.
   */
  tab<T extends Dexie>(create: (options: Pick<DexieOptions, 'indexedDB' | 'IDBKeyRange'>) => T): T;
  /** `n` instances from the same `create`, e.g. `const [a, b] = idb.tabs(2, mk)`. */
  tabs<T extends Dexie>(n: number, create: (options: Pick<DexieOptions, 'indexedDB' | 'IDBKeyRange'>) => T): T[];
  /** Names of the databases that exist in this factory. */
  databaseNames(): Promise<string[]>;
  /** Closes every connection, restores Dexie's and the global dependencies. */
  uninstall(): void;
}

let installed: FakeIdb | undefined;

export function installFakeIdb(): FakeIdb {
  if (installed) throw new Error('installFakeIdb: already installed; uninstall it first');

  const factory: IDBFactory = new FakeIDBFactory();
  const connections = new Set<IDBDatabase>();
  const dexies = new Set<Dexie>();

  // record every connection so uninstall can close them, including those of
  // Dexie instances the code under test created itself
  const open = factory.open.bind(factory);
  factory.open = (name: string, version?: number) => {
    const request = open(name, version);
    request.addEventListener('success', () => {
      connections.add(request.result);
    });
    return request;
  };

  const dexieOptions = { indexedDB: factory, IDBKeyRange: FakeIDBKeyRange };
  const g = globalThis as Record<string, unknown>;
  const saved = {
    deps: { ...Dexie.dependencies },
    indexedDB: Object.getOwnPropertyDescriptor(globalThis, 'indexedDB'),
    IDBKeyRange: Object.getOwnPropertyDescriptor(globalThis, 'IDBKeyRange'),
  };
  Dexie.dependencies.indexedDB = factory;
  Dexie.dependencies.IDBKeyRange = FakeIDBKeyRange;
  Object.defineProperty(globalThis, 'indexedDB', { value: factory, configurable: true, writable: true });
  Object.defineProperty(globalThis, 'IDBKeyRange', { value: FakeIDBKeyRange, configurable: true, writable: true });

  const handle: FakeIdb = {
    factory,
    IDBKeyRange: FakeIDBKeyRange,
    dexieOptions,
    tab(create) {
      const db = create(dexieOptions);
      dexies.add(db);
      return db;
    },
    tabs(n, create) {
      return Array.from({ length: n }, () => handle.tab(create));
    },
    async databaseNames() {
      return (await factory.databases()).map(d => d.name!).filter(Boolean).sort();
    },
    uninstall() {
      if (installed !== handle) return;
      installed = undefined;
      unregister();
      for (const db of dexies) db.close();
      for (const connection of connections) connection.close();
      Dexie.dependencies.indexedDB = saved.deps.indexedDB;
      Dexie.dependencies.IDBKeyRange = saved.deps.IDBKeyRange;
      for (const key of ['indexedDB', 'IDBKeyRange'] as const) {
        const descriptor = saved[key];
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete g[key];
      }
      // Dexie's global query cache is keyed by database name, not factory:
      // drop it so the next test's fresh factory cannot see old entries.
      const cache = (Dexie as unknown as { cache?: Record<string, unknown> }).cache;
      if (cache) for (const key of Object.keys(cache)) delete cache[key];
    },
  };
  installed = handle;
  const unregister = registerTeardown(handle.uninstall);
  return handle;
}
