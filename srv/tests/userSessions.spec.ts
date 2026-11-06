// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The index of each user's sessions, the session generations and signing out
 * the other devices (srv/util/userSessions.ts, srv/util/sessionGenerations.ts,
 * srv/util/signOutOtherDevices.ts), with the real express-session, its
 * in-memory store wrapped like in production (index + generation copies +
 * revocation) and the login/logout helpers; races are interleaved with
 * gates. The PostgreSQL side (sequence, users."sessionGeneration", the bump)
 * is an in-memory stand-in with the same rules here; the SQL itself, its
 * locks and the Valkey script run for real in securityStepDb.spec.ts. Plus
 * the store TTL of sessions without a logged-in user
 * (srv/util/sessionSetup.ts) through connect-redis.
 */

process.env.BASE_URL = 'https://cg.box';
process.env.DEPLOYMENT = 'prod';
process.env.REDIS_SECRET = 'test-secret-0123456789';
delete process.env.CG_LEGACY_CGID;

import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

/** users."sessionGeneration" and the sequence, with the rules of srv/repositories/users.ts */
const db = { seq: 0, gens: new Map<string, number>(), deviceGens: new Map<string, number>() };
const bump = async (userId: string, callerGeneration: number, keepDeviceId: string) => {
  if (callerGeneration < (db.gens.get(userId) ?? 0)) {
    throw new Error('LOGIN_REQUIRED');
  }
  const gen = ++db.seq;
  db.gens.set(userId, gen);
  db.deviceGens.set(keepDeviceId, gen);
  return gen;
};
const users = {
  nextSessionGeneration: jest.fn(async () => ++db.seq),
  getSessionGeneration: jest.fn(async (userId: string) => db.gens.get(userId) ?? 0),
  bumpSessionGeneration: jest.fn(async (_client: unknown, userId: string, callerGeneration: number, keepDeviceId: string) => bump(userId, callerGeneration, keepDeviceId)),
  bumpSessionGenerationAlone: jest.fn(bump),
  sessionGenerationsSince: jest.fn(async (after: number) => ({
    upTo: db.seq,
    rows: [...db.gens].filter(([, gen]) => gen > after).map(([userId, gen]) => ({ userId, gen })),
  })),
};
const deleteStaleDevices = jest.fn(async (_userId: string, _gen: number): Promise<string[]> => []);
const signOutDeviceSockets = jest.fn(async (_deviceIds: string[]) => undefined);
const deleteStaleTransferTokens = jest.fn(async (_userId: string, _gen: number) => 0);
jest.doMock('../repositories/users', () => ({ __esModule: true, default: users }));
jest.doMock('../repositories/device', () => ({ __esModule: true, default: { deleteStaleDevices } }));
jest.doMock('../repositories/event', () => ({ __esModule: true, default: { signOutDeviceSockets } }));
jest.doMock('../repositories/transferTokens', () => ({ __esModule: true, default: { deleteStale: deleteStaleTransferTokens } }));

import { establishLoginSession, endLoginSession } from '../util/authSession';
import { createSessionMiddlewares, withSessionRevocation, sessionStoreTtlSeconds, ANONYMOUS_SESSION_TTL_MS } from '../util/sessionSetup';
import { endOtherSessions, redisUserSessionIndex, setLoginGeneration, withUserSessionIndex, type UserSessionIndex } from '../util/userSessions';
import { GenerationReconciler, type SessionGenerations } from '../util/sessionGenerations';
import { changeAndSignOut, signOutOtherDevices } from '../util/signOutOtherDevices';
import { SIGNUP_CAPTCHA_TTL_MS, SIGNUP_VERIFIED_TTL_MS } from '../util/signupEmail';

const COOKIE = 'connect.sid';
const ALICE = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
const HOUR = 60 * 60 * 1000;

/** the index in memory: user → (session id → expiry) */
function memoryIndex() {
  const users = new Map<string, Map<string, number>>();
  const index: UserSessionIndex & { users: typeof users } = {
    users,
    record: async (userId, sid, expiresAt) => {
      const entries = users.get(userId) ?? new Map<string, number>();
      for (const [id, expiry] of entries) {
        if (expiry <= Date.now()) entries.delete(id);
      }
      entries.set(sid, expiresAt);
      users.set(userId, entries);
    },
    forget: async (userId, sid) => {
      users.get(userId)?.delete(sid);
    },
    list: async (userId) => [...(users.get(userId) ?? new Map<string, number>())]
      .filter(([, expiry]) => expiry > Date.now())
      .map(([sid]) => sid),
  };
  return index;
}

