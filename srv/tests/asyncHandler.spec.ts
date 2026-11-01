// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * `asyncHandler` (srv/api/asyncHandler.ts, on top of `asyncRequestHandler`
 * in srv/util/asyncHandler.ts): every throw or rejection of a wrapped handler
 * reaches the error responder (or `next(error)`) and ends in a response.
 */

import express from 'express';
import type { AddressInfo } from 'net';

const mockHandleError = jest.fn((response: any, error: unknown) => {
  response.send({ status: 'ERROR', error: error instanceof Error ? error.message : 'UNKNOWN' });
});
jest.mock('../api/util', () => ({
  handleError: (response: any, error: unknown) => mockHandleError(response, error),
}));

import { asyncHandler } from '../api/asyncHandler';

function fakeResponse(state: { headersSent?: boolean; writableEnded?: boolean } = {}) {
  return {
    headersSent: !!state.headersSent,
    writableEnded: !!state.writableEnded,
    send: jest.fn(),
  } as any;
}
const request = { method: 'GET', path: '/x' } as any;
const flush = () => new Promise(resolve => setImmediate(resolve));

let unhandled: jest.Mock;
let errorLog: jest.SpyInstance;
beforeEach(() => {
  mockHandleError.mockClear();
  unhandled = jest.fn();
  process.on('unhandledRejection', unhandled);
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(async () => {
  await flush();
  process.off('unhandledRejection', unhandled);
  errorLog.mockRestore();
  expect(unhandled).not.toHaveBeenCalled();
});

describe('asyncHandler', () => {
  it('passes request, response and next through and stays out of the way on success', async () => {
    const handler = jest.fn(async (_req: any, res: any) => { res.send('ok'); });
    const response = fakeResponse();
    const next = jest.fn();
    asyncHandler(handler)(request, response, next);
    await flush();
    expect(handler).toHaveBeenCalledWith(request, response, next);
    expect(response.send).toHaveBeenCalledWith('ok');
    expect(mockHandleError).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
  });

  it('answers a rejection with handleError by default', async () => {
    const error = new Error('INVALID_REQUEST');
    const response = fakeResponse();
    const next = jest.fn();
    asyncHandler(async () => { throw error; })(request, response, next);
    await flush();
    expect(mockHandleError).toHaveBeenCalledWith(response, error);
    expect(response.send).toHaveBeenCalledWith({ status: 'ERROR', error: 'INVALID_REQUEST' });
    expect(next).not.toHaveBeenCalled();
  });

  it('answers a synchronous throw the same way', () => {
    const error = new Error('boom');
    const response = fakeResponse();
    asyncHandler(() => { throw error; })(request, response, jest.fn());
    expect(mockHandleError).toHaveBeenCalledWith(response, error);
  });

  it('uses the route\'s own responder when one is given', async () => {
    const error = new Error('boom');
    const onError = jest.fn();
    const response = fakeResponse();
    asyncHandler(async () => { throw error; }, onError)(request, response, jest.fn());
    await flush();
    expect(onError).toHaveBeenCalledWith(response, error);
    expect(mockHandleError).not.toHaveBeenCalled();
  });

  it('only logs when the response is already complete', async () => {
    const onError = jest.fn();
    const next = jest.fn();
    asyncHandler(async () => { throw new Error('late'); }, onError)(request, fakeResponse({ headersSent: true, writableEnded: true }), next);
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expect(next).not.toHaveBeenCalled();
    expect(errorLog).toHaveBeenCalled();
  });

  it('hands a started but unfinished response to next(error)', async () => {
    const error = new Error('mid-stream');
    const onError = jest.fn();
    const next = jest.fn();
    asyncHandler(async () => { throw error; }, onError)(request, fakeResponse({ headersSent: true }), next);
    await flush();
    expect(onError).not.toHaveBeenCalled();
    expect(next).toHaveBeenCalledWith(error);
  });

  it('hands an error thrown by the responder to next(error)', async () => {
    const responderError = new Error('responder failed');
    const next = jest.fn();
    asyncHandler(async () => { throw new Error('first'); }, () => { throw responderError; })(request, fakeResponse(), next);
    await flush();
    expect(next).toHaveBeenCalledWith(responderError);
  });

  it('waits for an async responder and hands its rejection to next(error)', async () => {
    const responderError = new Error('async responder failed');
    const next = jest.fn();
    asyncHandler(async () => { throw new Error('first'); }, async () => { throw responderError; })(request, fakeResponse(), next);
    await flush();
    expect(next).toHaveBeenCalledWith(responderError);
  });

  it('leaves next alone when an async responder succeeds', async () => {
    const response = fakeResponse();
    const next = jest.fn();
    asyncHandler(async () => { throw new Error('first'); }, async (res) => { res.send('handled'); })(request, response, next);
    await flush();
    expect(response.send).toHaveBeenCalledWith('handled');
    expect(next).not.toHaveBeenCalled();
  });

  it('turns a rejecting handler into an error response on a real express app', async () => {
    const app = express();
    app.get('/fails', asyncHandler(async () => { throw new Error('NOT_FOUND'); }));
    app.get('/fails-in-catch', asyncHandler(async (_req, res) => {
      try {
        throw new Error('first');
      } catch {
        res.send('partial');
        res.send('again'); // throws ERR_HTTP_HEADERS_SENT inside the handler
      }
    }));
    const server = app.listen(0);
    try {
      const { port } = server.address() as AddressInfo;
      const fails = await fetch(`http://127.0.0.1:${port}/fails`);
      expect(fails.status).toBe(200);
      expect(await fails.json()).toEqual({ status: 'ERROR', error: 'NOT_FOUND' });

      const failsInCatch = await fetch(`http://127.0.0.1:${port}/fails-in-catch`);
      expect(await failsInCatch.text()).toBe('partial');
    } finally {
      await new Promise(resolve => server.close(resolve));
    }
  });
});
