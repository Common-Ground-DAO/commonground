// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Session setup (srv/util/sessionSetup.ts) with the real express-session and
 * its in-memory store, plus the login/logout helpers (srv/util/authSession.ts):
 * a request that stores nothing creates no session and gets no session cookie;
 * a write creates the session and sets the cookie once; only the cookie of a
 * logged-in session is re-sent with every response; a destroyed or replaced
 * session is neither written back nor re-sent by a request that loaded it
 * before. Production cookie settings, behind the proxy.
 */

process.env.BASE_URL = 'https://cg.box';
process.env.DEPLOYMENT = 'prod';
process.env.REDIS_SECRET = 'test-secret-0123456789';
delete process.env.CG_LEGACY_CGID;

import express from 'express';
import session from 'express-session';
import cookieParser from 'cookie-parser';
import { Readable } from 'stream';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const COOKIE = 'connect.sid';
const USER = '00000000-0000-4000-8000-000000000001';

type SetupModule = typeof import('../util/sessionSetup');

/** in-memory revocations (no TTL needed here) */
function memoryRevocations() {
  const revoked = new Set<string>();
  return {
    revoke: async (sid: string) => { revoked.add(sid); },
    isRevoked: async (sid: string) => revoked.has(sid),
  };
}

/** a handler that waits for the test: `entered` resolves once it runs, `release()` lets it finish */
function gate() {
  let release!: () => void;
  let entered!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  const enteredPromise = new Promise<void>(resolve => { entered = resolve; });
  return { release, released, entered, enteredPromise };
}

type App = { baseUrl: string; store: session.MemoryStore; server: Server; gates: Map<string, ReturnType<typeof gate>> };

async function startApp(setup: SetupModule, sessionModule: typeof session): Promise<App> {
  const { establishLoginSession, endLoginSession } = await import('../util/authSession');
  const { setLoginGeneration } = await import('../util/userSessions');
  let generation = 0;
  const store = new sessionModule.MemoryStore();
  const revocations = memoryRevocations();
  const gates = new Map<string, ReturnType<typeof gate>>();
  const app = express();
  app.set('trust proxy', true);
  app.use(cookieParser());
  app.use(setup.createSessionMiddlewares(setup.withSessionRevocation(store, revocations), revocations));
  app.get('/read', (request, response) => {
    response.json({ user: request.session.user?.id ?? null });
  });
  app.get('/redirect', (request, response) => {
    response.redirect('/read');
  });
  app.post('/secret', (request, response) => {
    request.session.signSecret = 'x'.repeat(20);
    response.json({});
  });
  app.post('/modify', (request, response) => {
    request.session.securityStepClearFor = { userId: USER, version: null };
    response.json({});
  });
  // waits on the gate named in ?gate=, then optionally writes (and saves)
  app.post('/slow', async (request, response) => {
    const g = gates.get(String(request.query.gate))!;
    g.entered();
    await g.released;
    if (request.query.write) {
      request.session.securityStepClearFor = { userId: USER, version: null };
    }
    if (request.query.save) {
      await new Promise<void>(resolve => request.session.save(() => resolve()));
    }
    if (request.query.stream) {
      // headers go out with the first write (like the gated-file routes)
      Readable.from(['stream', 'ed']).pipe(response);
      return;
    }
    response.json({});
  });
  app.post('/login', async (request, response) => {
    // a login takes its session generation first (srv/api/user.ts beginLogin)
    setLoginGeneration(request, ++generation);
    await establishLoginSession(request, { userId: USER, deviceId: 'device-1', method: request.query.method === 'password' ? 'password' : 'device' });
    response.json({});
  });
  app.post('/logout', async (request, response) => {
    await endLoginSession(request);
    response.json({});
  });
  const server = app.listen(0);
  return { baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, store, server, gates };
}

async function stopApp(app: App) {
  app.server.closeAllConnections();
  await new Promise(resolve => app.server.close(resolve));
}

type Result = { body: string; status: number; sessionCookies: string[]; cookieLines: string[]; cleared: string[]; legacyCleared: boolean };