/** the Valkey copies in memory (set only if greater, like the script) */
function memoryCopies() {
  const state = { gens: new Map<string, number>(), keep: new Map<string, string>(), copied: 0, failReads: false, failWrites: 0, ready: true };
  const copies: SessionGenerations & { state: typeof state } = {
    state,
    read: async (userId) => {
      if (state.failReads) throw new Error('connection lost');
      return { gen: state.gens.get(userId) ?? 0, keepSid: state.keep.get(userId) ?? null };
    },
    publish: async (userId, gen, keepSid) => {
      if (state.failWrites > 0) {
        state.failWrites--;
        throw new Error('OOM command not allowed');
      }
      // one script: generation and kept session only with a newer generation
      if (gen > (state.gens.get(userId) ?? 0)) {
        state.gens.set(userId, gen);
        if (keepSid) state.keep.set(userId, keepSid);
      }
    },
    copiedUpTo: async () => state.copied,
    markCopied: async (upTo) => { state.copied = Math.max(state.copied, upTo); },
  };
  return copies;
}

function memoryRevocations() {
  const revoked = new Set<string>();
  return {
    revoked,
    revoke: async (sid: string) => { revoked.add(sid); },
    isRevoked: async (sid: string) => revoked.has(sid),
  };
}

function gate() {
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  return { release, released, entered, enteredPromise };
}

type App = {
  baseUrl: string;
  server: Server;
  store: session.MemoryStore;
  index: ReturnType<typeof memoryIndex>;
  copies: ReturnType<typeof memoryCopies>;
  discardDevice: jest.Mock;
  passwords: Map<string, string>;
  gates: Map<string, ReturnType<typeof gate>>;
};

async function startApp(): Promise<App> {
  const store = new session.MemoryStore();
  const index = memoryIndex();
  const copies = memoryCopies();
  const discardDevice = jest.fn(async (_deviceId: string) => undefined);
  const revocations = memoryRevocations();
  const passwords = new Map<string, string>();
  const gates = new Map<string, ReturnType<typeof gate>>();
  const waitAt = async (request: express.Request, name = 'gate') => {
    if (request.query[name]) {
      const g = gates.get(String(request.query[name]))!;
      g.entered();
      await g.released;
    }
  };
  const app = express();
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.use(createSessionMiddlewares(withSessionRevocation(withUserSessionIndex(store, index, {
    generations: copies,
    generationsReady: () => copies.state.ready,
    currentGeneration: (userId) => users.getSessionGeneration(userId),
    discardDevice,
  }), revocations), revocations));
  app.get('/read', (request, response) => {
    response.json({ user: request.session?.user?.id ?? null });
  });
  app.post('/secret', (request, response) => {
    request.session.signSecret = 'x'.repeat(20);
    response.json({});
  });
  // a password login: takes its generation, checks the password as it is
  // now, then (with ?gate=) waits before it creates its device and session
  app.post('/login', async (request, response) => {
    const userId = String(request.query.user ?? ALICE);
    const deviceId = String(request.query.device ?? 'device-1');
    try {
      setLoginGeneration(request, await users.nextSessionGeneration());
      const ok = request.query.password === undefined || request.query.password === (passwords.get(userId) ?? 'pw');
      await waitAt(request);
      if (!ok) {
        throw new Error('NOT_ALLOWED');
      }
      await establishLoginSession(request, { userId, deviceId, method: request.query.device ? 'password' : 'device' });
      response.json({});
    }
    catch (e) {
      response.json({ error: (e as Error).message });
    }
  });
  // a password change and the sign-out in one transaction (or refused);
  // ?gate= waits after the commit, before the steps that follow it;
  // ?before= waits before the change starts
  app.post('/change-password', async (request, response) => {
    try {
      await waitAt(request, 'before');
      const userId = request.session.user!.id;
      const { devices, delayed } = await changeAndSignOut(request, async (beforeCommit) => {
        if (request.query.refuse) {
          throw new Error('LAST_LOGIN_METHOD');
        }
        const previous = passwords.get(userId);
        passwords.set(userId, String(request.query.password));
        try {
          await beforeCommit({} as never);
        }
        catch (e) {
          // rolled back together
          if (previous === undefined) passwords.delete(userId); else passwords.set(userId, previous);
          throw e;
        }
        await waitAt(request);
      });
      response.json({ devices, delayed });
    }
    catch (e) {
      response.json({ error: (e as Error).message });
    }
  });
  app.post('/logout', async (request, response) => {
    await endLoginSession(request);
    response.json({});
  });
  app.post('/sign-out-others', async (request, response) => {
    try {
      await waitAt(request);
      response.json(await signOutOtherDevices(request));
    }
    catch (e) {
      response.json({ error: (e as Error).message });
    }
  });
  // loads the session, waits, then writes and saves it (its copy as loaded)
  app.post('/slow', async (request, response) => {
    await waitAt(request);
    request.session.securityStepClearFor = { userId: ALICE, version: null };
    await new Promise<void>(resolve => request.session.save(() => resolve()));
    response.json({});
  });
  const server = app.listen(0);
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    server, store, index, copies, discardDevice, passwords, gates,
  };
}

