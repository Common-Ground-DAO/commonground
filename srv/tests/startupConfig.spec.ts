// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Startup checks and the api's origin handling: the session secret
 * (srv/util/sessionSecret.ts), the pool size (srv/util/postgres.ts), the
 * gateway configuration and the singleton processes (srv/util/gateway.ts),
 * and the origin check + CORS of the api (srv/util/origins.ts) over HTTP.
 */

process.env.BASE_URL = 'https://cg.box';
process.env.DEPLOYMENT = 'prod';

import http from 'http';
import express from 'express';
import cors from 'cors';
import type { AddressInfo } from 'net';
import { configuredSessionSecret, requireSessionSecret, sharedMailLimitSecret } from '../util/sessionSecret';
import { refuseInGatewayMode, validateGatewayConfig, instanceKeyPrefix, socketIoKey } from '../util/gateway';
import { createCorsOptions, originGuard } from '../util/origins';

// the mail limits load the rate limiter, which would connect to Valkey
jest.doMock('../redis', () => require('./helpers/memoryRedis'));

const poolListeners: Record<string, (...args: unknown[]) => void> = {};
jest.doMock('pg', () => ({
  Pool: jest.fn().mockImplementation((options) => ({
    options,
    on: (event: string, listener: (...args: unknown[]) => void) => { poolListeners[event] = listener; },
  })),
}));

describe('session secret', () => {
  const none = () => undefined;
  it('is required, and not the template placeholder or too short', () => {
    expect(() => requireSessionSecret({}, none)).toThrow(/REDIS_SECRET .* not set/);
    expect(() => requireSessionSecret({ REDIS_SECRET: '' }, none)).toThrow(/not set/);
    expect(() => requireSessionSecret({ REDIS_SECRET: '   ' }, none)).toThrow(/not set/);
    expect(() => requireSessionSecret({ REDIS_SECRET: 'generated-on-first-run' }, none)).toThrow(/not set/);
    expect(() => requireSessionSecret({ REDIS_SECRET: 'short' }, none)).toThrow(/shorter than 16/);
    expect(requireSessionSecret({ REDIS_SECRET: 'a-long-enough-secret' }, none)).toBe('a-long-enough-secret');
  });

  it('prefers the Docker secret, used as it is (the key the cookies were signed with before)', () => {
    const fromFile = (name: string) => (name === 'redis_secret' ? 'from-the-docker-secret\n' : false);
    expect(requireSessionSecret({ REDIS_SECRET: 'from-the-environment-x' }, fromFile)).toBe('from-the-docker-secret\n');
    expect(configuredSessionSecret({ REDIS_SECRET: 'from-the-environment-x' }, fromFile)).toBe('from-the-docker-secret\n');
    // the checks look at it without surrounding whitespace
    expect(() => requireSessionSecret({}, () => 'short\n\n\n\n\n\n\n\n\n\n\n\n')).toThrow(/shorter than 16/);
    expect(() => requireSessionSecret({}, () => '\n')).toThrow(/not set/);
  });

  it('is the one source of the unsubscribe-link and the mail-limit keys', () => {
    const { mailLimitSecret } = jest.requireActual('../util/mailSendLimits') as typeof import('../util/mailSendLimits');
    const fromFile = (name: string) => (name === 'redis_secret' ? 'from-the-docker-secret\n' : false);
    // without a shared mail-limit secret: exactly the session secret, as before
    expect(mailLimitSecret({}, fromFile)).toBe(configuredSessionSecret({}, fromFile));
    expect(mailLimitSecret({ REDIS_SECRET: 'env-secret-with-space ' }, () => false)).toBe('env-secret-with-space ');
    expect(mailLimitSecret({}, () => false)).toBeUndefined();
  });

  it('a missing one stops the api when it builds its session middleware', () => {
    const saved = process.env;
    process.env = { ...saved, REDIS_SECRET: '' };
    try {
      jest.isolateModules(() => {
        const setup = require('../util/sessionSetup');
        expect(() => setup.createSessionMiddlewares({} as never, { revoke: jest.fn(), isRevoked: jest.fn() })).toThrow(/REDIS_SECRET/);
      });
    }
    finally {
      process.env = saved;
    }
  });
});