async function request(app: App, method: 'GET' | 'POST', path: string, cookie?: string, options: { https?: boolean } = {}): Promise<Result> {
  const response = await fetch(`${app.baseUrl}${path}`, {
    method,
    redirect: 'manual',
    headers: {
      ...(options.https === false ? {} : { 'x-forwarded-proto': 'https' }),
      ...(cookie ? { cookie: `${COOKIE}=${cookie}` } : {}),
    },
  });
  const body = await response.text();
  const lines = response.headers.getSetCookie().filter(line => line.startsWith(`${COOKIE}=`));
  const expired = (line: string) => /Expires=Thu, 01 Jan 1970/.test(line);
  return {
    body,
    status: response.status,
    cookieLines: lines.filter(line => !expired(line)),
    sessionCookies: lines.filter(line => !expired(line)).map(line => line.slice(COOKIE.length + 1).split(';')[0]),
    cleared: lines.filter(line => expired(line) && !/Domain=/i.test(line)),
    legacyCleared: lines.some(line => expired(line) && /Domain=\.cg\.box/i.test(line)),
  };
}

/** the session id inside a signed cookie value (`s:<id>.<signature>`) */
function sid(cookieValue: string) {
  return decodeURIComponent(cookieValue).slice(2).split('.')[0];
}

function storedIds(app: App): Promise<string[]> {
  return new Promise((resolve, reject) => app.store.all((e, all) => (e ? reject(e) : resolve(Object.keys(all ?? {})))));
}

/** starts POST /slow with `cookie`, resolves once its handler runs */
async function startSlow(app: App, cookie: string, query = '') {
  const name = `g${app.gates.size}`;
  const g = gate();
  app.gates.set(name, g);
  const pending = request(app, 'POST', `/slow?gate=${name}${query}`, cookie);
  await g.enteredPromise;
  return { finish: async () => { g.release(); return pending; } };
}

let warn: jest.SpyInstance;
let app: App;

beforeAll(async () => {
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  app = await startApp(await import('../util/sessionSetup'), session);
});

afterAll(async () => {
  await stopApp(app);
  warn.mockRestore();
});

async function loggedIn(): Promise<string> {
  const anonymous = (await request(app, 'POST', '/secret')).sessionCookies[0];
  return (await request(app, 'POST', '/login', anonymous)).sessionCookies[0];
}