async function call(app: App, method: 'GET' | 'POST', path: string, cookie?: string) {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    headers: { 'x-forwarded-proto': 'https', ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}) },
  });
  const text = await response.text();
  const body = (response.headers.get('content-type')?.includes('json') ? JSON.parse(text) : { status: response.status }) as Record<string, unknown>;
  const cookies = response.headers.getSetCookie()
    .filter(line => line.startsWith(`${COOKIE}=`) && !/Expires=Thu, 01 Jan 1970/.test(line))
    .map(line => line.slice(COOKIE.length + 1).split(';')[0]);
  return { body, cookies };
}

const sid = (cookieValue: string) => decodeURIComponent(cookieValue).slice(2).split('.')[0];

function storedIds(app: App): Promise<string[]> {
  return new Promise((resolve, reject) => app.store.all((e, all) => (e ? reject(e) : resolve(Object.keys(all ?? {})))));
}

function stored(app: App, id: string): Promise<session.SessionData | null | undefined> {
  return new Promise((resolve) => app.store.get(id, (_e, data) => resolve(data)));
}

/** a logged-in browser: its own anonymous session first, then an interactive login */
async function signIn(app: App, userId: string, deviceId: string): Promise<string> {
  const anonymous = (await call(app, 'POST', '/secret')).cookies[0];
  const login = await call(app, 'POST', `/login?user=${userId}&device=${deviceId}`, anonymous);
  expect(login.body).toEqual({});
  return login.cookies[0];
}

/** starts a request that waits at gate `name`; resolves once it waits */
async function startGated(app: App, name: string, path: string, cookie?: string, param = 'gate') {
  const g = gate();
  app.gates.set(name, g);
  const pending = call(app, 'POST', `${path}${path.includes('?') ? '&' : '?'}${param}=${name}`, cookie);
  await g.enteredPromise;
  return { finish: async () => { g.release(); return pending; } };
}

let app: App;
let warn: jest.SpyInstance;
beforeAll(async () => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  app = await startApp();
});
afterAll(async () => {
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
  warn.mockRestore();
});
beforeEach(() => {
  app.store.clear();
  app.index.users.clear();
  app.copies.state.gens.clear();
  app.copies.state.keep.clear();
  app.copies.state.failReads = false;
  app.copies.state.failWrites = 0;
  app.copies.state.copied = 0;
  app.copies.state.ready = true;
  app.passwords.clear();
  db.seq = 0;
  db.gens.clear();
  db.deviceGens.clear();
  jest.clearAllMocks();
});

