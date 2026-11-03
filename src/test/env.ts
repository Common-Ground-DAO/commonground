// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { registerTeardown } from './cleanup';

/**
 * A browser-ish environment for the `node` test environment: just the parts of
 * `window`/`document`/`navigator` that the data layer listens to (page
 * visibility, page lifecycle, connectivity, storage, Web Locks,
 * BroadcastChannel), driven explicitly by the test. Deliberately not jsdom:
 * no DOM tree, no layout, near-zero startup cost.
 *
 * Event targets follow the specs: `visibilitychange`, `freeze` and `resume`
 * fire at `document`; `pagehide`, `pageshow`, `online`, `offline` and
 * `storage` fire at `window`. Window-level capture listeners for document
 * events are not simulated — listen where the spec fires.
 */

export type LocksMode = 'shared' | 'isolated' | 'real';

export interface BrowserEnvOptions {
  /** Initial page visibility (default `visible`). */
  visibilityState?: DocumentVisibilityState;
  /** Initial `navigator.onLine` (default `true`). */
  onLine?: boolean;
  /** `window.location` (default `http://localhost:3000/`). */
  url?: string;
  /**
   * `navigator.locks`:
   * - `shared` (default): this env's client view of the per-test shared
   *   `FakeLockManager` (`sharedLockManager()`), so several envs (tabs)
   *   contend for the same locks. Reset after every test.
   * - `isolated`: a client view of a manager of its own.
   * - `real`: Node's LockManager — process-wide, cannot be reset or released
   *   per tab; a lock a test never releases stays held for the whole file.
   */
  locks?: LocksMode;
  /**
   * `installBrowserEnv` only: keep the globals installed after the current
   * test instead of tearing them down automatically. Use it when modules read
   * `window`/`document` at import time; call `env.reset()` per test and
   * `env.uninstall()` in `afterAll`.
   */
  persistent?: boolean;
}

/** In-memory `Storage` (localStorage/sessionStorage). */
export class MemoryStorage implements Storage {
  [name: string]: unknown;
  #items = new Map<string, string>();

  get length(): number {
    return this.#items.size;
  }
  key(index: number): string | null {
    return [...this.#items.keys()][index] ?? null;
  }
  getItem(key: string): string | null {
    return this.#items.get(String(key)) ?? null;
  }
  setItem(key: string, value: string): void {
    this.#items.set(String(key), String(value));
  }
  removeItem(key: string): void {
    this.#items.delete(String(key));
  }
  clear(): void {
    this.#items.clear();
  }
}

export class FakeDocument extends EventTarget {
  visibilityState: DocumentVisibilityState = 'visible';
  get hidden(): boolean {
    return this.visibilityState === 'hidden';
  }
  hasFocus(): boolean {
    return this.visibilityState === 'visible';
  }
}

export interface FakeNavigator {
  readonly onLine: boolean;
  readonly locks: LockManager;
  readonly userAgent: string;
  readonly language: string;
  readonly languages: readonly string[];
  readonly hardwareConcurrency: number;
}

export class FakeWindow extends EventTarget {
  readonly window: FakeWindow = this;
  readonly self: FakeWindow = this;
  // Timer functions resolve the global at call time, so vi.useFakeTimers()
  // applies to `window.setTimeout` as well.
  setTimeout = ((...args: Parameters<typeof setTimeout>) => globalThis.setTimeout(...args)) as typeof setTimeout;
  clearTimeout = ((id?: Parameters<typeof clearTimeout>[0]) => globalThis.clearTimeout(id)) as typeof clearTimeout;
  setInterval = ((...args: Parameters<typeof setInterval>) => globalThis.setInterval(...args)) as typeof setInterval;
  clearInterval = ((id?: Parameters<typeof clearInterval>[0]) => globalThis.clearInterval(id)) as typeof clearInterval;
  queueMicrotask = (cb: VoidFunction) => globalThis.queueMicrotask(cb);

  constructor(
    readonly document: FakeDocument,
    readonly navigator: FakeNavigator,
    readonly localStorage: MemoryStorage,
    readonly sessionStorage: MemoryStorage,
    readonly location: URL,
  ) {
    super();
  }

