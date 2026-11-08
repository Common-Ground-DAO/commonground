// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The gateway's api allowlist (srv/util/gateway.ts) against the complete
 * route list of the api process. The list is built from the code: every
 * router is mounted exactly like the api does it (srv/api/mountRouters.ts),
 * and the routes are read from Express' own router stacks — the mount paths
 * recorded as they are registered —, so a route added anywhere shows up here
 * without being listed by hand. Configured like the gateway: legacy CG ID
 * mode (the old sign-up and sign-in surface, CgId router), CG_GATEWAY=true.
 */

process.env.BASE_URL = 'https://app.cg';
process.env.CGID_URL = 'https://id.app.cg';
process.env.DEPLOYMENT = 'prod';
process.env.CG_LEGACY_CGID = 'true';
process.env.CG_GATEWAY = 'true';
process.env.TRANSFER_TARGET_URL = 'https://cg.box';
process.env.REDIS_SECRET = 'gateway-test-secret-0123456789';

import fs from 'fs';
import path from 'path';
import http from 'http';
import type { AddressInfo } from 'net';

// only what importing every router needs: nothing here runs a handler
jest.doMock('puppeteer', () => ({ __esModule: true, default: {} }));
// the page routes read the web app's shell at startup
jest.doMock('fs', () => {
  const actual = jest.requireActual('fs');
  return {
    ...actual,
    readFileSync: (file: unknown, ...rest: unknown[]) => file === '/dist/index.html'
      ? Buffer.from('<html><head><script src="/instance-config.js"></script></head><body></body></html>')
      : actual.readFileSync(file, ...rest),
  };
});
jest.doMock('../redis', () => require('./helpers/memoryRedis'));
jest.doMock('../util/postgres', () => ({
  __esModule: true,
  default: { query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() },
  poolMaxFromEnv: () => 10,
  DEFAULT_POOL_MAX: 10,
}));

type Layer = {
  route?: { path: string | RegExp | (string | RegExp)[]; methods: Record<string, boolean> };
  handle: { stack?: Layer[] };
  __mountPath?: string | RegExp | (string | RegExp)[];
};

/** records the mount path of every `use(path, ...)` layer when it is added */
function recordMountPaths(RouterProto: { use: (...args: unknown[]) => unknown }) {
  const originalUse = RouterProto.use;
  RouterProto.use = function use(this: { stack: Layer[] }, ...args: unknown[]) {
    const before = this.stack.length;
    const result = originalUse.apply(this, args);
    const mountPath = typeof args[0] === 'function' ? '/' : args[0] as Layer['__mountPath'];
    for (const layer of this.stack.slice(before)) {
      layer.__mountPath = mountPath;
    }
    return result;
  };
}

type Route = { method: string; path: string | RegExp; sample: string };

function joinPath(prefix: string, part: string): string {
  const joined = `${prefix.replace(/\/$/, '')}/${part.replace(/^\//, '')}`;
  return joined.length > 1 ? joined.replace(/\/$/, '') || '/' : joined;
}

/**
 * A concrete request path for a route path: `:params` become `x`; for a
 * RegExp route its capture groups `([^/]+)` become `x` and the optional
 * tails are dropped — checked against the RegExp itself, so a route the
 * generator cannot handle fails the test instead of being skipped.
 */