describe('the index of a user\'s sessions', () => {
  it('a login records the session, a touch only when its expiry moved, logout drops it', async () => {
    const record = jest.spyOn(app.index, 'record');
    try {
      const anonymous = (await call(app, 'POST', '/secret')).cookies[0];
      expect(app.index.users.size).toBe(0);
      const cookie = (await call(app, 'POST', `/login?user=${ALICE}&device=device-1`, anonymous)).cookies[0];
      expect(await app.index.list(ALICE)).toEqual([sid(cookie)]);
      expect(app.index.users.get(ALICE)!.get(sid(cookie))!).toBeGreaterThan(Date.now() + 12 * HOUR - 60_000);
      const recorded = record.mock.calls.length;
      // requests within minutes do not write the index again
      await call(app, 'GET', '/read', cookie);
      await call(app, 'GET', '/read', cookie);
      expect(record.mock.calls.length).toBe(recorded);
      await call(app, 'POST', '/logout', cookie);
      expect(await app.index.list(ALICE)).toEqual([]);
    }
    finally {
      record.mockRestore();
    }
  });

  it('a login that replaces a logged-in session drops the old id', async () => {
    const before = await signIn(app, ALICE, 'device-1');
    const after = (await call(app, 'POST', `/login?user=${ALICE}&device=device-1`, before)).cookies[0];
    expect(sid(after)).not.toBe(sid(before));
    expect(await app.index.list(ALICE)).toEqual([sid(after)]);
    const bob = (await call(app, 'POST', `/login?user=${BOB}&device=device-9`, after)).cookies[0];
    expect(await app.index.list(ALICE)).toEqual([]);
    expect(await app.index.list(BOB)).toEqual([sid(bob)]);
  });

  it('ids whose session is gone are pruned when read; entries past their expiry are not listed', async () => {
    const a = await signIn(app, ALICE, 'device-1');
    const b = await signIn(app, ALICE, 'device-2');
    await new Promise<void>(resolve => app.store.destroy(sid(b), () => resolve()));
    expect(await app.index.list(ALICE)).toHaveLength(2);
    await endOtherSessions(app.store, app.index, ALICE, sid(a), Number.MAX_SAFE_INTEGER);
    expect(await app.index.list(ALICE)).toEqual([sid(a)]);
    app.index.users.get(ALICE)!.set('expired', Date.now() - 1);
    expect(await app.index.list(ALICE)).toEqual([sid(a)]);
  });

  it('is best effort: a write it refuses neither fails the login nor later requests', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const record = jest.spyOn(app.index, 'record').mockRejectedValue(new Error('OOM command not allowed'));
    try {
      const cookie = await signIn(app, ALICE, 'device-1');
      expect((await call(app, 'GET', '/read', cookie)).body).toEqual({ user: ALICE });
      expect(error).toHaveBeenCalled();
    }
    finally {
      record.mockRestore();
      error.mockRestore();
    }
  });
});

describe('signing out the other devices', () => {
  it('ends every other session; old device keys and links are cleaned up after the commit; this device stays', async () => {
    const here = await signIn(app, ALICE, 'device-1');
    const laptop = await signIn(app, ALICE, 'device-2');
    const phone = await signIn(app, ALICE, 'device-3');
    const bob = await signIn(app, BOB, 'device-9');
    deleteStaleDevices.mockResolvedValueOnce(['device-2', 'device-3', 'device-4']);

    const result = await call(app, 'POST', '/sign-out-others', here);
    expect(result.body).toEqual({ devices: 3, delayed: false });
    const gen = db.gens.get(ALICE)!;
    expect(gen).toBeGreaterThan(0);
    // this device carries the new generation; the old keys go
    expect(db.deviceGens.get('device-1')).toBe(gen);
    expect(deleteStaleDevices).toHaveBeenCalledWith(ALICE, gen);
    expect(signOutDeviceSockets).toHaveBeenCalledWith(['device-2', 'device-3', 'device-4']);
    expect(deleteStaleTransferTokens).toHaveBeenCalledWith(ALICE, gen);
    expect(app.copies.state.gens.get(ALICE)).toBe(gen);

    expect((await storedIds(app)).sort()).toEqual([sid(here), sid(bob)].sort());
    expect((await stored(app, sid(here)))?.gen).toBe(gen);
    expect((await call(app, 'GET', '/read', laptop)).body).toEqual({ user: null });
    expect((await call(app, 'GET', '/read', phone)).body).toEqual({ user: null });
    expect((await call(app, 'GET', '/read', here)).body).toEqual({ user: ALICE });
    expect((await call(app, 'GET', '/read', bob)).body).toEqual({ user: BOB });
  });

  it('a request still running with a signed-out session neither writes it back nor re-sends its cookie', async () => {
    const here = await signIn(app, ALICE, 'device-1');
    const other = await signIn(app, ALICE, 'device-2');
    const slow = await startGated(app, 'g', '/slow', other);
    await call(app, 'POST', '/sign-out-others', here);
    const late = await slow.finish();
    expect(late.cookies).toEqual([]);
    expect(await storedIds(app)).toEqual([sid(here)]);
    expect((await call(app, 'GET', '/read', other)).body).toEqual({ user: null });
  });

  it('needs a logged-in session', async () => {
    const anonymous = (await call(app, 'POST', '/secret')).cookies[0];
    expect((await call(app, 'POST', '/sign-out-others', anonymous)).body).toEqual({ error: 'LOGIN_REQUIRED' });
    expect(users.bumpSessionGenerationAlone).not.toHaveBeenCalled();
  });
});

