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
 * Dexie instance on the same factory: two instances of one database name act
 * like two tabs sharing one origin's IndexedDB — separate connections,
 * transactions serialised across them, `versionchange` between them.
 *
 * Fidelity limits of that "two tabs" model (both instances live in one JS
 * realm):
 * - They share one Dexie module state: the global query cache (keyed by
 *   database name) and the `storagemutated` event bus.
 * - liveQuery invalidation reaches the other instance in-process, not via
 *   BroadcastChannel as between real tabs; a test cannot drop or delay it.
 * - Dexie's bfcache handling (close on `pagehide` persisted, reopen on
 *   `pageshow`) is not simulated: it listens on the global object, which the
 *   node environment does not make an event target.
 * Module singletons (`data/databases/community` …) are one per module graph;
 * for a second tab of those, see `importAsNewTab` in `src/test/modules.ts`.
 *
 * Fake timers: fake-indexeddb runs every task through
 * `globalThis.setImmediate`, which a plain `vi.useFakeTimers()` fakes. Use
 * `useDataLayerFakeTimers()` (`src/test/timers.ts`); opening a database or a
 * transaction with a faked `setImmediate` throws instead of hanging.
 */

type TabOptions = Pick<DexieOptions, 'indexedDB' | 'IDBKeyRange'>;

export interface FakeIdb {
  readonly factory: IDBFactory;
  readonly IDBKeyRange: typeof IDBKeyRange;
  /** Options to pass to `new Dexie(name, opts)` explicitly. */
  readonly dexieOptions: TabOptions;
  /**
   * Creates a Dexie instance on this factory (closed on uninstall). `create`
   * receives the options to spread into the Dexie constructor.
   */
  tab<T extends Dexie>(create: (options: TabOptions) => T): T;
  /** `n` instances from the same `create`, e.g. `const [a, b] = idb.tabs(2, mk)`. */
  tabs<T extends Dexie>(n: number, create: (options: TabOptions) => T): T[];
  /** Names of the databases that exist in this factory. */
  databaseNames(): Promise<string[]>;
  /**
   * Drops the liveQuery listeners added since install, closes every Dexie
   * instance and connection, waits for fake-indexeddb's queued tasks, then
   * restores Dexie's and the global dependencies. Runs after each test.
   */
  uninstall(): Promise<void>;
}

// The real one, captured before any test can fake it.
const realSetImmediate = globalThis.setImmediate;

function assertRealSetImmediate(): void {
  if (globalThis.setImmediate !== realSetImmediate) {
    throw new Error(
      'fake-indexeddb needs the real setImmediate, but it is faked (vi.useFakeTimers()). ' +
      'Use useDataLayerFakeTimers() from src/test/timers.ts.',
    );
  }
}

function realTick(): Promise<void> {
  return new Promise(resolve => realSetImmediate(() => resolve()));
}

interface DexieEventContext {
  subscribers: ((...args: unknown[]) => void)[];
  unsubscribe(fn: (...args: unknown[]) => void): void;
}

function storageMutatedEvent(): DexieEventContext | undefined {
  const event = (Dexie.on as unknown as { storagemutated?: DexieEventContext }).storagemutated;
  return event && Array.isArray(event.subscribers) ? event : undefined;
}

let installed: FakeIdb | undefined;

export function installFakeIdb(): FakeIdb {
  if (installed) throw new Error('installFakeIdb: already installed; uninstall it first');

  const factory: IDBFactory = new FakeIDBFactory();
  const connections = new Set<IDBDatabase>();
  const dexies = new Set<Dexie>();
  // liveQuery subscribes here while it is observed; whatever a test adds is
  // dropped on uninstall so it cannot re-query in the next test
  const mutationSubscribersAtInstall = new Set(storageMutatedEvent()?.subscribers ?? []);

  // record every connection so uninstall can close them, including those of
  // Dexie instances the code under test created itself
  const open = factory.open.bind(factory);
  factory.open = (name: string, version?: number) => {
    assertRealSetImmediate();
    const request = open(name, version);
    request.addEventListener('success', () => {
      const connection = request.result;
      connections.add(connection);
      const transaction = connection.transaction.bind(connection);
      connection.transaction = ((...args: Parameters<IDBDatabase['transaction']>) => {
        assertRealSetImmediate();
        return transaction(...args);
      }) as IDBDatabase['transaction'];
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
    async uninstall() {
      if (installed !== handle) return;
      installed = undefined;
      unregister();
      const event = storageMutatedEvent();
      for (const fn of [...(event?.subscribers ?? [])]) {
        if (!mutationSubscribersAtInstall.has(fn)) event!.unsubscribe(fn);
      }
      for (const db of dexies) db.close();
      for (const connection of connections) connection.close();
      // let tasks fake-indexeddb already queued (on the real setImmediate) run
      // against this factory before the next test swaps it
      if (globalThis.setImmediate === realSetImmediate) {
        for (let i = 0; i < 5; i++) await realTick();
      }
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