describe('PostgreSQL pool size', () => {
  const load = (value: string | undefined) => {
    const saved = process.env;
    process.env = { ...saved };
    if (value === undefined) delete process.env.PG_POOL_MAX;
    else process.env.PG_POOL_MAX = value;
    try {
      let max: unknown;
      jest.isolateModules(() => {
        max = (require('../util/postgres').default as { options: { max: number } }).options.max;
      });
      return max;
    }
    finally {
      process.env = saved;
    }
  };

  it('is PG_POOL_MAX, else the node-postgres default of 10', () => {
    expect(load(undefined)).toBe(10);
    expect(load('')).toBe(10);
    expect(load('4')).toBe(4);
    expect(load(' 25 ')).toBe(25);
  });

  it('logs a failing idle connection instead of ending the process; held connections are left to their holder', () => {
    load(undefined);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      // the pool's own event (node-postgres re-emits an idle connection's failure)
      expect(typeof poolListeners.error).toBe('function');
      expect(() => poolListeners.error(new Error('terminating connection due to administrator command'))).not.toThrow();
      expect(error).toHaveBeenCalledWith(expect.stringContaining('a pooled connection failed'));
      // no listener on every connection: a held one's failure (a LISTEN
      // connection's) reaches its holder, which ends or re-listens
      expect(poolListeners.connect).toBeUndefined();
    }
    finally {
      error.mockRestore();
    }
  });

  it('stops the process on a value that is not a positive integer', () => {
    for (const value of ['0', '-1', '2.5', 'ten', '1e3x']) {
      expect(() => load(value)).toThrow(/PG_POOL_MAX/);
    }
  });
});