describe('session generations', () => {
  it('(a) a login that checked the old password and saves its session between the commit and the steps after it is refused', async () => {
    app.passwords.set(ALICE, 'old');
    const here = await signIn(app, ALICE, 'device-1');
    const anonymous = (await call(app, 'POST', '/secret')).cookies[0];
    // the login takes its generation and checks the old password …
    const login = await startGated(app, 'login', `/login?user=${ALICE}&device=device-new&password=old`, anonymous);
    // … the change commits with the bump and waits before its later steps …
    const change = await startGated(app, 'change', '/change-password?password=new', here);
    // … the login creates its device and session in between
    const late = await login.finish();
    expect(late.body).toEqual({ error: 'NOT_ALLOWED' });
    expect(late.cookies).toEqual([]);
    expect(app.discardDevice).toHaveBeenCalledWith('device-new');
    expect((await change.finish()).body).toEqual({ devices: 0, delayed: false });
    expect(await storedIds(app)).toEqual([sid(here)]);
    expect((await call(app, 'GET', '/read', here)).body).toEqual({ user: ALICE });
  });

  it('(a) the same login finishing after the whole sign-out is refused as well', async () => {
    app.passwords.set(ALICE, 'old');
    const here = await signIn(app, ALICE, 'device-1');
    const anonymous = (await call(app, 'POST', '/secret')).cookies[0];
    const login = await startGated(app, 'login2', `/login?user=${ALICE}&device=device-new&password=old`, anonymous);
    expect((await call(app, 'POST', '/change-password?password=new', here)).body).toEqual({ devices: 0, delayed: false });
    const late = await login.finish();
    expect(late.body).toEqual({ error: 'NOT_ALLOWED' });
    expect(app.discardDevice).toHaveBeenCalledWith('device-new');
    expect(await storedIds(app)).toEqual([sid(here)]);
  });

  it('(b) a login that starts after the change fails with the old password and works with the new one', async () => {
    app.passwords.set(ALICE, 'old');
    const here = await signIn(app, ALICE, 'device-1');
    await call(app, 'POST', '/change-password?password=new', here);
    const anonymous = (await call(app, 'POST', '/secret')).cookies[0];
    expect((await call(app, 'POST', `/login?user=${ALICE}&device=device-2&password=old`, anonymous)).body).toEqual({ error: 'NOT_ALLOWED' });
    expect(app.discardDevice).not.toHaveBeenCalled();
    const later = (await call(app, 'POST', `/login?user=${ALICE}&device=device-2&password=new`, anonymous)).cookies[0];
    expect((await call(app, 'GET', '/read', later)).body).toEqual({ user: ALICE });
    expect((await stored(app, sid(later)))!.gen!).toBeGreaterThan(db.gens.get(ALICE)!);
  });

  it('(c) a refused change bumps nothing; the other devices stay signed in', async () => {
    const here = await signIn(app, ALICE, 'device-1');
    const other = await signIn(app, ALICE, 'device-2');
    expect((await call(app, 'POST', '/change-password?refuse=1', here)).body).toEqual({ error: 'LAST_LOGIN_METHOD' });
    expect(db.gens.get(ALICE)).toBeUndefined();
    expect(app.copies.state.gens.size).toBe(0);
    expect(deleteStaleDevices).not.toHaveBeenCalled();
    expect((await call(app, 'GET', '/read', other)).body).toEqual({ user: ALICE });
  });

  it('(d) the own session written back with the old generation (lost update) is stamped again, not ended', async () => {
    const here = await signIn(app, ALICE, 'device-1');
    const other = await signIn(app, ALICE, 'device-2');
    const before = (await stored(app, sid(here)))!.gen!;
    const slow = await startGated(app, 'own', '/slow', here);
    await call(app, 'POST', '/sign-out-others', here);
    const gen = db.gens.get(ALICE)!;
    expect((await stored(app, sid(here)))?.gen).toBe(gen);
    await slow.finish();
    expect((await stored(app, sid(here)))?.gen).toBe(before);
    expect((await call(app, 'GET', '/read', here)).body).toEqual({ user: ALICE });
    expect((await stored(app, sid(here)))?.gen).toBe(gen);
    expect((await call(app, 'GET', '/read', other)).body).toEqual({ user: null });
  });

  it('a session already signed out by another device cannot sign anyone out', async () => {
    const first = await signIn(app, ALICE, 'device-1');
    const second = await signIn(app, ALICE, 'device-2');
    // the second device's request passed the check at load …
    const late = await startGated(app, 'late', '/change-password?password=x', second, 'before');
    // … when the first device signs the others out
    await call(app, 'POST', '/sign-out-others', first);
    const gen = db.gens.get(ALICE);
    expect((await late.finish()).body).toEqual({ error: 'LOGIN_REQUIRED' });
    expect(db.gens.get(ALICE)).toBe(gen);
    expect(app.passwords.get(ALICE)).toBeUndefined();
    expect((await call(app, 'GET', '/read', first)).body).toEqual({ user: ALICE });
  });

  it('(f) a session from before generations existed (none stored, not indexed) ends after the first sign-out', async () => {
    const here = await signIn(app, ALICE, 'device-1');
    const old = await signIn(app, ALICE, 'device-2');
    const data = (await stored(app, sid(old)))!;
    delete data.gen;
    await new Promise<void>((resolve) => app.store.set(sid(old), data, () => resolve()));
    await app.index.forget(ALICE, sid(old));
    expect((await call(app, 'GET', '/read', old)).body).toEqual({ user: ALICE });
    await app.index.forget(ALICE, sid(old));

    await call(app, 'POST', '/sign-out-others', here);
    expect(await storedIds(app)).toContain(sid(old));
    const next = await call(app, 'GET', '/read', old);
    expect(next.body).toEqual({ user: null });
    expect(next.cookies).toEqual([]);
    expect(await storedIds(app)).toEqual([sid(here)]);
  });

  it('a failed copy to Valkey is retried; if it never arrives, the response says so and the reconciler heals it', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const reconciler = new GenerationReconciler(app.copies, (after) => users.sessionGenerationsSince(after));
      expect(await reconciler.reconcile()).toBe(true);
      const here = await signIn(app, ALICE, 'device-1');
      const old = await signIn(app, ALICE, 'device-2');
      await app.index.forget(ALICE, sid(old));
      // one failure: the retry gets it through
      app.copies.state.failWrites = 1;
      expect((await call(app, 'POST', '/sign-out-others', here)).body).toEqual({ devices: 0, delayed: false });
      expect(app.copies.state.gens.get(ALICE)).toBe(db.gens.get(ALICE));
      expect((await call(app, 'GET', '/read', old)).body).toEqual({ user: null });
      // it never arrives: the response says the others end within a minute …
      const another = await signIn(app, ALICE, 'device-3');
      await app.index.forget(ALICE, sid(another));
      app.copies.state.failWrites = 3;
      expect((await call(app, 'POST', '/sign-out-others', here)).body).toEqual({ devices: 0, delayed: true });
      expect((await call(app, 'GET', '/read', another)).body).toEqual({ user: ALICE });
      // … and the next reconcile run copies it
      expect(await reconciler.reconcile()).toBe(true);
      expect(app.copies.state.gens.get(ALICE)).toBe(db.gens.get(ALICE));
      expect((await call(app, 'GET', '/read', another)).body).toEqual({ user: null });
      expect((await call(app, 'GET', '/read', here)).body).toEqual({ user: ALICE });
      // Valkey restored from an older snapshot: its record of what it holds is
      // behind, so the next run copies from there again
      const third = await signIn(app, ALICE, 'device-4');
      await app.index.forget(ALICE, sid(third));
      app.copies.state.failWrites = 3;
      await call(app, 'POST', '/sign-out-others', here);
      expect(await reconciler.reconcile()).toBe(true);
      app.copies.state.gens.clear();
      app.copies.state.copied = 0;
      expect(await reconciler.reconcile()).toBe(true);
      expect(app.copies.state.gens.get(ALICE)).toBe(db.gens.get(ALICE));
      expect((await call(app, 'GET', '/read', third)).body).toEqual({ user: null });
    }
    finally {
      error.mockRestore();
    }
  });

  it('until the copies were reconciled once (api start), logged-in requests fail; anonymous ones work', async () => {
    const here = await signIn(app, ALICE, 'device-1');
    app.copies.state.ready = false;
    expect((await call(app, 'GET', '/read', here)).body).toEqual({ status: 500 });
    expect((await call(app, 'GET', '/read')).body).toEqual({ user: null });
    app.copies.state.ready = true;
    expect((await call(app, 'GET', '/read', here)).body).toEqual({ user: ALICE });
  });

  it('the reconciler retries until its first run succeeds', async () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    let failures = 2;
    const reconciler = new GenerationReconciler(app.copies, async (after) => {
      if (failures-- > 0) throw new Error('LOADING Valkey is loading the dataset in memory');
      return users.sessionGenerationsSince(after);
    });
    try {
      reconciler.start({ regular: 60_000, retry: 5 });
      expect(reconciler.ready).toBe(false);
      await new Promise(resolve => setTimeout(resolve, 100));
      expect(reconciler.ready).toBe(true);
    }
    finally {
      reconciler.stop();
      error.mockRestore();
    }
  });

  it('a generation that cannot be read fails the request instead of trusting the session', async () => {
    const here = await signIn(app, ALICE, 'device-1');
    app.copies.state.failReads = true;
    expect((await call(app, 'GET', '/read', here)).body).toEqual({ status: 500 });
    app.copies.state.failReads = false;
    expect((await call(app, 'GET', '/read', here)).body).toEqual({ user: ALICE });
  });
});