  get BroadcastChannel(): typeof BroadcastChannel {
    return globalThis.BroadcastChannel;
  }
}

export interface StorageEventInit {
  key: string | null;
  newValue?: string | null;
  oldValue?: string | null;
  /** Default: the env's localStorage. */
  storageArea?: Storage | null;
}

export interface BrowserEnv {
  readonly window: FakeWindow;
  readonly document: FakeDocument;
  readonly navigator: FakeNavigator;
  readonly localStorage: MemoryStorage;
  readonly sessionStorage: MemoryStorage;
  readonly locks: LockManager;
  /** True when `locks` is a fake (resettable) LockManager view. */
  readonly fakeLocks: boolean;
  /** Lock client id of this env (the `clientId` in `locks.query()`). */
  readonly clientId: string;

  /** Sets `document.visibilityState`; fires `visibilitychange` only on a change. */
  setVisibility(state: DocumentVisibilityState): void;
  hide(): void;
  show(): void;
  pagehide(persisted?: boolean): void;
  pageshow(persisted?: boolean): void;
  freeze(): void;
  resume(): void;
  goOffline(): void;
  goOnline(): void;
  /** hide → `pagehide` (persisted) → `freeze`, the order Chrome uses. */
  enterBfcache(): void;
  /** `resume` → `pageshow` (persisted) → show. */
  restoreFromBfcache(): void;
  /** Fires a `storage` event at window (what *other* tabs see on a write). */
  storageEvent(init: StorageEventInit): void;
  /** Fires a plain event (e.g. `beforeunload`) with extra properties. */
  dispatch(target: 'window' | 'document', type: string, props?: Record<string, unknown>): Event;