describe('gateway configuration', () => {
  const none = () => false as const;
  it('needs legacy CG ID mode, and on the api a transfer target and the shared mail-limit secret', () => {
    const full = { CG_GATEWAY: 'true', CG_LEGACY_CGID: 'true', TRANSFER_TARGET_URL: 'https://cg.box', CG_MAIL_LIMIT_SECRET: 'shared-mail-limit-secret' };
    expect(() => validateGatewayConfig({ needsTransferTarget: true }, {})).not.toThrow();
    expect(() => validateGatewayConfig({ needsTransferTarget: true }, { CG_GATEWAY: 'false' })).not.toThrow();
    expect(() => validateGatewayConfig({ needsTransferTarget: true }, { CG_GATEWAY: 'yes' })).toThrow(/CG_GATEWAY must be/);
    expect(() => validateGatewayConfig({ needsTransferTarget: true }, { ...full, CG_LEGACY_CGID: undefined }, none)).toThrow(/CG_LEGACY_CGID=true/);
    expect(() => validateGatewayConfig({ needsTransferTarget: true }, { ...full, TRANSFER_TARGET_URL: undefined }, none)).toThrow(/TRANSFER_TARGET_URL/);
    expect(() => validateGatewayConfig({ needsTransferTarget: true }, { ...full, CG_MAIL_LIMIT_SECRET: '' }, none)).toThrow(/CG_MAIL_LIMIT_SECRET/);
    expect(() => validateGatewayConfig({ needsTransferTarget: true }, { ...full, CG_MAIL_LIMIT_SECRET: '  ' }, none)).toThrow(/CG_MAIL_LIMIT_SECRET/);
    expect(() => validateGatewayConfig({ needsTransferTarget: false }, { CG_GATEWAY: 'true', CG_LEGACY_CGID: 'true' }, none)).not.toThrow();
    expect(() => validateGatewayConfig({ needsTransferTarget: true }, full, none)).not.toThrow();
  });

  it('never runs a gateway with DEPLOYMENT=dev', () => {
    const full = { CG_GATEWAY: 'true', CG_LEGACY_CGID: 'true', TRANSFER_TARGET_URL: 'https://cg.box', CG_MAIL_LIMIT_SECRET: 'shared-mail-limit-secret' };
    expect(() => validateGatewayConfig({ needsTransferTarget: true }, { ...full, DEPLOYMENT: 'dev' }, none)).toThrow(/DEPLOYMENT=dev/);
    expect(() => validateGatewayConfig({ needsTransferTarget: false }, { CG_GATEWAY: 'true', CG_LEGACY_CGID: 'true', DEPLOYMENT: 'dev' }, none)).toThrow(/DEPLOYMENT=dev/);
    expect(() => validateGatewayConfig({ needsTransferTarget: true }, { ...full, DEPLOYMENT: 'prod' }, none)).not.toThrow();
    expect(() => validateGatewayConfig({ needsTransferTarget: true }, { ...full, DEPLOYMENT: 'staging' }, none)).not.toThrow();
  });

  it('outside dev, a process with the gateway\'s settings (api or wsapi) must be a gateway', () => {
    for (const needsTransferTarget of [true, false]) {
      expect(() => validateGatewayConfig({ needsTransferTarget }, { CG_LEGACY_CGID: 'true', DEPLOYMENT: 'prod' }, none)).toThrow(/CG_LEGACY_CGID=true is for a gateway only/);
      expect(() => validateGatewayConfig({ needsTransferTarget }, { CG_LEGACY_CGID: 'true', CG_GATEWAY: 'false' }, none)).toThrow(/needs CG_GATEWAY=true/);
      expect(() => validateGatewayConfig({ needsTransferTarget }, { TRANSFER_TARGET_URL: 'https://cg.box', DEPLOYMENT: 'prod' }, none)).toThrow(/TRANSFER_TARGET_URL is for a gateway only/);
      // the main instance's own settings pass
      expect(() => validateGatewayConfig({ needsTransferTarget }, { CG_LEGACY_CGID: 'false', TRANSFER_TARGET_URL: ' ', DEPLOYMENT: 'prod' }, none)).not.toThrow();
      // a dev stack may try legacy mode or transfer links on their own
      expect(() => validateGatewayConfig({ needsTransferTarget }, { CG_LEGACY_CGID: 'true', TRANSFER_TARGET_URL: 'http://localhost:8000', DEPLOYMENT: 'dev' }, none)).not.toThrow();
    }
  });

  it('accepts the shared mail-limit secret from wherever the mail limits read it (the Docker secret too)', () => {
    const full = { CG_GATEWAY: 'true', CG_LEGACY_CGID: 'true', TRANSFER_TARGET_URL: 'https://cg.box' };
    const fromFile = (name: string) => (name === 'mail_limit_secret' ? 'shared-mail-limit-secret\n' : false);
    expect(() => validateGatewayConfig({ needsTransferTarget: true }, full, fromFile)).not.toThrow();
    expect(() => validateGatewayConfig({ needsTransferTarget: true }, full, none)).toThrow(/CG_MAIL_LIMIT_SECRET/);
    // one key on both sides, whichever source each reads
    expect(sharedMailLimitSecret({}, fromFile)).toBe(sharedMailLimitSecret({ CG_MAIL_LIMIT_SECRET: 'shared-mail-limit-secret' }, none));
  });

  it('refuses a transfer target on or under the gateway\'s own domain (its session cookie would reach it)', () => {
    const base = { CG_GATEWAY: 'true', CG_LEGACY_CGID: 'true', CG_MAIL_LIMIT_SECRET: 'shared-mail-limit-secret', BASE_URL: 'https://app.cg' };
    const check = (target: string, baseUrl = base.BASE_URL) => () => validateGatewayConfig({ needsTransferTarget: true }, { ...base, BASE_URL: baseUrl, TRANSFER_TARGET_URL: target }, none);
    expect(check('https://new.app.cg')).toThrow(/must not be the gateway's domain or lie under it/);
    expect(check('https://NEW.App.Cg.')).toThrow(/must not be the gateway's domain or lie under it/);
    expect(check('https://app.cg:8443')).toThrow(/must not be the gateway's domain/);
    expect(check('https://cg.box')).not.toThrow();
    expect(check('https://xapp.cg')).not.toThrow();
    // a gateway under the instance's domain is fine: the instance's cookie is host-only
    expect(check('https://cg.box', 'https://old.cg.box')).not.toThrow();
  });

  it('the per-address mail limits are keyed with the shared CG_MAIL_LIMIT_SECRET, else the session secret', () => {
    const { mailLimitSecret } = jest.requireActual('../util/mailSendLimits') as typeof import('../util/mailSendLimits');
    const none = () => false as const;
    expect(mailLimitSecret({ CG_MAIL_LIMIT_SECRET: 'shared', REDIS_SECRET: 'own-session-secret' }, none)).toBe('shared');
    expect(mailLimitSecret({ REDIS_SECRET: 'own-session-secret' }, none)).toBe('own-session-secret');
    // the instance and its gateway: different session secrets, one mail-limit secret
    expect(mailLimitSecret({ CG_MAIL_LIMIT_SECRET: 'shared', REDIS_SECRET: 'main' }, none))
      .toBe(mailLimitSecret({ CG_MAIL_LIMIT_SECRET: 'shared', REDIS_SECRET: 'gateway' }, none));
  });

  it('gives the gateway its own key prefix and Socket.IO key; the main instance keeps the old names', () => {
    expect(instanceKeyPrefix({})).toBe('');
    expect(socketIoKey({})).toBe('v2:');
    expect(instanceKeyPrefix({ CG_GATEWAY: 'true' })).toBe('gateway:');
    expect(socketIoKey({ CG_GATEWAY: 'true' })).toBe('gateway:v2:');
  });

  it('singleton processes refuse to run in gateway mode', () => {
    const exit = jest.spyOn(process, 'exit').mockImplementation((() => undefined) as never);
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      refuseInGatewayMode('job-runner', {});
      expect(exit).not.toHaveBeenCalled();
      refuseInGatewayMode('job-runner', { CG_GATEWAY: 'true' });
      expect(exit).toHaveBeenCalledWith(1);
    }
    finally {
      exit.mockRestore();
      error.mockRestore();
    }
  });
});

describe('api origin check and CORS', () => {
  let server: http.Server;
  let base: string;
  const ORIGIN = 'https://cg.box';

  beforeAll(async () => {
    const app = express();
    app.use(originGuard([ORIGIN]));
    app.use(cors(createCorsOptions([ORIGIN])));
    app.post('/User/login', (_request, response) => { response.json({ status: 'OK' }); });
    app.post('/User/emailUnsubscribe', (_request, response) => { response.json({ status: 'OK' }); });
    server = http.createServer(app);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  const send = async (method: string, headers: Record<string, string>) => {
    const response = await fetch(`${base}/User/login`, { method, headers });
    return { status: response.status, headers: response.headers, body: await response.text() };
  };

  it('answers the listed origin with CORS headers', async () => {
    const result = await send('POST', { origin: ORIGIN });
    expect(result.status).toBe(200);
    expect(result.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(result.headers.get('access-control-allow-credentials')).toBe('true');
  });

  it('refuses another origin with 403 before any handler (preflight included)', async () => {
    for (const method of ['POST', 'OPTIONS']) {
      const result = await send(method, { origin: 'https://evil.example', 'access-control-request-method': 'POST' });
      expect(result.status).toBe(403);
      expect(JSON.parse(result.body)).toEqual({ status: 'ERROR', error: 'NOT_ALLOWED' });
      expect(result.headers.get('access-control-allow-origin')).toBeNull();
    }
    expect((await send('POST', { origin: 'null' })).status).toBe(403);
  });

  it('lets one-click unsubscribe through from any origin (mail providers; the signed token authorizes it)', async () => {
    for (const origin of ['https://mail.example', 'null']) {
      const response = await fetch(`${base}/User/emailUnsubscribe?token=x`, { method: 'POST', headers: { origin } });
      expect({ origin, status: response.status }).toEqual({ origin, status: 200 });
      expect(response.headers.get('access-control-allow-origin')).toBeNull();
    }
    const other = await fetch(`${base}/user/EMAILUNSUBSCRIBE/`, { method: 'POST', headers: { origin: 'https://mail.example' } });
    expect(other.status).not.toBe(403);
  });

  it('lets requests without an Origin through (same-origin GETs, SDK, bots), without CORS headers', async () => {
    const result = await send('POST', {});
    expect(result.status).toBe(200);
    expect(result.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('allows the request headers the clients send, x-cg-socket-id included', async () => {
    const result = await send('OPTIONS', {
      origin: ORIGIN,
      'access-control-request-method': 'POST',
      'access-control-request-headers': 'content-type,x-cg-socket-id',
    });
    expect(result.status).toBe(204);
    const allowed = (result.headers.get('access-control-allow-headers') ?? '').toLowerCase().split(',').map(header => header.trim());
    expect(allowed).toEqual(expect.arrayContaining(['content-type', 'x-cg-socket-id', 'accept', 'authorization']));
  });
});
