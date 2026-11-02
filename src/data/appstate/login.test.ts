// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { installBrowserEnv } from 'test/env';
import { createFakeIo, type FakeIo, type FakeSocket } from 'test/fakeSocket';
import { importAsNewTab } from 'test/modules';
import { useDataLayerFakeTimers } from 'test/timers';
import { deferred, flushMicrotasks, type Deferred } from 'test/deferred';
import { AUTH_BROADCAST_CHANNEL, LEGACY_LOGIN_STATE_CHANNEL, LOGIN_LOCK_NAME, type AuthBroadcastMessage } from './transport';

/*
 * Per-tab login state of data/appstate/login.ts (chat-sync [1]): HTTP logins
 * serialised across tabs by the login lock, logout/login broadcast to the
 * other tabs (CG_CURRENT_USER storage event as the fallback), the legacy
 * 'anonymous' notice for old pages, and LOGIN_REQUIRED without tab roles.
 * Two "tabs" are two module graphs in one process sharing localStorage,
 * BroadcastChannel and the lock manager, like two tabs of one origin.
 */

const CURRENT_USER_KEY = 'CG_CURRENT_USER';

const fake = vi.hoisted(() => {
  const server = {
    /** user of the (shared) session cookie */
    sessionUserId: null as string | null,
    loginCalls: 0,
    logoutCalls: 0,
    concurrentLogins: 0,
    maxConcurrentLogins: 0,
    /** when set, the next User/login waits for it */
    loginGate: undefined as Deferred<void> | undefined,
    devices: new Map<string, string>(), // deviceId -> userId
    /** the session's one signable secret (like `session.signSecret`): a new one replaces it */
    secret: undefined as string | undefined,
    secretCounter: 0,
    invalidSecrets: 0,
    /** when set, User/login never answers */
    hangLogin: false,
    /** when set, the next getSignableSecret reaches the server (writes its secret) only once resolved */
    secretGate: undefined as Deferred<void> | undefined,
    /** when set, the next User/login reaches the server (checks the secret) only once resolved */
    preLoginGate: undefined as Deferred<void> | undefined,
    /** when set, the next User/login fails with this error (before the secret check) */
    failNextLogin: undefined as string | undefined,
  };
  return {
    io: undefined as FakeIo | undefined,
    server,
    keyPair: undefined as CryptoKeyPair | undefined,
    /** options of every community/chat snapshot merge (setupAfterLogin) */
    snapshots: [] as { db: string; options?: { requestStartedAt?: number } }[],
  };
});

vi.mock('socket.io-client', () => ({
  io: (...args: Parameters<FakeIo['io']>) => fake.io!.io(...args),
}));

vi.mock('data/api/user', () => ({
  default: {
    ensureSession: async () => undefined,
    getSignableSecret: async () => {
      await Promise.resolve();
      const secret = `http-secret-${++fake.server.secretCounter}`;
      if (fake.server.secretGate) {
        const gate = fake.server.secretGate;
        fake.server.secretGate = undefined;
        await gate.promise;
      }
      // written when the (possibly late) request reaches the server
      fake.server.secret = secret;
      return secret;
    },
    checkLoginStatus: async () => ({ userId: fake.server.sessionUserId }),
    login: async (request: { type: string; deviceId?: string; secret?: string }) => {
      const { server } = fake;
      if (server.hangLogin) return new Promise(() => undefined);
      if (server.failNextLogin) {
        const error = server.failNextLogin;
        server.failNextLogin = undefined;
        throw new Error(error);
      }
      if (server.preLoginGate) {
        const gate = server.preLoginGate;
        server.preLoginGate = undefined;
        await gate.promise;
      }
      if (request.type === 'device') {
        // one secret per session, used once (srv/api/user.ts)
        if (!request.secret || request.secret !== server.secret) {
          server.invalidSecrets++;
          throw new Error('INVALID_SECRET');
        }
        server.secret = undefined;
      }
      server.loginCalls++;
      server.concurrentLogins++;
      server.maxConcurrentLogins = Math.max(server.maxConcurrentLogins, server.concurrentLogins);
      try {
        if (server.loginGate) {
          const gate = server.loginGate;
          server.loginGate = undefined;
          await gate.promise;
        }
        const userId = server.devices.get(request.deviceId ?? '');
        if (!userId) throw new Error('NOT_FOUND');
        server.sessionUserId = userId;
        return {
          ownData: { id: userId },
          deviceId: request.deviceId,
          webPushSubscription: null,
          communities: [],
          chats: [],
          unreadNotificationCount: 3,
        };
      } finally {
        server.concurrentLogins--;
      }
    },
    logout: async () => {
      fake.server.logoutCalls++;
      fake.server.sessionUserId = null;
    },
  },
}));