  /**
   * Back to the initial state: visibility, onLine, both storages cleared,
   * this tab's fake locks released. Listeners stay (they belong to the code under test);
   * for fresh listeners, create a fresh env.
   */
  reset(): void;
  /**
   * The tab goes away: releases every lock it holds and rejects its pending
   * lock requests, as a browser does when a tab closes (fake locks only).
   */
  closeTab(): void;
  /** Restores the previous globals and closes tracked BroadcastChannels (installed envs only). */
  uninstall(): void;
}

function makeEvent(type: string, props?: Record<string, unknown>): Event {
  const event = new Event(type);
  for (const [key, value] of Object.entries(props ?? {})) {
    Object.defineProperty(event, key, { value, enumerable: true });
  }
  return event;
}

/** Creates an env without touching any global (e.g. a second "tab" passed in by injection). */
export function createBrowserEnv(options: BrowserEnvOptions = {}): BrowserEnv {
  const initialVisibility = options.visibilityState ?? 'visible';
  const initialOnLine = options.onLine ?? true;
  let onLine = initialOnLine;

  const locksMode = options.locks ?? 'shared';
  if (locksMode === 'real' && !nodeLocks) {
    throw new Error('installBrowserEnv: this runtime has no navigator.locks');
  }
  const clientId = `tab-${++envCounter}`;
  const lockClient = locksMode === 'real'
    ? undefined
    : (locksMode === 'shared' ? sharedLockManager() : new FakeLockManager()).client(clientId);
  const locks: LockManager = lockClient ?? nodeLocks!;

  const document = new FakeDocument();
  document.visibilityState = initialVisibility;
  const navigator: FakeNavigator = {
    get onLine() {
      return onLine;
    },
    locks,
    userAgent: 'Mozilla/5.0 (node; vitest) CommonGroundTest',
    language: 'en-US',
    languages: ['en-US', 'en'],
    hardwareConcurrency: 4,
  };
  const localStorage = new MemoryStorage();
  const sessionStorage = new MemoryStorage();
  const window = new FakeWindow(
    document,
    navigator,
    localStorage,
    sessionStorage,
    new URL(options.url ?? 'http://localhost:3000/'),
  );

  const env: BrowserEnv = {
    window,
    document,
    navigator,
    localStorage,
    sessionStorage,
    locks,
    fakeLocks: !!lockClient,
    clientId,

    setVisibility(state) {
      if (document.visibilityState === state) return;
      document.visibilityState = state;
      document.dispatchEvent(new Event('visibilitychange'));
    },
    hide() {
      env.setVisibility('hidden');
    },
    show() {
      env.setVisibility('visible');
    },
    pagehide(persisted = false) {
      window.dispatchEvent(makeEvent('pagehide', { persisted }));
    },
    pageshow(persisted = false) {
      window.dispatchEvent(makeEvent('pageshow', { persisted }));
    },
    freeze() {
      document.dispatchEvent(new Event('freeze'));
    },
    resume() {
      document.dispatchEvent(new Event('resume'));
    },
    goOffline() {
      if (!onLine) return;
      onLine = false;
      window.dispatchEvent(new Event('offline'));
    },
    goOnline() {
      if (onLine) return;
      onLine = true;
      window.dispatchEvent(new Event('online'));
    },
    enterBfcache() {
      env.hide();
      env.pagehide(true);
      env.freeze();
    },
    restoreFromBfcache() {
      env.resume();
      env.pageshow(true);
      env.show();
    },
    storageEvent(init) {
      window.dispatchEvent(makeEvent('storage', {
        key: init.key,
        newValue: init.newValue ?? null,
        oldValue: init.oldValue ?? null,
        storageArea: init.storageArea === undefined ? localStorage : init.storageArea,
        url: window.location.href,
      }));
    },
    dispatch(target, type, props) {
      const event = makeEvent(type, props);
      (target === 'window' ? window : document).dispatchEvent(event);
      return event;
    },
    reset() {
      document.visibilityState = initialVisibility;
      onLine = initialOnLine;
      localStorage.clear();
      sessionStorage.clear();
      lockClient?.release();
    },
    closeTab() {
      if (!lockClient) throw new Error('closeTab: not supported with real Web Locks');
      lockClient.release();
    },
    uninstall() {
      // not installed: nothing to restore
    },
  };
  return env;
}

let installed: BrowserEnv | undefined;
let envCounter = 0;

const GLOBAL_KEYS = ['window', 'self', 'document', 'navigator', 'localStorage', 'sessionStorage', 'location', 'BroadcastChannel'] as const;

/**
 * Creates an env and installs it as the globals `window`, `self`, `document`,
 * `navigator`, `localStorage`, `sessionStorage`, `location` and a tracking
 * `BroadcastChannel` (Node's own, closed on uninstall). Torn down after the
 * current test unless `persistent` is set.
 */
export function installBrowserEnv(options: BrowserEnvOptions = {}): BrowserEnv {
  if (installed) {
    throw new Error('installBrowserEnv: an env is already installed; uninstall it first');
  }
  const env = createBrowserEnv(options);
  const g = globalThis as Record<string, unknown>;
  const saved = new Map<string, PropertyDescriptor | undefined>();
  const RealBroadcastChannel = globalThis.BroadcastChannel;
  const channels = new Set<BroadcastChannel>();

  class TrackedBroadcastChannel extends RealBroadcastChannel {
    constructor(name: string) {
      super(name);
      // Dexie opens one module-level channel per process for liveQuery
      // propagation; closing it would break every later Dexie write.
      if (!String(name).startsWith('x-storagemutated')) channels.add(this);
    }
    close(): void {
      channels.delete(this);
      super.close();
    }
  }

  const values: Record<(typeof GLOBAL_KEYS)[number], unknown> = {
    window: env.window,
    self: env.window,
    document: env.document,
    navigator: env.navigator,
    localStorage: env.localStorage,
    sessionStorage: env.sessionStorage,
    location: env.window.location,
    BroadcastChannel: TrackedBroadcastChannel,
  };
  for (const key of GLOBAL_KEYS) {
    saved.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { value: values[key], configurable: true, writable: true, enumerable: true });
  }

  let unregister: (() => void) | undefined;
  const uninstall = () => {
    if (installed !== env) return;
    installed = undefined;
    unregister?.();
    for (const channel of [...channels]) channel.close();
    for (const key of GLOBAL_KEYS) {
      const descriptor = saved.get(key);
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete g[key];
    }
  };
  env.uninstall = uninstall;
  installed = env;
  if (!options.persistent) unregister = registerTeardown(uninstall);
  return env;
}