describe('the index on Valkey', () => {
  it('records with the expiry as score, prunes what ran out, and lets the key live as long as its newest entry', async () => {
    const commands: unknown[][] = [];
    const client = {
      zAdd: async (...args: unknown[]) => { commands.push(['zAdd', ...args]); },
      zRemRangeByScore: async (...args: unknown[]) => { commands.push(['zRemRangeByScore', ...args]); },
      zRem: async (...args: unknown[]) => { commands.push(['zRem', ...args]); },
      zRangeByScore: async (...args: unknown[]) => { commands.push(['zRangeByScore', ...args]); return ['s1']; },
      pExpireAt: async (...args: unknown[]) => { commands.push(['pExpireAt', ...args]); },
    };
    jest.useFakeTimers({ now: 1_000_000 });
    try {
      const index = redisUserSessionIndex(client);
      await index.record(ALICE, 's1', 2_000_000);
      await index.forget(ALICE, 's0');
      expect(await index.list(ALICE)).toEqual(['s1']);
    }
    finally {
      jest.useRealTimers();
    }
    const key = `sess-user:${ALICE}`;
    expect(commands).toEqual([
      ['zAdd', key, { score: 2_000_000, value: 's1' }],
      ['zRemRangeByScore', key, '-inf', 1_000_000],
      ['pExpireAt', key, 2_000_000],
      ['zRem', key, 's0'],
      ['zRangeByScore', key, '(1000000', '+inf'],
    ]);
  });
});