function samplePath(prefix: string, routePath: string | RegExp): string {
  if (typeof routePath === 'string') {
    return joinPath(prefix, routePath.replace(/:[A-Za-z0-9_]+/g, 'x').replace(/\{\/?\*[A-Za-z0-9_]+\}/g, '').replace(/\*[A-Za-z0-9_]+/g, 'x'));
  }
  const sample = routePath.source
    .replace(/\\\//g, '/')
    .replace(/\(\[\^\/\]\+\)/g, 'x')
    .replace(/\(\/\?\.\*\)\?/g, '')
    .replace(/\(\/\.\*\)\?/g, '')
    .replace(/\/\?$/, '')
    .replace(/\\\./g, '.');
  const full = joinPath(prefix, sample);
  if (!routePath.test(full.slice(prefix.replace(/\/$/, '').length) || '/')) {
    throw new Error(`no sample path for the route ${routePath}: generated ${full}`);
  }
  return full;
}

function collectRoutes(stack: Layer[], prefix: string, out: Route[]) {
  for (const layer of stack) {
    if (layer.route) {
      const paths = Array.isArray(layer.route.path) ? layer.route.path : [layer.route.path];
      for (const routePath of paths) {
        for (const [method, on] of Object.entries(layer.route.methods)) {
          if (!on || method === '_all') {
            continue;
          }
          const sample = samplePath(prefix, routePath);
          out.push({
            method: method.toUpperCase(),
            path: typeof routePath === 'string' ? joinPath(prefix, routePath) : routePath,
            sample,
          });
        }
      }
    }
    else if (layer.handle?.stack) {
      const mounts = layer.__mountPath === undefined ? ['/'] : Array.isArray(layer.__mountPath) ? layer.__mountPath : [layer.__mountPath];
      for (const mount of mounts) {
        if (typeof mount !== 'string') {
          throw new Error(`router mounted at a RegExp (${mount}): extend the test`);
        }
        collectRoutes(layer.handle.stack, joinPath(prefix, mount), out);
      }
    }
  }
}

let routes: Route[] = [];
let gateway: typeof import('../util/gateway');

beforeAll(() => {
  jest.isolateModules(() => {
    // the router module of this registry, which express uses
    recordMountPaths(require('router').prototype);
    const express = require('express');
    const { mountApiRouters } = require('../api/mountRouters');
    gateway = require('../util/gateway');
    const app = express();
    mountApiRouters(app);
    collectRoutes(app.router.stack, '/', routes);
  });
  // the generated list with the gateway's decision per route, for review and
  // for the live check against a running gateway (e2e/checks/gateway.sh):
  // decision, method, route, a concrete request path (tab-separated)
  if (process.env.GATEWAY_ROUTE_LIST_OUT) {
    fs.writeFileSync(process.env.GATEWAY_ROUTE_LIST_OUT, routes
      .map(route => [gateway.isGatewayApiRequestAllowed(route.method, route.sample) ? 'ALLOW' : 'deny', route.method, String(route.path), route.sample].join('\t'))
      .join('\n') + '\n');
  }
});

describe('the complete route list', () => {
  it('is built from every mounted router', () => {
    // every router file contributes; far more than the gateway may serve
    const prefixes = new Set(routes.map(route => typeof route.path === 'string' ? route.path.split('/')[1] : '(page)'));
    for (const prefix of ['Chat', 'Community', 'File', 'Message', 'User', 'Contract', 'Notification', 'Twitter', 'Lukso', 'CgId', 'Accounts', 'Plugins', 'Search', 'Report', 'Bot', 'BotV1', 'Staking', 'Captcha', 'Instance', 'Feed', '(page)', 'twitter-login', 'twitter-callback', 'gated-files', 'gated-videos', 'sitemap.xml']) {
      expect(prefixes).toContain(prefix);
    }
    expect(routes.length).toBeGreaterThan(200);
    // the routers nested under another one are found too (Bot API v1 messages)
    expect(routes.some(route => typeof route.path === 'string' && route.path.startsWith('/BotV1/messages/'))).toBe(true);
    // legacy mode: the CgId router instead of Passkey, and the full old sign-up
    expect(routes.some(route => route.path === '/User/createUser')).toBe(true);
    // the routers that share one mount (Message: messages + sync state)
    expect(routes.some(route => route.path === '/Message/getSyncState')).toBe(true);
    expect(routes.some(route => typeof route.path === 'string' && route.path.startsWith('/Passkey/'))).toBe(false);
  });
});

describe('gateway allowlist', () => {
  it('names only routes that exist, each exactly once', () => {
    for (const entry of gateway.GATEWAY_API_ALLOWLIST) {
      const matching = routes.filter(route => route.method === entry.method && route.path === entry.path);
      expect({ entry: `${entry.method} ${entry.path}`, found: matching.length }).toEqual({ entry: `${entry.method} ${entry.path}`, found: 1 });
    }
    const keys = gateway.GATEWAY_API_ALLOWLIST.map(entry => `${entry.method} ${entry.path.toLowerCase()}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('allows exactly the listed routes of the complete list', () => {
    const allowed = routes.filter(route => gateway.isGatewayApiRequestAllowed(route.method, route.sample));
    const listed = new Set(gateway.GATEWAY_API_ALLOWLIST.map(entry => `${entry.method} ${entry.path}`));
    for (const route of allowed) {
      expect(listed).toContain(`${route.method} ${route.path}`);
    }
    expect(allowed.length).toBe(gateway.GATEWAY_API_ALLOWLIST.length);
  });

  it('holds sign-in, session and transfer links — no sign-up, no data', () => {
    const allow = (method: string, p: string) => gateway.isGatewayApiRequestAllowed(method, p);
    expect(allow('POST', '/User/login')).toBe(true);
    expect(allow('POST', '/User/createTransferLink')).toBe(true);
    expect(allow('POST', '/CgId/verifyAuthenticationResponse')).toBe(true);
    for (const p of ['/User/createUser', '/User/requestSignupEmailCode', '/User/redeemTransferLink', '/User/previewTransferLink', '/User/declineTransferLink',
      '/User/updateOwnData', '/User/setPassword', '/User/addPreparedWallet', '/User/getUserData', '/User/signOutOtherDevices',
      '/Community/getOwnCommunities', '/Message/loadMessages', '/Chat/getChats', '/File/uploadImage', '/Bot/listBots',
      // the chat catch-up and the notification store
      '/Message/getSyncState', '/Message/getChanges', '/Message/messagesById', '/Message/setChannelLastRead',
      '/Notification/loadNotifications', '/Notification/getUnreadCount', '/User/getWallets']) {
      expect({ p, allowed: allow('POST', p) }).toEqual({ p, allowed: false });
    }
    // HEAD counts as GET, other methods never pass
    expect(allow('HEAD', '/Instance/config')).toBe(true);
    expect(allow('POST', '/Instance/config')).toBe(false);
    expect(allow('GET', '/User/login')).toBe(false);
    expect(allow('PUT', '/User/login')).toBe(false);
    expect(allow('DELETE', '/User/login')).toBe(false);
  });
});

describe('gateway guard over HTTP', () => {
  let server: http.Server;
  let base: string;
  const reached: string[] = [];

  beforeAll(async () => {
    const express = jest.requireActual('express');
    const app = express();
    app.use(gateway.gatewayApiGuard({ CG_GATEWAY: 'true' }));
    // stands in for every router: whatever gets here passed the guard
    app.use((request: { method: string; path: string }, response: { json: (body: unknown) => void }) => {
      reached.push(`${request.method} ${request.path}`);
      response.json({ status: 'OK', reached: true });
    });
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  /** the path exactly as given (no client-side normalization like fetch's) */
  function send(method: string, p: string): Promise<{ status: number; body: any }> {
    return new Promise((resolve, reject) => {
      const request = http.request(`${base}/`, { method, path: p, headers: method === 'POST' ? { 'content-type': 'application/json' } : {} }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: text ? JSON.parse(text) : null }));
      });
      request.on('error', reject);
      request.end(method === 'POST' ? '{}' : undefined);
    });
  }

  it('refuses every route of the complete list that is not on the allowlist, reaches every one that is', async () => {
    const listed = new Set(gateway.GATEWAY_API_ALLOWLIST.map(entry => `${entry.method} ${entry.path}`));
    let refused = 0;
    for (const route of routes) {
      const result = await send(route.method, route.sample);
      if (listed.has(`${route.method} ${route.path}`)) {
        expect({ route: `${route.method} ${route.sample}`, status: result.status, reached: result.body?.reached }).toEqual({ route: `${route.method} ${route.sample}`, status: 200, reached: true });
      }
      else {
        refused++;
        expect({ route: `${route.method} ${route.sample}`, status: result.status, error: result.body?.error }).toEqual({ route: `${route.method} ${route.sample}`, status: 404, error: 'NOT_SUPPORTED' });
      }
    }
    expect(refused).toBe(routes.length - gateway.GATEWAY_API_ALLOWLIST.length);
  });

  it('treats the allowlisted paths like Express routes them (case, one trailing slash, HEAD)', async () => {
    expect((await send('POST', '/user/LOGIN')).status).toBe(200);
    expect((await send('POST', '/User/login/')).status).toBe(200);
    expect((await send('HEAD', '/Instance/config')).status).toBe(200);
    // anything else that is not literally on the list is refused
    for (const p of ['/User/login//', '//User/login', '/User/%6Cogin', '/User/./login', '/User/login.json', '/api/v2/User/login', '/User/login;x']) {
      expect({ p, status: (await send('POST', p)).status }).toEqual({ p, status: 404 });
    }
    expect((await send('OPTIONS', '/User/login')).status).toBe(404);
  });

  it('refuses every request with an Authorization header (bearer tokens are looked up nowhere)', async () => {
    const result = await new Promise<{ status: number; body: any }>((resolve, reject) => {
      const request = http.request(`${base}/User/login`, { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer cgb_x' } }, (response) => {
        let text = '';
        response.on('data', (chunk) => { text += chunk; });
        response.on('end', () => resolve({ status: response.statusCode ?? 0, body: JSON.parse(text) }));
      });
      request.on('error', reject);
      request.end('{}');
    });
    expect(result).toEqual({ status: 404, body: { status: 'ERROR', error: 'NOT_SUPPORTED' } });
  });

  it('passes everything outside gateway mode', () => {
    const guard = gateway.gatewayApiGuard({});
    const next = jest.fn();
    guard({ method: 'POST', path: '/User/createUser' } as never, {} as never, next);
    expect(next).toHaveBeenCalled();
  });
});

describe('api wiring', () => {
  it('runs the origin check, CORS and the gateway guard before the bot authentication and the session', () => {
    const source = fs.readFileSync(path.join(__dirname, '../util/express.ts'), 'utf8');
    const position = (needle: string) => {
      const index = source.indexOf(needle);
      expect({ needle, found: index >= 0 }).toEqual({ needle, found: true });
      return index;
    };
    const origin = position('app.use(originGuard(origins));');
    const corsUse = position('app.use(cors(createCorsOptions(origins)));');
    const guard = position('app.use(gatewayApiGuard());');
    const bot = position('app.use(botAuthenticationMiddleware);');
    const sessions = position('app.use(createSessionMiddlewares(');
    expect(origin).toBeLessThan(corsUse);
    expect(corsUse).toBeLessThan(guard);
    expect(guard).toBeLessThan(bot);
    expect(guard).toBeLessThan(sessions);
    // and the api mounts every router after express.ts set this up
    const api = fs.readFileSync(path.join(__dirname, '../api.ts'), 'utf8');
    expect(api.indexOf("import app from './util/express';")).toBeGreaterThanOrEqual(0);
    expect(api).toContain('mountApiRouters(app);');
    expect(api).not.toMatch(/app\.use\(\s*['"`]\//);
  });
});