vi.mock('data/util/device', () => {
  const keyPair = async () => {
    fake.keyPair ??= await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify']) as CryptoKeyPair;
    return fake.keyPair;
  };
  return {
    generateNewKeyPair: keyPair,
    getDeviceKeyPair: async (deviceId: string) => ({ deviceId, keyPair: await keyPair() }),
    saveDeviceKeyPair: async () => undefined,
    deleteDeviceKeyPair: async () => undefined,
    getAllDeviceKeyPairs: async () => [],
    signApiSecret: async (deviceId: string, secret: string) => ({ deviceId, secret, base64Signature: 'sig' }),
  };
});

const stubDb = (db?: string) => ({
  setupAfterLogin: async (_data: unknown, options?: { requestStartedAt?: number }) => {
    if (db) fake.snapshots.push({ db, options });
  },
  clear: async () => undefined,
});
vi.mock('data/databases/user', () => ({ default: stubDb() }));
vi.mock('data/databases/community', () => ({ default: stubDb('community') }));
vi.mock('data/databases/chats', () => ({ default: stubDb('chats') }));
vi.mock('data/databases/notification', () => ({ default: { ...stubDb(), unreadCount: 0 } }));
vi.mock('data/databases/channel', () => ({ default: { userId: undefined, clear: async () => undefined } }));
const chatHooks = vi.hoisted(() => ({ calls: [] as string[] }));
vi.mock('data/chat/runtime', () => ({
  clearChat: () => { chatHooks.calls.push('clear'); },
  setupChatAfterLogin: (count: number | string) => { chatHooks.calls.push(`setup:${count}`); },
}));
vi.mock('data/databases/unique', () => ({
  default: { uniques: { get: async (key: string) => (key === 'OwnData' ? { key, data: { id: 'u1' } } : undefined) } },
}));
vi.mock('data/api/notifications', () => ({ default: { getUnreadCount: async () => '2' } }));
vi.mock('data/api/community', () => ({ default: { getCommunityDetailView: async () => ({}) } }));
vi.mock('data/api/chat', () => ({ default: { getChats: async () => [] } }));
vi.mock('util/siwe', () => ({ default: () => '' }));
vi.mock('data/appstate/connection', () => ({ default: { registerClientEventHandler: () => undefined } }));
vi.mock('data/appstate/serviceWorker', () => ({ default: { setupAfterLogin: async () => undefined } }));

beforeAll(async () => {
  // key generation takes real time: once, before the tests
  fake.keyPair = await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify']) as CryptoKeyPair;
});

// The device login signs with WebCrypto, which takes real (thread-pool) time
// and makes the order of the steps under test depend on machine load. The
// fake server does not verify signatures: answer at once.
beforeEach(() => {
  vi.spyOn(crypto.subtle, 'sign').mockImplementation(async () => new Uint8Array(96).buffer);
});
afterEach(() => {
  vi.mocked(crypto.subtle.sign).mockRestore();
});

function resetServer() {
  fake.snapshots.length = 0;
  Object.assign(fake.server, {
    secret: undefined,
    secretCounter: 0,
    invalidSecrets: 0,
    hangLogin: false,
    secretGate: undefined,
    preLoginGate: undefined,
    failNextLogin: undefined,
    sessionUserId: null,
    loginCalls: 0,
    logoutCalls: 0,
    concurrentLogins: 0,
    maxConcurrentLogins: 0,
    loginGate: undefined,
  });
  fake.server.devices = new Map([['dev-1', 'u1'], ['dev-2', 'u2']]);
}