describe('session setup', () => {
  beforeEach(() => app.store.clear());

  it('anonymous requests that store nothing create no session and send no cookie', async () => {
    const plain = await request(app, 'GET', '/read');
    expect(plain.status).toBe(200);
    expect(plain.sessionCookies).toEqual([]);
    expect(plain.legacyCleared).toBe(false);
    // a cookie of a session the store no longer knows (expired, deleted)
    const stale = await request(app, 'GET', '/read', 's%3Aunknown.signature');
    expect(stale.status).toBe(200);
    expect(stale.sessionCookies).toEqual([]);
    // the old subdomain-scoped cookie is expired, but no session is made for it
    expect(stale.legacyCleared).toBe(true);
    expect(await storedIds(app)).toEqual([]);
  });

  it('a write creates the session and sets its cookie once; an anonymous session does not roll', async () => {
    const created = await request(app, 'POST', '/secret');
    expect(created.sessionCookies).toHaveLength(1);
    const anonymous = created.sessionCookies[0];
    expect(await storedIds(app)).toEqual([sid(anonymous)]);
    const read = await request(app, 'GET', '/read', anonymous);
    expect(read.sessionCookies).toEqual([]);
  });

  it('login replaces the session; the logged-in cookie rolls with every response; logout leaves nothing', async () => {
    const anonymous = (await request(app, 'POST', '/secret')).sessionCookies[0];
    const login = await request(app, 'POST', '/login', anonymous);
    expect(login.sessionCookies).toHaveLength(1);
    const cookie = login.sessionCookies[0];
    expect(sid(cookie)).not.toBe(sid(anonymous));
    expect(await storedIds(app)).toEqual([sid(cookie)]);

    const read = await request(app, 'GET', '/read', cookie);
    // the same signed value express-session sets
    expect(read.sessionCookies).toEqual([cookie]);
    // the login marked the session: no more clearing of the old-scope cookie
    expect(read.legacyCleared).toBe(false);

    const logout = await request(app, 'POST', '/logout', cookie);
    expect(logout.sessionCookies).toEqual([]);
    expect(logout.cleared).toHaveLength(1);
    expect(await storedIds(app)).toEqual([]);
  });

  it('a device re-login of the same user keeps the session id', async () => {
    const cookie = await loggedIn();
    const again = await request(app, 'POST', '/login', cookie);
    expect(again.sessionCookies.map(sid)).toEqual([sid(cookie)]);
  });

  it('a logged-in session changed in the request gets exactly one cookie', async () => {
    const cookie = await loggedIn();
    const modified = await request(app, 'POST', '/modify', cookie);
    expect(modified.cookieLines).toHaveLength(1);
    expect(modified.sessionCookies.map(sid)).toEqual([sid(cookie)]);
  });

  it('a redirect still rolls the logged-in cookie', async () => {
    const cookie = await loggedIn();
    const redirect = await request(app, 'GET', '/redirect', cookie);
    expect(redirect.status).toBe(302);
    expect(redirect.sessionCookies).toEqual([cookie]);
  });

  it('no secure cookie is rolled over plain http', async () => {
    const cookie = await loggedIn();
    const plain = await request(app, 'GET', '/read', cookie, { https: false });
    expect(plain.sessionCookies).toEqual([]);
  });

  describe('a request that loaded the session before it went away', () => {
    it('logout: the in-flight request neither re-sends nor saves the logged-in session', async () => {
      const cookie = await loggedIn();
      const slow = await startSlow(app, cookie, '&write=1');
      await request(app, 'POST', '/logout', cookie);
      const late = await slow.finish();
      expect(late.sessionCookies).toEqual([]);
      expect(await storedIds(app)).toEqual([]);
      expect(await request(app, 'GET', '/read', cookie)).toMatchObject({ sessionCookies: [] });
    });

    it('logout: a streamed response neither re-sends nor saves the session', async () => {
      const cookie = await loggedIn();
      const slow = await startSlow(app, cookie, '&write=1&stream=1');
      await request(app, 'POST', '/logout', cookie);
      const late = await slow.finish();
      expect(late.body).toBe('streamed');
      expect(late.sessionCookies).toEqual([]);
      expect(await storedIds(app)).toEqual([]);
    });

    it('a streamed response of a live session still rolls its cookie', async () => {
      const cookie = await loggedIn();
      const slow = await startSlow(app, cookie, '&stream=1');
      const done = await slow.finish();
      expect(done.body).toBe('streamed');
      expect(done.sessionCookies).toEqual([cookie]);
    });

    it('logout: an explicit save of the old session is refused', async () => {
      const cookie = await loggedIn();
      const slow = await startSlow(app, cookie, '&write=1&save=1');
      await request(app, 'POST', '/logout', cookie);
      const late = await slow.finish();
      expect(late.sessionCookies).toEqual([]);
      expect(await storedIds(app)).toEqual([]);
    });

    it('interactive re-login: the old id is not sent after the new one', async () => {
      const before = await loggedIn();
      const slow = await startSlow(app, before);
      const relogin = await request(app, 'POST', '/login?method=password', before);
      const after = relogin.sessionCookies[0];
      expect(sid(after)).not.toBe(sid(before));
      const late = await slow.finish();
      expect(late.sessionCookies).toEqual([]);
      expect(await storedIds(app)).toEqual([sid(after)]);
    });

    it('anonymous pre-login session: a late write neither restores it nor sets its cookie', async () => {
      const anonymous = (await request(app, 'POST', '/secret')).sessionCookies[0];
      const slow = await startSlow(app, anonymous, '&write=1');
      const login = await request(app, 'POST', '/login', anonymous);
      const late = await slow.finish();
      expect(late.sessionCookies).toEqual([]);
      expect(await storedIds(app)).toEqual([sid(login.sessionCookies[0])]);
    });
  });
});

describe('legacy CG ID mode', () => {
  let legacy: App;

  beforeAll(async () => {
    process.env.CG_LEGACY_CGID = 'true';
    let setup!: SetupModule;
    let sessionModule!: typeof session;
    jest.isolateModules(() => {
      setup = require('../util/sessionSetup');
      sessionModule = require('express-session');
    });
    legacy = await startApp(setup, sessionModule);
  });

  afterAll(async () => {
    await stopApp(legacy);
    delete process.env.CG_LEGACY_CGID;
  });

  it('the cookie is host-only as well; an old subdomain-scoped cookie is expired', async () => {
    const created = await request(legacy, 'POST', '/secret');
    expect(created.cookieLines).toHaveLength(1);
    expect(created.cookieLines[0]).not.toMatch(/Domain=/i);
    const stale = await request(legacy, 'GET', '/read', 's%3Aunknown.signature');
    expect(stale.legacyCleared).toBe(true);
    expect(stale.sessionCookies).toEqual([]);
  });
});
