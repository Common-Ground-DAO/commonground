// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * `registerPostRoute` (srv/api/util.ts) on a minimal express app: handler
 * errors answer `{ status: 'ERROR', error }`, and an error raised while
 * answering — a handler that already sent its own response — is caught by
 * the route's wrapper instead of being left as an unhandled rejection.
 */

import express from 'express';
import Joi from 'joi';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

for (const repository of ['emails', 'calls']) {
  jest.doMock(`../repositories/${repository}`, () => ({ __esModule: true, default: {} }));
}
jest.mock('puppeteer', () => ({ __esModule: true, default: {} }));

let server: Server;
let baseUrl: string;
let unhandled: jest.Mock;
let errorLog: jest.SpyInstance;
let log: jest.SpyInstance;

beforeAll(async () => {
  const { registerPostRoute } = await import('../api/util');
  const router = express.Router();
  registerPostRoute<undefined, { answer: number }>(router, '/ok', undefined, async () => ({ answer: 42 }));
  registerPostRoute<undefined, never>(router, '/fails', undefined, async () => { throw new Error('NOT_FOUND'); });
  const { RateLimitError } = await import('../util/rateLimitError');
  registerPostRoute<undefined, never>(router, '/limited', undefined, async () => { throw new RateLimitError(299.2, 'mail'); });
  registerPostRoute<{ id: string }, string>(router, '/invalid', Joi.object({ id: Joi.string().required() }).required(), async () => 'unreachable');
  registerPostRoute<undefined, string>(router, '/answers-itself', undefined, async (_request, response) => {
    response.status(204).end();
    return 'too late';
  });
  const app = express();
  app.use(router);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  unhandled = jest.fn();
  process.on('unhandledRejection', unhandled);
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
});

afterEach(async () => {
  await new Promise(resolve => setImmediate(resolve));
  process.off('unhandledRejection', unhandled);
  errorLog.mockRestore();
  log.mockRestore();
  expect(unhandled).not.toHaveBeenCalled();
});

function post(path: string, body: unknown = {}) {
  return fetch(`${baseUrl}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(2000),
  });
}

describe('registerPostRoute', () => {
  it('wraps a result in { status: OK }', async () => {
    expect(await (await post('/ok')).json()).toEqual({ status: 'OK', data: { answer: 42 } });
  });

  it('answers a handler error with handleError', async () => {
    expect(await (await post('/fails')).json()).toEqual({ status: 'ERROR', error: 'NOT_FOUND' });
  });

  it('answers a limit with the wait: in the envelope and as Retry-After', async () => {
    const response = await post('/limited');
    expect(response.status).toBe(200);
    expect(response.headers.get('retry-after')).toBe('300');
    expect(await response.json()).toEqual({ status: 'ERROR', error: 'RATE_LIMIT_EXCEEDED', retryAfterSeconds: 300, limit: 'mail' });
  });

  it('answers a validation error with VALIDATION', async () => {
    expect(await (await post('/invalid', { id: 1 })).json()).toEqual({ status: 'ERROR', error: 'VALIDATION' });
  });

  it('keeps a response the handler sent itself and catches the failed second answer', async () => {
    const response = await post('/answers-itself');
    expect(response.status).toBe(204);
    await new Promise(resolve => setImmediate(resolve));
    expect(errorLog).toHaveBeenCalledWith(expect.stringContaining('failed after the response was started'), expect.anything());
  });
});
