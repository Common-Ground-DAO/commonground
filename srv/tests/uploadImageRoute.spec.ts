// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * `POST /File/uploadImage` (srv/api/files.ts) on a minimal express app with the
 * real router, multer, `handleError` and `apiErrorHandler`: every failure —
 * a missing file, the rate limiter, multer, a failure after the response was
 * sent — reaches the error handling and ends in a response; no promise
 * rejection is left unhandled. Repositories are mocked.
 */

process.env.DEPLOYMENT = 'prod';

import express from 'express';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

const mockRateLimiter = jest.fn(async (_req: unknown, _res: unknown) => undefined);
jest.mock('../util/rateLimit', () => ({
  __esModule: true,
  default: () => (req: unknown, res: unknown) => mockRateLimiter(req, res),
  keyRateLimitHandler: () => jest.fn(async () => undefined),
  extractIpFromRequest: () => ({ ipString: '203.0.113.1' }),
}));
const mockSaveImage = jest.fn();
jest.mock('../repositories/files', () => ({
  __esModule: true,
  default: {
    saveImage: (...args: unknown[]) => mockSaveImage(...args),
    scheduleUserPreviewUpdate: jest.fn(),
    scheduleCommunityPreviewUpdate: jest.fn(),
    getSignedUrls: jest.fn(),
  },
}));
const mockUpdateUser = jest.fn(async () => undefined);
jest.mock('../repositories/users', () => ({
  __esModule: true,
  default: { updateUser: () => mockUpdateUser(), updateCgProfile: jest.fn(async () => undefined) },
}));
const mockEmit = jest.fn(async () => undefined);
jest.mock('../repositories/event', () => ({
  __esModule: true,
  default: { emit: () => mockEmit() },
}));
for (const repository of ['permissions', 'communities', 'emails', 'calls']) {
  jest.doMock(`../repositories/${repository}`, () => ({ __esModule: true, default: {} }));
}
jest.mock('puppeteer', () => ({ __esModule: true, default: {} }));

const USER = '00000000-0000-4000-8000-000000000001';

let server: Server;
let baseUrl: string;
let sessionUser: { id: string } | undefined;
let unhandled: jest.Mock;
let log: jest.SpyInstance;
let errorLog: jest.SpyInstance;

beforeAll(async () => {
  const { default: fileRouter } = await import('../api/files');
  const { apiErrorHandler } = await import('../api/util');
  const app = express();
  app.use((req, _res, next) => {
    (req as any).session = { user: sessionUser };
    next();
  });
  app.use('/File', fileRouter);
  app.use(apiErrorHandler);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  // a request the route never answered would otherwise keep close() waiting
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
});

beforeEach(() => {
  sessionUser = undefined;
  mockRateLimiter.mockReset().mockResolvedValue(undefined);
  mockSaveImage.mockReset().mockResolvedValue({ fileId: 'file-1' });
  mockEmit.mockReset().mockResolvedValue(undefined);
  unhandled = jest.fn();
  process.on('unhandledRejection', unhandled);
  log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});

afterEach(async () => {
  await new Promise(resolve => setImmediate(resolve));
  process.off('unhandledRejection', unhandled);
  log.mockRestore();
  errorLog.mockRestore();
  expect(unhandled).not.toHaveBeenCalled();
});

function upload(form?: FormData) {
  // a route that never answers fails the test instead of hanging it
  return fetch(`${baseUrl}/File/uploadImage`, { method: 'POST', body: form, signal: AbortSignal.timeout(2000) });
}

function pngFile(field = 'uploaded') {
  const form = new FormData();
  form.append(field, new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], { type: 'image/png' }), 'a.png');
  return form;
}

describe('POST /File/uploadImage error handling', () => {
  it('answers a multipart body without a file with INVALID_REQUEST', async () => {
    const form = new FormData();
    form.append('options', JSON.stringify({ type: 'userProfileImage' }));
    const response = await upload(form);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ERROR', error: 'INVALID_REQUEST' });
    expect(mockSaveImage).not.toHaveBeenCalled();
  });

  it('answers a request without any body with INVALID_REQUEST', async () => {
    const response = await upload();
    expect(await response.json()).toEqual({ status: 'ERROR', error: 'INVALID_REQUEST' });
  });

  it('answers a rate-limited request with the limiter error', async () => {
    mockRateLimiter.mockRejectedValue(new Error('RATE_LIMIT_EXCEEDED'));
    const response = await upload(pngFile());
    expect(await response.json()).toEqual({ status: 'ERROR', error: 'RATE_LIMIT_EXCEEDED' });
    expect(mockSaveImage).not.toHaveBeenCalled();
  });

  it('answers a multer error (unexpected file field) through apiErrorHandler', async () => {
    const response = await upload(pngFile('somethingElse'));
    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({ status: 'ERROR', error: 'UNKNOWN' });
  });

  it('answers invalid options with VALIDATION', async () => {
    const form = pngFile();
    form.append('options', JSON.stringify({ type: 'notAType' }));
    const response = await upload(form);
    expect(await response.json()).toEqual({ status: 'ERROR', error: 'VALIDATION' });
  });

  it('still uploads a valid anonymous profile picture', async () => {
    const form = pngFile();
    form.append('options', JSON.stringify({ type: 'userProfileImage' }));
    const response = await upload(form);
    expect(await response.json()).toEqual({ imageId: 'file-1' });
  });

  it('keeps the sent response when a step after it fails', async () => {
    sessionUser = { id: USER };
    mockEmit.mockRejectedValue(new Error('emit failed'));
    const form = pngFile();
    form.append('options', JSON.stringify({ type: 'userBannerImage' }));
    const response = await upload(form);
    expect(await response.json()).toEqual({ imageId: 'file-1' });
    expect(mockEmit).toHaveBeenCalled();
  });
});