function storeUser(userId: string, deviceId: string) {
  localStorage.setItem(CURRENT_USER_KEY, JSON.stringify({ userId, deviceId }));
}

/** A tab = a fresh module graph of login.ts + webSocket.ts, started like the app does. */
async function openTab() {
  const { default: loginManager } = await importAsNewTab(() => import('data/appstate/login'));
  const { default: ws } = await import('data/appstate/webSocket');
  ws.start();
  const socket = fake.io!.last;
  return { loginManager, ws, socket };
}
type Tab = Awaited<ReturnType<typeof openTab>>;

async function settle(rounds = 10) {
  for (let i = 0; i < rounds; i++) {
    await flushMicrotasks();
    for (const socket of fake.io?.sockets ?? []) await socket.settle();
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

/**
 * Real-time wait (not fake time: `performance` is not faked) until
 * `condition` holds; fails the test after `timeoutMs`. Yields real
 * event-loop turns, so pending I/O-like work (the fake server, Web Locks)
 * goes on; independent of how many turns that takes under load.
 */
async function until(condition: () => boolean | Promise<boolean>, timeoutMs = 4_000) {
  const start = performance.now();
  while (!(await condition())) {
    if (performance.now() - start > timeoutMs) {
      throw new Error(`until: condition not met within ${timeoutMs} ms`);
    }
    await new Promise<void>(resolve => setImmediate(resolve));
  }
}

/** until some tab holds the login lock */
async function waitHeld() {
  await until(async () => (await navigator.locks.query()).held!.length > 0);
}

/** until `count` lock requests wait */
async function waitPending(count = 1) {
  await until(async () => (await navigator.locks.query()).pending!.length >= count);
}

function setup() {
  resetServer();
  fake.io = createFakeIo();
  return installBrowserEnv({ url: 'https://app.test/' });
}

/** A tab logged in as u1 (device login done, socket live). */
async function loggedInTab(): Promise<Tab> {
  storeUser('u1', 'dev-1');
  const tab = await openTab();
  await tab.loginManager.autoLogin();
  await settle();
  expect(tab.loginManager.state).toBe('loggedin');
  expect(tab.ws.live).toBe(true);
  return tab;
}

function socketLoggedInAs(socket: FakeSocket): string | null {
  const last = socket.sent.filter(p => p.event === 'login' || p.event === 'logout').pop();
  if (!last || last.event === 'logout' || !socket.loggedIn) return null;
  return (last.args[0] as { deviceId: string }).deviceId;
}

describe('login lock', () => {
  it('serialises the HTTP device logins of two tabs', async () => {
    setup();
    storeUser('u1', 'dev-1');
    const a = await openTab();
    const b = await openTab();
    const gate = deferred();
    fake.server.loginGate = gate;

    const loginA = a.loginManager.autoLogin();
    const loginB = b.loginManager.autoLogin();
    await vi.waitFor(() => expect(fake.server.loginCalls).toBe(1));
    await settle();
    expect(fake.server.loginCalls).toBe(1);
    gate.resolve();
    await Promise.all([loginA, loginB]);

    // the tab that waited for the lock found the session logged in and took it over
    expect(fake.server.loginCalls).toBe(1);
    expect(fake.server.maxConcurrentLogins).toBe(1);
    expect(fake.server.invalidSecrets).toBe(0);
    expect(a.loginManager.state).toBe('loggedin');
    expect(b.loginManager.state).toBe('loggedin');
    await settle();
    expect(socketLoggedInAs(b.socket)).toBe('dev-1');
  });

  it('two tabs loading at once share the one session secret (secret, signature and login under one lock)', async () => {
    setup();
    storeUser('u1', 'dev-1');
    const a = await openTab();
    const b = await openTab();
    const results = await Promise.all([
      a.loginManager.autoLogin().then(() => 'ok', (e: Error) => e.message),
      b.loginManager.autoLogin().then(() => 'ok', (e: Error) => e.message),
    ]);
    await settle();
    expect(results).toEqual(['ok', 'ok']);
    expect(fake.server.invalidSecrets).toBe(0);
    expect(a.loginManager.state).toBe('loggedin');
    expect(b.loginManager.state).toBe('loggedin');
    expect(b.loginManager.currentUser?.userId).toBe('u1');
    expect(b.ws.live).toBe(true);
  });

  it('a tab without a running login in another tab does its own device login (fresh snapshot after a reload)', async () => {
    setup();
    fake.server.sessionUserId = 'u1'; // the cookie survived the reload
    await loggedInTab();
    expect(fake.server.loginCalls).toBe(1);
    expect(fake.snapshots.map(s => s.db).sort()).toEqual(['chats', 'community']);
    expect(fake.snapshots.every(s => typeof s.options?.requestStartedAt === 'number')).toBe(true);
  });

  it('a slow login releases the lock after LOGIN_LOCK_HOLD_MAX_MS and still completes', async () => {
    useDataLayerFakeTimers();
    setup();
    storeUser('u1', 'dev-1');
    const a = await openTab();
    const b = await openTab();
    const gate = deferred();
    fake.server.loginGate = gate; // A's User/login is inside the server (secret used)
    const loginA = a.loginManager.autoLogin().then(() => 'ok', (e: Error) => e.message);
    await waitHeld();
    await until(() => fake.server.concurrentLogins === 1);
    const loginB = b.loginManager.autoLogin().then(() => 'ok', (e: Error) => e.message);
    await waitPending();
    const { LOGIN_LOCK_HOLD_MAX_MS } = await import('data/appstate/authBroadcast');
    await vi.advanceTimersByTimeAsync(LOGIN_LOCK_HOLD_MAX_MS);
    // B got the lock after the hold cap (not after its own 15 s wait) and logged in
    expect(await loginB).toBe('ok');
    expect(b.loginManager.state).toBe('loggedin');
    // A's own request was not abandoned
    gate.resolve();
    expect(await loginA).toBe('ok');
    expect(a.loginManager.state).toBe('loggedin');
    expect(fake.server.invalidSecrets).toBe(0);
  });

  it('R2: a single tab whose login takes longer than the hold cap ends logged in', async () => {
    useDataLayerFakeTimers();
    setup();
    storeUser('u1', 'dev-1');
    const tab = await openTab();
    const gate = deferred();
    fake.server.loginGate = gate;
    const login = tab.loginManager.autoLogin().then(() => 'ok', (e: Error) => e.message);
    await waitHeld();
    await until(() => fake.server.concurrentLogins === 1);
    await vi.advanceTimersByTimeAsync(12_000);
    gate.resolve();
    expect(await login).toBe('ok');
    expect(tab.loginManager.state).toBe('loggedin');
    expect(fake.server.loginCalls).toBe(1);
  });

  it('R3: a late secret of a holder that lost the lock does not break the next tab (one retry with a fresh secret)', async () => {
    useDataLayerFakeTimers();
    setup();
    storeUser('u1', 'dev-1');
    const a = await openTab();
    const b = await openTab();
    const secretA = deferred();
    fake.server.secretGate = secretA; // A's getSignableSecret reaches the server late
    const loginA = a.loginManager.autoLogin().then(() => 'ok', (e: Error) => e.message);
    await waitHeld();
    const loginB = b.loginManager.autoLogin().then(() => 'ok', (e: Error) => e.message);
    await waitPending();
    const { LOGIN_LOCK_HOLD_MAX_MS } = await import('data/appstate/authBroadcast');
    const preLoginB = deferred();
    fake.server.preLoginGate = preLoginB; // B's login is in flight when A's late secret lands
    await vi.advanceTimersByTimeAsync(LOGIN_LOCK_HOLD_MAX_MS + 10);
    // B holds the lock now and its User/login waits at the gate (B's secret is set)
    await until(() => fake.server.preLoginGate === undefined);
    secretA.resolve(); // A's late secret replaces B's secret on the server
    await until(() => fake.server.secret === 'http-secret-1');
    preLoginB.resolve();
    expect(await Promise.all([loginA, loginB])).toEqual(['ok', 'ok']);
    await settle();
    expect(fake.server.invalidSecrets).toBe(1);
    expect(a.loginManager.state).toBe('loggedin');
    expect(b.loginManager.state).toBe('loggedin');
    // A did not sign outside the lock: it took B's fresh session over
    expect(fake.server.loginCalls).toBe(1);
  });

  it('(c) a tab that got the lock follows a stored user that changed since it started', async () => {
    setup();
    storeUser('u1', 'dev-1');
    const tab = await openTab();
    // another tab logged in interactively as u2 (its storage event is late)
    storeUser('u2', 'dev-2');
    fake.server.sessionUserId = 'u2';
    await tab.loginManager.autoLogin();
    await settle();
    expect(fake.server.loginCalls).toBe(0); // no login of dev-1 over u2's session
    expect(fake.server.sessionUserId).toBe('u2');
    expect(tab.loginManager.state).toBe('loggedin');
    expect(tab.loginManager.currentUser?.userId).toBe('u2');
    expect(socketLoggedInAs(tab.socket)).toBe('dev-2');
  });

  it('a failed device login (not NOT_FOUND) is retried with a backoff', async () => {
    useDataLayerFakeTimers();
    setup();
    storeUser('u1', 'dev-1');
    const tab = await openTab();
    fake.server.failNextLogin = 'SERVICE_UNAVAILABLE';
    await expect(tab.loginManager.autoLogin()).rejects.toThrow('SERVICE_UNAVAILABLE');
    expect(tab.loginManager.state).toBe('anonymous');
    expect(tab.loginManager.currentUser?.userId).toBe('u1');
    const { DEVICE_LOGIN_RETRY_MS } = await import('data/appstate/login');
    await vi.advanceTimersByTimeAsync(DEVICE_LOGIN_RETRY_MS[0] * 1.5);
    await until(() => tab.loginManager.state === 'loggedin');
    expect(fake.server.loginCalls).toBe(1);
  });

  it('a status check retries a failed device login, but not sooner than the first backoff step', async () => {
    useDataLayerFakeTimers();
    const random = vi.spyOn(Math, 'random').mockReturnValue(0.99); // scheduled retry at ~7.5 s
    setup();
    storeUser('u1', 'dev-1');
    const tab = await openTab();
    fake.server.failNextLogin = 'SERVICE_UNAVAILABLE';
    await tab.loginManager.autoLogin().catch(() => undefined);
    expect(tab.loginManager.state).toBe('anonymous');
    const { DEVICE_LOGIN_RETRY_MS } = await import('data/appstate/login');

    // right after the failure: no new attempt
    await tab.loginManager.checkLoginStatus();
    await settle();
    expect(tab.loginManager.state).toBe('anonymous');

    // after the base delay (before the scheduled retry): the check retries
    await vi.advanceTimersByTimeAsync(DEVICE_LOGIN_RETRY_MS[0]);
    expect(tab.loginManager.state).toBe('anonymous');
    await tab.loginManager.checkLoginStatus();
    await until(() => tab.loginManager.state === 'loggedin');
    expect(fake.server.loginCalls).toBe(1);
    random.mockRestore();
  });

  it('does not wait forever for a lock held by a frozen tab', async () => {
    useDataLayerFakeTimers();
    setup();
    storeUser('u1', 'dev-1');
    const tab = await openTab();
    // another tab got the lock and was frozen: it never releases it
    void navigator.locks.request(LOGIN_LOCK_NAME, () => new Promise(() => undefined)).catch(() => undefined);
    await flushMicrotasks();

    const login = tab.loginManager.autoLogin();
    // until the login waits for the lock
    await waitPending();
    expect((await navigator.locks.query()).pending).toHaveLength(1);
    expect(fake.server.loginCalls).toBe(0);
    const { LOGIN_LOCK_WAIT_MS } = await import('data/appstate/authBroadcast');
    await vi.advanceTimersByTimeAsync(LOGIN_LOCK_WAIT_MS);
    await login;
    expect(fake.server.loginCalls).toBe(1);
    expect(tab.loginManager.state).toBe('loggedin');
  });
});

describe('logout and login in other tabs', () => {
  it('a logout is broadcast: the other tab drops its socket login and state without a second User/logout', async () => {
    setup();
    const a = await loggedInTab();
    const b = await openTab();
    await b.loginManager.autoLogin();
    await settle();
    expect(b.loginManager.state).toBe('loggedin');
    expect(socketLoggedInAs(b.socket)).toBe('dev-1');

    const legacy = new BroadcastChannel(LEGACY_LOGIN_STATE_CHANNEL);
    const legacyMessages: unknown[] = [];
    legacy.onmessage = (event) => legacyMessages.push(event.data);

    expect(chatHooks.calls).toContain('setup:3');
    chatHooks.calls.length = 0;
    await a.loginManager.logout();
    await settle();

    expect(fake.server.logoutCalls).toBe(1);
    // the other tab drops its in-memory chat data
    expect(chatHooks.calls).toContain('clear');
    expect(b.loginManager.state).toBe('anonymous');
    expect(b.loginManager.currentUser).toBeNull();
    expect(b.socket.sentOf('logout')).toHaveLength(1);
    expect(socketLoggedInAs(b.socket)).toBeNull();
    expect(b.ws.live).toBe(true); // connected as anonymous
    expect(legacyMessages).toEqual(['anonymous']);
    legacy.close();
  });

  it('falls back to the CG_CURRENT_USER storage event', async () => {
    const env = setup();
    const tab = await loggedInTab();
    // another tab logged out, its broadcast got lost
    localStorage.removeItem(CURRENT_USER_KEY);
    env.storageEvent({ key: CURRENT_USER_KEY, newValue: null });
    await settle();
    expect(tab.loginManager.state).toBe('anonymous');
    expect(tab.socket.sentOf('logout')).toHaveLength(1);
    expect(fake.server.logoutCalls).toBe(0);
  });

  it('a login in another tab is adopted without an HTTP login', async () => {
    setup();
    const tab = await openTab();
    await tab.loginManager.autoLogin();
    await settle();
    expect(tab.loginManager.state).toBe('anonymous');

    // the other tab logged in
    fake.server.sessionUserId = 'u1';
    storeUser('u1', 'dev-1');
    const channel = new BroadcastChannel(AUTH_BROADCAST_CHANNEL);
    chatHooks.calls.length = 0;
    channel.postMessage({ v: 1, type: 'logged-in', tabId: 'other-tab', userId: 'u1' } satisfies AuthBroadcastMessage);
    await settle();

    expect(fake.server.loginCalls).toBe(0);
    // the adopted login takes the server's notification count
    expect(chatHooks.calls).toEqual(['setup:2']);
    expect(tab.loginManager.state).toBe('loggedin');
    expect(tab.loginManager.currentUser?.userId).toBe('u1');
    expect(socketLoggedInAs(tab.socket)).toBe('dev-1');
    channel.close();
  });

  it('a login of another user is handled as a logout first', async () => {
    setup();
    const tab = await loggedInTab();
    const states: Common.LoginState[] = [];
    tab.loginManager.onStateChange = (state) => { states.push(state); };

    fake.server.sessionUserId = 'u2';
    storeUser('u2', 'dev-2');
    const channel = new BroadcastChannel(AUTH_BROADCAST_CHANNEL);
    channel.postMessage({ v: 1, type: 'logged-in', tabId: 'other-tab', userId: 'u2' } satisfies AuthBroadcastMessage);
    await settle();

    expect(states).toEqual(['loggingout', 'anonymous', 'loggedin']);
    expect(tab.loginManager.currentUser?.userId).toBe('u2');
    expect(tab.socket.sentOf('logout')).toHaveLength(1);
    expect(socketLoggedInAs(tab.socket)).toBe('dev-2');
    expect(fake.server.loginCalls).toBe(1); // only the initial one
    channel.close();
  });

  it('the logging-in tab broadcasts its login', async () => {
    setup();
    const channel = new BroadcastChannel(AUTH_BROADCAST_CHANNEL);
    const messages: AuthBroadcastMessage[] = [];
    channel.onmessage = (event) => messages.push(event.data);
    await loggedInTab();
    await settle();
    expect(messages).toEqual([expect.objectContaining({ v: 1, type: 'logged-in', userId: 'u1' })]);
    channel.close();
  });
});

describe('LOGIN_REQUIRED', () => {
  it('re-checks the session and does not log in again when another tab already did', async () => {
    setup();
    const tab = await loggedInTab();
    await expect(tab.loginManager.loginRequiredErrorHandler()).resolves.toBeUndefined();
    expect(fake.server.loginCalls).toBe(1);
  });

  it('logs in with the device key when the session is gone, in any tab', async () => {
    setup();
    const tab = await loggedInTab();
    fake.server.sessionUserId = null;
    await expect(tab.loginManager.loginRequiredErrorHandler()).resolves.toBeUndefined();
    expect(fake.server.loginCalls).toBe(2);
    expect(tab.loginManager.state).toBe('loggedin');
  });
});

describe('refresh after a restored live', () => {
  it('re-runs the device login snapshot under the lock, without a login-state change', async () => {
    setup();
    const tab = await loggedInTab();
    fake.snapshots.length = 0;
    const states: Common.LoginState[] = [];
    tab.loginManager.onStateChange = (state) => { states.push(state); };
    const before = Date.now();

    await tab.loginManager.refreshAfterReconnect();

    expect(fake.server.loginCalls).toBe(2);
    expect(fake.server.invalidSecrets).toBe(0);
    expect(states).toEqual([]);
    expect(tab.loginManager.state).toBe('loggedin');
    expect(fake.snapshots.map(s => s.db).sort()).toEqual(['chats', 'community']);
    for (const snapshot of fake.snapshots) {
      expect(snapshot.options?.requestStartedAt).toBeGreaterThanOrEqual(before);
    }
  });

  it('runs one request per refresh and keeps the secret of a concurrent page login intact', async () => {
    setup();
    const a = await loggedInTab();
    const b = await openTab();
    const results = await Promise.all([
      a.loginManager.refreshAfterReconnect().then(() => 'ok', (e: Error) => e.message),
      b.loginManager.autoLogin().then(() => 'ok', (e: Error) => e.message),
    ]);
    expect(results).toEqual(['ok', 'ok']);
    expect(fake.server.invalidSecrets).toBe(0);
    expect(b.loginManager.state).toBe('loggedin');
  });

  it('does not log in over a session of another user', async () => {
    setup();
    const tab = await loggedInTab();
    fake.server.sessionUserId = 'u2';
    await tab.loginManager.refreshAfterReconnect();
    expect(fake.server.loginCalls).toBe(1);
  });

  it('a device signed out elsewhere signs out on the refresh', async () => {
    setup();
    const tab = await loggedInTab();
    fake.server.devices.delete('dev-1');
    await tab.loginManager.refreshAfterReconnect();
    await settle();
    expect(tab.loginManager.state).toBe('anonymous');
  });
});

describe('no tab roles', () => {
  it('never opens CG_WEBSOCKET_STATE and never listens on CG_LOGIN_STATE', async () => {
    setup();
    const opened: { name: string; channel: BroadcastChannel }[] = [];
    const Tracked = globalThis.BroadcastChannel;
    globalThis.BroadcastChannel = class extends Tracked {
      constructor(name: string) {
        super(name);
        opened.push({ name, channel: this });
      }
    } as typeof BroadcastChannel;

    const tab = await loggedInTab();
    await tab.loginManager.logout();
    await settle();

    expect(opened.map(o => o.name)).not.toContain('CG_WEBSOCKET_STATE');
    for (const { channel } of opened.filter(o => o.name === LEGACY_LOGIN_STATE_CHANNEL)) {
      expect(channel.onmessage).toBeNull();
    }
    expect(opened.map(o => o.name)).toContain(AUTH_BROADCAST_CHANNEL);
  });
});
