// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The order of the api's middleware, read from the real app that
 * srv/util/express.ts builds (Express' own router stack): the origin check,
 * CORS and the gateway guard run before the cookie parser, the bot
 * authentication and the session, so a refused request never reaches any of
 * them (docs/auth-identity §2 "Middleware order", §12).
 */

process.env.BASE_URL = 'https://app.cg';
process.env.CGID_URL = 'https://id.app.cg';
process.env.DEPLOYMENT = 'prod';
process.env.CG_LEGACY_CGID = 'true';
process.env.CG_GATEWAY = 'true';
process.env.REDIS_SECRET = 'wiring-test-secret-0123456789';

jest.doMock('../redis', () => require('./helpers/memoryRedis'));
jest.doMock('../util/postgres', () => ({ __esModule: true, default: { query: jest.fn(async () => ({ rows: [] })), connect: jest.fn() } }));

type Layer = { name: string; handle: { name?: string } };

describe('srv/util/express.ts', () => {
  let names: string[] = [];

  beforeAll(() => {
    jest.useFakeTimers();
    jest.isolateModules(() => {
      const express = require('express');
      // the module starts listening on port 4000; not here
      jest.spyOn(express.application, 'listen').mockImplementation(() => ({ close: () => undefined }));
      const app = require('../util/express').default;
      names = (app.router.stack as Layer[]).map(layer => layer.name || layer.handle.name || '<anonymous>');
    });
  });

  afterAll(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
  });

  it('runs the origin check, CORS and the gateway guard first, before cookies, bot tokens and the session', () => {
    const index = (name: string) => {
      const i = names.indexOf(name);
      expect({ name, found: i >= 0, names }).toMatchObject({ name, found: true });
      return i;
    };
    const origin = index('originGuardMiddleware');
    const cors = index('corsMiddleware');
    const guard = index('gatewayApiGuardMiddleware');
    const cookies = index('cookieParser');
    const bot = index('botAuthenticationMiddleware');
    expect(origin).toBe(0);
    expect(cors).toBe(1);
    expect(guard).toBe(2);
    expect(guard).toBeLessThan(cookies);
    expect(cookies).toBeLessThan(bot);
    // the session middlewares (skipBots wrappers) all come after the bot authentication
    expect(names.length).toBeGreaterThan(bot + 5);
  });
});
