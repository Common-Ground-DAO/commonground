// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Session isolation between the main instance (cg.box) and a gateway
 * (app.cg) that share one Valkey (srv/util/gateway.ts): each runs the real
 * session stack of the api (connect-redis store with the instance's prefix,
 * revocations, the index of each user's sessions, the session generations,
 * createSessionMiddlewares with the instance's secret) on one shared
 * in-memory Valkey. A cookie or session id of one instance never works on
 * the other, and the keys the two write are disjoint — also the Socket.IO
 * channels.
 */

import express from 'express';
import cookieParser from 'cookie-parser';
import { RedisStore } from 'connect-redis';
import crypto from 'crypto';
import http from 'http';
import type { AddressInfo } from 'net';

const USER = '00000000-0000-4000-8000-000000000001';
const MAIN_SECRET = 'main-secret-0123456789abcdef';
const GATEWAY_SECRET = 'gateway-secret-0123456789abcdef';

// --- one shared in-memory Valkey, with every key it is asked about ----------

const strings = new Map<string, string>();
const zsets = new Map<string, Map<string, number>>();
const touchedBy: Record<string, Set<string>> = { main: new Set(), gateway: new Set() };
let actor: 'main' | 'gateway' = 'main';
const touch = (...keys: string[]) => keys.forEach(key => touchedBy[actor].add(key));

const zset = (key: string) => {
  if (!zsets.has(key)) {
    zsets.set(key, new Map());
  }
  return zsets.get(key)!;
};
const score = (value: number | string) => (value === '-inf' ? -Infinity : value === '+inf' ? Infinity : typeof value === 'string' && value.startsWith('(') ? Number(value.slice(1)) + 1e-9 : Number(value));

const valkey = {
  isReady: true,
  async get(key: string) { touch(key); return strings.get(key) ?? null; },
  async set(key: string, value: string) { touch(key); strings.set(key, value); return 'OK'; },
  async del(keys: string | string[]) { const list = Array.isArray(keys) ? keys : [keys]; touch(...list); let n = 0; for (const key of list) { n += strings.delete(key) ? 1 : 0; } return n; },
  async exists(key: string) { touch(key); return strings.has(key) ? 1 : 0; },
  async expire(key: string) { touch(key); return 1; },
  async pExpireAt(key: string) { touch(key); return 1; },
  async mGet(keys: string[]) { touch(...keys); return keys.map(key => strings.get(key) ?? null); },
  async zAdd(key: string, entry: { score: number; value: string }) { touch(key); zset(key).set(entry.value, entry.score); return 1; },
  async zRem(key: string, value: string) { touch(key); return zset(key).delete(value) ? 1 : 0; },
  async zRemRangeByScore(key: string, min: number | string, max: number | string) {
    touch(key);
    for (const [value, s] of zset(key)) {
      if (s >= score(min) && s <= score(max)) zset(key).delete(value);
    }
    return 1;
  },
  async zRangeByScore(key: string, min: number | string, max: number | string) {
    touch(key);
    return [...zset(key)].filter(([, s]) => s >= score(min) && s <= score(max)).map(([value]) => value);
  },
  // the SET_IF_GREATER script of srv/util/sessionGenerations.ts
  async eval(_script: string, options: { keys: string[]; arguments: string[] }) {
    touch(...options.keys);
    const [genKey, keepKey] = options.keys;
    const [gen, keepSid] = options.arguments;
    if (Number(gen) > Number(strings.get(genKey) ?? '0')) {
      strings.set(genKey, gen);
      if (keepSid !== '') strings.set(keepKey, keepSid);
      return 1;
    }
    return 0;
  },
};

// --- two instances ----------------------------------------------------------

type Instance = {
  name: 'main' | 'gateway';
  base: string;
  server: http.Server;
  sessionKeyPrefix: string;
  socketKey: string;
  modules: {
    revocations: ReturnType<typeof import('../util/sessionSetup')['redisSessionRevocations']>;
    index: ReturnType<typeof import('../util/userSessions')['redisUserSessionIndex']>;
    generations: ReturnType<typeof import('../util/sessionGenerations')['redisSessionGenerations']>;
  };
};

const ENVS = {
  main: { BASE_URL: 'https://cg.box', DEPLOYMENT: 'prod', REDIS_SECRET: MAIN_SECRET },
  gateway: { BASE_URL: 'https://app.cg', DEPLOYMENT: 'prod', REDIS_SECRET: GATEWAY_SECRET, CG_GATEWAY: 'true', CG_LEGACY_CGID: 'true', CGID_URL: 'https://id.app.cg', TRANSFER_TARGET_URL: 'https://cg.box' },
};

async function startInstance(name: 'main' | 'gateway'): Promise<Instance> {
  const saved = process.env;
  process.env = { ...saved, ...ENVS[name] };
  if (name === 'main') {
    delete process.env.CG_GATEWAY;
    delete process.env.CG_LEGACY_CGID;
  }
  let instance!: Omit<Instance, 'base' | 'server'> & { app: express.Express };
  jest.isolateModules(() => {
    const setup = require('../util/sessionSetup') as typeof import('../util/sessionSetup');
    const userSessions = require('../util/userSessions') as typeof import('../util/userSessions');
    const sessionGenerations = require('../util/sessionGenerations') as typeof import('../util/sessionGenerations');
    const gateway = require('../util/gateway') as typeof import('../util/gateway');
    // as srv/util/express.ts builds it
    const revocations = setup.redisSessionRevocations(valkey);
    const index = userSessions.redisUserSessionIndex(valkey);
    const generations = sessionGenerations.redisSessionGenerations(valkey);
    const store = userSessions.withUserSessionIndex(new RedisStore({
      client: valkey as never,
      prefix: setup.SESSION_KEY_PREFIX,
      ttl: setup.sessionStoreTtlSeconds,
    }), index, { generations, generationsReady: () => true });
    const app = express();
    app.set('trust proxy', true);
    app.use((_request, _response, next) => { actor = name; next(); });
    app.use(cookieParser());
    app.use(setup.createSessionMiddlewares(setup.withSessionRevocation(store, revocations), revocations));
    app.post('/login', (request, response, next) => {
      request.session.regenerate((e) => {
        if (e) return next(e);
        request.session.user = { id: USER, deviceId: `device-${name}` };
        request.session.gen = 0;
        request.session.save((e2) => (e2 ? next(e2) : response.json({ sid: request.sessionID })));
      });
    });
    app.get('/me', (request, response) => {
      response.json({ user: request.session?.user ?? null, sid: request.sessionID });
    });
    app.post('/logout', (request, response, next) => {
      request.session.destroy((e) => (e ? next(e) : response.json({ ok: true })));
    });
    instance = {
      name,
      app,
      sessionKeyPrefix: setup.SESSION_KEY_PREFIX,
      socketKey: gateway.socketIoKey(),
      modules: { revocations, index, generations },
    };
  });
  process.env = saved;
  const server = http.createServer(instance.app);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return { ...instance, server, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}` };
}

async function call(instance: Instance, method: 'GET' | 'POST', path: string, cookie?: string) {
  const response = await fetch(`${instance.base}${path}`, {
    method,
    // the edge terminates TLS (secure cookies need the proxy's header)
    headers: { 'x-forwarded-proto': 'https', ...(cookie ? { cookie } : {}) },
  });
  const setCookie = response.headers.getSetCookie();
  return { body: await response.json(), setCookie, cookie: setCookie[0]?.split(';')[0] };
}

/** a session cookie for `sid`, signed with `secret` like express-session does */
const signedCookie = (sid: string, secret: string) => {
  const signature = crypto.createHmac('sha256', secret).update(sid).digest('base64').replace(/=+$/, '');
  return `connect.sid=${encodeURIComponent(`s:${sid}.${signature}`)}`;
};

let main: Instance;
let gateway: Instance;

beforeAll(async () => {
  main = await startInstance('main');
  gateway = await startInstance('gateway');
});

afterAll(async () => {
  await Promise.all([main, gateway].map(instance => new Promise<void>(resolve => instance.server.close(() => resolve()))));
});

describe('a session of one instance', () => {
  it('works on its own instance only (the cookie of the other is not accepted)', async () => {
    const onMain = await call(main, 'POST', '/login');
    const onGateway = await call(gateway, 'POST', '/login');
    expect(onMain.cookie).toMatch(/^connect\.sid=s%3A/);
    expect(onGateway.cookie).toMatch(/^connect\.sid=s%3A/);

    expect((await call(main, 'GET', '/me', onMain.cookie)).body.user).toEqual({ id: USER, deviceId: 'device-main' });
    expect((await call(gateway, 'GET', '/me', onGateway.cookie)).body.user).toEqual({ id: USER, deviceId: 'device-gateway' });

    // the other instance's cookie: bad signature, so no session at all
    const crossToGateway = await call(gateway, 'GET', '/me', onMain.cookie);
    expect(crossToGateway.body.user).toBeNull();
    expect(crossToGateway.body.sid).not.toBe(onMain.body.sid);
    const crossToMain = await call(main, 'GET', '/me', onGateway.cookie);
    expect(crossToMain.body.user).toBeNull();
    expect(crossToMain.body.sid).not.toBe(onGateway.body.sid);
  });

  it('is unknown to the other instance even with that instance\'s signature (own store prefix)', async () => {
    const onMain = await call(main, 'POST', '/login');
    const onGateway = await call(gateway, 'POST', '/login');
    // someone who knew a session id and the other secret would still find nothing
    expect((await call(gateway, 'GET', '/me', signedCookie(onMain.body.sid, GATEWAY_SECRET))).body.user).toBeNull();
    expect((await call(main, 'GET', '/me', signedCookie(onGateway.body.sid, MAIN_SECRET))).body.user).toBeNull();
    // and with its own instance's signature it is found (the forging works)
    expect((await call(main, 'GET', '/me', signedCookie(onMain.body.sid, MAIN_SECRET))).body.user).not.toBeNull();
  });

  it('is host-only on both instances: no other host under either domain receives it', async () => {
    const onMain = await call(main, 'POST', '/login');
    const onGateway = await call(gateway, 'POST', '/login');
    expect(onMain.setCookie[0]).not.toMatch(/Domain=/i);
    expect(onGateway.setCookie[0]).not.toMatch(/Domain=/i);
    expect(onGateway.setCookie[0]).toMatch(/Secure/);
    expect(onGateway.setCookie[0]).toMatch(/HttpOnly/);
  });

  it('logged out on one instance leaves the other alone', async () => {
    const onMain = await call(main, 'POST', '/login');
    const onGateway = await call(gateway, 'POST', '/login');
    await call(main, 'POST', '/logout', onMain.cookie);
    expect((await call(main, 'GET', '/me', onMain.cookie)).body.user).toBeNull();
    expect((await call(gateway, 'GET', '/me', onGateway.cookie)).body.user).not.toBeNull();
  });
});

describe('Valkey keys', () => {
  it('of the two instances are disjoint; the gateway\'s all carry its prefix, the main instance\'s keep their names', async () => {
    // exercise every per-instance key family directly as well
    for (const instance of [main, gateway]) {
      actor = instance.name;
      await instance.modules.revocations.revoke('sid-x');
      await instance.modules.revocations.isRevoked('sid-x');
      await instance.modules.index.record(USER, 'sid-x', Date.now() + 60_000);
      await instance.modules.index.list(USER);
      await instance.modules.generations.publish(USER, 5, 'sid-x');
      await instance.modules.generations.read(USER);
      await instance.modules.generations.markCopied(5);
      await instance.modules.generations.copiedUpTo();
    }
    const mainKeys = [...touchedBy.main];
    const gatewayKeys = [...touchedBy.gateway];
    expect(mainKeys.filter(key => gatewayKeys.includes(key))).toEqual([]);
    for (const key of gatewayKeys) {
      expect(key.startsWith('gateway:')).toBe(true);
    }
    for (const key of mainKeys) {
      expect(key.startsWith('gateway:')).toBe(false);
    }
    const families = (keys: string[], prefix: string) => [...new Set(keys.map(key => key.slice(prefix.length).replace(/(sess-gen-copied|[a-z-]+:).*/, '$1')))].sort();
    expect(families(mainKeys, '')).toEqual(['sess-gen-copied', 'sess-gen:', 'sess-keep:', 'sess-revoked:', 'sess-user:', 'sess:']);
    expect(families(gatewayKeys, 'gateway:')).toEqual(['sess-gen-copied', 'sess-gen:', 'sess-keep:', 'sess-revoked:', 'sess-user:', 'sess:']);
    // no SCAN pattern of one store (connect-redis: `<prefix>*`) covers the other's sessions
    expect(main.sessionKeyPrefix).toBe('sess:');
    expect(gateway.sessionKeyPrefix).toBe('gateway:sess:');
  });

  it('a sign-out generation published by one instance is not read by the other (each reconciles from PostgreSQL)', async () => {
    actor = 'main';
    await main.modules.generations.publish('user-g', 9, 'keep-main');
    actor = 'gateway';
    expect(await gateway.modules.generations.read('user-g')).toEqual({ gen: 0, keepSid: null });
    actor = 'main';
    expect(await main.modules.generations.read('user-g')).toEqual({ gen: 9, keepSid: 'keep-main' });
  });

  it('Socket.IO: own adapter/emitter key, and neither instance subscribes to the other\'s channels', () => {
    expect(main.socketKey).toBe('v2:');
    expect(gateway.socketKey).toBe('gateway:v2:');
    // @socket.io/redis-adapter: channel `<key>#<nsp>#`, PSUBSCRIBE `<key>#<nsp>#*`,
    // request/response channels `<key>-request#…` / `<key>-response#…`
    const channels = (key: string) => [`${key}#/#`, `${key}#/#room#`, `${key}-request#/#`, `${key}-response#/#`];
    const subscribedBy = (key: string, channel: string) => channel.startsWith(`${key}#/#`) || channel.startsWith(`${key}-request#/#`) || channel.startsWith(`${key}-response#/#`);
    for (const channel of channels(gateway.socketKey)) {
      expect(subscribedBy(main.socketKey, channel)).toBe(false);
    }
    for (const channel of channels(main.socketKey)) {
      expect(subscribedBy(gateway.socketKey, channel)).toBe(false);
    }
  });
});