/** The currently installed env, if any. */
export function currentBrowserEnv(): BrowserEnv | undefined {
  return installed;
}

// Node's own LockManager (Node >= 22), captured at load time — before any env
// replaces `globalThis.navigator`. Node's navigator getters are brand-checked,
// so the manager is captured, not proxied.
const nodeLocks: LockManager | undefined = (() => {
  try {
    const locks = (globalThis as { navigator?: { locks?: LockManager } }).navigator?.locks;
    return locks && typeof locks.request === 'function' ? locks : undefined;
  } catch {
    return undefined;
  }
})();

// ---------------------------------------------------------------------------
// Fake Web Locks
// ---------------------------------------------------------------------------

interface LockRequest {
  clientId: string;
  name: string;
  mode: LockMode;
  callback: (lock: Lock | null) => unknown;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  onAbort?: () => void;
  /** No longer in the held list (released, stolen, its tab closed, or reset). */
  released?: boolean;
  /** Its request promise is settled already (stolen) or must never settle (tab closed). */
  orphaned?: boolean;
}

type LockCallback = (lock: Lock | null) => unknown;

/** One tab's view of a `FakeLockManager`: a `LockManager` plus `release()`. */
export interface FakeLockClient extends LockManager {
  readonly clientId: string;
  /** Releases this client's held locks and rejects its pending requests. */
  release(): void;
}

function abortError(message: string): Error {
  return new DOMException(message, 'AbortError');
}

/**
 * Minimal `LockManager` for one origin: exclusive/shared modes, FIFO per
 * name, `ifAvailable`, `steal`, `signal`, `query()` (with `clientId`).
 * `client(id)` hands out a per-tab view; `releaseClient(id)` is what a
 * closing tab does. `reset()` drops every held lock and rejects every
 * pending request.
 */
export class FakeLockManager {
  #held = new Map<string, LockRequest[]>();
  #pending: LockRequest[] = [];
  #clientCounter = 0;
  readonly #onUse?: () => void;

  /** `onUse` runs on every request (the shared manager registers its reset there). */
  constructor(options: { onUse?: () => void } = {}) {
    this.#onUse = options.onUse;
  }