describe('sessions without a logged-in user', () => {
  const now = Date.parse('2026-11-01T12:00:00Z');
  const cookie = { expires: new Date(now + 12 * HOUR) };

  it('are kept for an hour; logged-in ones for the rest of the cookie', () => {
    expect(ANONYMOUS_SESSION_TTL_MS).toBe(60 * 60 * 1000);
    expect(sessionStoreTtlSeconds({ cookie, signSecret: 'x' }, now)).toBe(60 * 60);
    expect(sessionStoreTtlSeconds({ cookie, user: { id: ALICE, deviceId: 'd' } }, now)).toBe(12 * 60 * 60);
    // never beyond the cookie
    expect(sessionStoreTtlSeconds({ cookie: { expires: new Date(now + 60_000) }, signSecret: 'x' }, now)).toBe(60);
  });

  it('a sign-up in progress keeps its session as long as it needs it', () => {
    // a verified address counts for an hour
    const verified = { email: 'a@example.org', expiresAt: now + SIGNUP_VERIFIED_TTL_MS, attempts: 0, verifiedAt: now, captchaAt: now - 60 * 60 * 1000 };
    expect(sessionStoreTtlSeconds({ cookie, signupEmail: verified }, now)).toBe(SIGNUP_VERIFIED_TTL_MS / 1000);
    // the solved captcha counts for a new code for two hours
    const codeSent = { email: 'a@example.org', expiresAt: now + 15 * 60 * 1000, attempts: 0, captchaAt: now };
    expect(sessionStoreTtlSeconds({ cookie, signupEmail: codeSent }, now)).toBe(SIGNUP_CAPTCHA_TTL_MS / 1000);
    // both over: the plain hour
    const old = { email: 'a@example.org', expiresAt: now - 1, attempts: 0, captchaAt: now - 3 * HOUR };
    expect(sessionStoreTtlSeconds({ cookie, signupEmail: old }, now)).toBe(60 * 60);
  });

  it('connect-redis writes them with the short TTL, and with the full one from login on', async () => {
    const { RedisStore } = require('connect-redis') as typeof import('connect-redis');
    const data = new Map<string, string>();
    const writes: { key: string; ttl: number }[] = [];
    const expiries: { key: string; ttl: number }[] = [];
    const client = {
      get: async (key: string) => data.get(key) ?? null,
      set: async (key: string, value: string, options: { expiration: { value: number } }) => {
        data.set(key, value);
        writes.push({ key, ttl: options.expiration.value });
        return 'OK';
      },
      expire: async (key: string, ttl: number) => { expiries.push({ key, ttl }); return 1; },
      del: async (keys: string[]) => { for (const key of keys) data.delete(key); return keys.length; },
    };
    const store = new RedisStore({ client: client as never, prefix: 'sess:', ttl: sessionStoreTtlSeconds });
    const revocations = memoryRevocations();
    const redisApp = express();
    redisApp.set('trust proxy', true);
    redisApp.use(cookieParser());
    redisApp.use(createSessionMiddlewares(withSessionRevocation(withUserSessionIndex(store, memoryIndex()), revocations), revocations));
    redisApp.post('/secret', (request, response) => {
      request.session.signSecret = 'x'.repeat(20);
      response.json({});
    });
    redisApp.get('/read', (request, response) => {
      response.json({});
    });
    redisApp.post('/login', async (request, response) => {
      setLoginGeneration(request, 1);
      await establishLoginSession(request, { userId: ALICE, deviceId: 'device-1', method: 'password' });
      response.json({});
    });
    const server = redisApp.listen(0);
    const redis: App = { ...app, baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
    try {
      const anonymous = (await call(redis, 'POST', '/secret')).cookies[0];
      expect(writes).toEqual([{ key: `sess:${sid(anonymous)}`, ttl: 60 * 60 }]);
      // a later request of the anonymous session keeps the short TTL
      await call(redis, 'GET', '/read', anonymous);
      expect(expiries).toEqual([{ key: `sess:${sid(anonymous)}`, ttl: 60 * 60 }]);
      const loggedIn = (await call(redis, 'POST', '/login', anonymous)).cookies[0];
      expect(writes[writes.length - 1]).toEqual({ key: `sess:${sid(loggedIn)}`, ttl: 12 * 60 * 60 });
      await call(redis, 'GET', '/read', loggedIn);
      expect(expiries[expiries.length - 1]).toEqual({ key: `sess:${sid(loggedIn)}`, ttl: 12 * 60 * 60 });
    }
    finally {
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    }
  });
});
