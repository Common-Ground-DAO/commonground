// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { beforeAll, describe, expect, it, vi } from 'vitest';
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
      fake.server.secret = `http-secret-${++fake.server.secretCounter}`;
      return fake.server.secret;
    },
    checkLoginStatus: async () => ({ userId: fake.server.sessionUserId }),
    login: async (request: { type: string; deviceId?: string; secret?: string }) => {
      const { server } = fake;
      if (server.hangLogin) return new Promise(() => undefined);
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
vi.mock('data/databases/messages', () => ({ default: {} }));
vi.mock('data/databases/channel', () => ({ default: { userId: undefined, clear: async () => undefined } }));
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

function resetServer() {
  fake.snapshots.length = 0;
  Object.assign(fake.server, {
    secret: undefined,
    invalidSecrets: 0,
    hangLogin: false,
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

  it('a hung login request releases the lock after LOGIN_LOCK_HOLD_MAX_MS', async () => {
    useDataLayerFakeTimers();
    setup();
    storeUser('u1', 'dev-1');
    const a = await openTab();
    const b = await openTab();
    fake.server.hangLogin = true;
    const loginA = a.loginManager.autoLogin().then(() => 'ok', (e: Error) => e.message);
    for (let i = 0; i < 1000 && (await navigator.locks.query()).held!.length === 0; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    const loginB = b.loginManager.autoLogin().then(() => 'ok', (e: Error) => e.message);
    await settle();
    fake.server.hangLogin = false;
    const { LOGIN_LOCK_HOLD_MAX_MS } = await import('data/appstate/authBroadcast');
    await vi.advanceTimersByTimeAsync(LOGIN_LOCK_HOLD_MAX_MS);
    for (let i = 0; i < 1000 && fake.server.loginCalls === 0; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
    expect(await loginA).toBe('LOGIN_LOCK_HOLD_TIMEOUT');
    expect(await loginB).toBe('ok');
    expect(b.loginManager.state).toBe('loggedin');
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
    // until the login waits for the lock (signing takes real time)
    for (let i = 0; i < 1000 && (await navigator.locks.query()).pending!.length === 0; i++) {
      await new Promise<void>(resolve => setImmediate(resolve));
    }
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

    await a.loginManager.logout();
    await settle();

    expect(fake.server.logoutCalls).toBe(1);
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
    channel.postMessage({ v: 1, type: 'logged-in', tabId: 'other-tab', userId: 'u1' } satisfies AuthBroadcastMessage);
    await settle();

    expect(fake.server.loginCalls).toBe(0);
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