  /** A `LockManager` view whose requests belong to `clientId`. */
  client(clientId = `client-${++this.#clientCounter}`): FakeLockClient {
    const request = ((name: string, a: LockOptions | LockCallback, b?: LockCallback) =>
      this.#request(clientId, name, a, b)) as LockManager['request'];
    return {
      clientId,
      request,
      query: () => this.query(),
      release: () => this.releaseClient(clientId),
    };
  }

  /** Requests as the client `default`. */
  request(name: string, optionsOrCallback: LockOptions | LockCallback, maybeCallback?: LockCallback): Promise<unknown> {
    return this.#request('default', name, optionsOrCallback, maybeCallback);
  }

  async query(): Promise<LockManagerSnapshot> {
    const info = (r: LockRequest): LockInfo => ({ name: r.name, mode: r.mode, clientId: r.clientId });
    return {
      held: [...this.#held.values()].flat().map(info),
      pending: this.#pending.map(info),
    };
  }

  /**
   * The tab `clientId` is gone: its held locks are released (their request
   * promises never settle, nobody is left to observe them) and its pending
   * requests reject with an AbortError.
   */
  releaseClient(clientId: string): void {
    for (const [name, held] of this.#held) {
      for (const request of held.filter(r => r.clientId === clientId)) {
        request.released = true;
        request.orphaned = true;
        held.splice(held.indexOf(request), 1);
      }
      if (held.length === 0) this.#held.delete(name);
    }
    const mine = this.#pending.filter(r => r.clientId === clientId);
    this.#pending = this.#pending.filter(r => r.clientId !== clientId);
    for (const request of mine) request.reject(abortError('lock client released'));
    this.#process();
  }

  reset(): void {
    for (const held of [...this.#held.values()].flat()) held.released = true;
    this.#held.clear();
    const pending = this.#pending;
    this.#pending = [];
    for (const request of pending) request.reject(abortError('lock manager reset'));
  }

  #request(clientId: string, name: string, optionsOrCallback: LockOptions | LockCallback, maybeCallback?: LockCallback): Promise<unknown> {
    this.#onUse?.();
    const options: LockOptions = typeof optionsOrCallback === 'function' ? {} : optionsOrCallback;
    const callback = typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback;
    if (typeof callback !== 'function') return Promise.reject(new TypeError('callback required'));
    const mode: LockMode = options.mode ?? 'exclusive';
    if (options.steal && options.ifAvailable) return Promise.reject(new DOMException('steal and ifAvailable', 'NotSupportedError'));
    if (options.signal?.aborted) return Promise.reject(options.signal.reason ?? abortError('aborted'));

    return new Promise((resolve, reject) => {
      const request: LockRequest = { clientId, name, mode, callback, resolve, reject, signal: options.signal };
      if (options.steal) {
        for (const held of this.#held.get(name) ?? []) {
          held.released = true;
          held.orphaned = true;
          held.reject(abortError('lock stolen'));
        }
        this.#held.set(name, []);
        this.#grant(request);
        return;
      }
      if (options.ifAvailable && !this.#grantable(name, mode)) {
        this.#run(request, null);
        return;
      }
      if (request.signal) {
        request.onAbort = () => {
          const index = this.#pending.indexOf(request);
          if (index >= 0) {
            this.#pending.splice(index, 1);
            reject(request.signal!.reason ?? abortError('aborted'));
          }
        };
        request.signal.addEventListener('abort', request.onAbort, { once: true });
      }
      this.#pending.push(request);
      this.#process();
    });
  }

  #grantable(name: string, mode: LockMode): boolean {
    const held = this.#held.get(name) ?? [];
    if (this.#pending.some(r => r.name === name)) return false;
    if (mode === 'exclusive') return held.length === 0;
    return held.every(r => r.mode === 'shared');
  }

  #process(): void {
    const names = new Set(this.#pending.map(r => r.name));
    for (const name of names) {
      for (const request of this.#pending.filter(r => r.name === name)) {
        const held = this.#held.get(name) ?? [];
        const ok = request.mode === 'exclusive' ? held.length === 0 : held.every(r => r.mode === 'shared');
        if (!ok) break;
        this.#pending.splice(this.#pending.indexOf(request), 1);
        this.#grant(request);
      }
    }
  }

  #grant(request: LockRequest): void {
    if (request.onAbort) request.signal?.removeEventListener('abort', request.onAbort);
    const held = this.#held.get(request.name) ?? [];
    held.push(request);
    this.#held.set(request.name, held);
    this.#run(request, { name: request.name, mode: request.mode } as Lock);
  }

  #run(request: LockRequest, lock: Lock | null): void {
    const release = () => {
      if (!lock || request.released) return;
      request.released = true;
      const held = this.#held.get(request.name) ?? [];
      const index = held.indexOf(request);
      if (index >= 0) held.splice(index, 1);
      if (held.length === 0) this.#held.delete(request.name);
      this.#process();
    };
    Promise.resolve()
      .then(() => request.callback(lock))
      .then(
        (value) => {
          release();
          if (!request.orphaned) request.resolve(value);
        },
        (error) => {
          release();
          if (!request.orphaned) request.reject(error);
        },
      );
  }
}

let sharedManager: FakeLockManager | undefined;
let sharedResetRegistered = false;

/**
 * The per-test shared lock manager every `locks: 'shared'` env (the default)
 * gets a client view of — one "origin" for all simulated tabs. Reset after
 * the test that first used it.
 */
export function sharedLockManager(): FakeLockManager {
  sharedManager ??= new FakeLockManager({ onUse: ensureSharedReset });
  ensureSharedReset();
  return sharedManager;
}

// Registered on first use in each test, so an env created in `beforeAll`
// (persistent) still gets its locks reset after every test that uses them.
function ensureSharedReset(): void {
  if (sharedResetRegistered) return;
  sharedResetRegistered = true;
  registerTeardown(() => {
    sharedResetRegistered = false;
    sharedManager?.reset();
  });
}
