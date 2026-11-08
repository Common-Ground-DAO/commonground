// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * `/gated-videos/:filename` and `/gated-files/:filename`
 * (srv/api/getRoutes.ts) stream from disk. A read error — the file removed
 * between stat and read, an I/O error mid-stream — must end the response
 * (plain-text 500 before anything was sent, an aborted response after); the
 * stream error is handled, not left to `uncaughtException`. `fs` is real
 * except for paths under /api_data, which are served from the streams set up
 * here.
 */

process.env.DEPLOYMENT = 'dev';

import express from 'express';
import { Readable } from 'stream';
import type { AddressInfo } from 'net';
import type { Server } from 'http';

type FakeFile = { size: number; stream: () => Readable };
/** what fs does when the file is gone at open time: an asynchronous 'error' event */
function mockVanished(filePath: string) {
  const { Readable: ReadableStream } = jest.requireActual('stream');
  const stream = new ReadableStream({ read() { /* never */ } });
  process.nextTick(() => stream.destroy(Object.assign(new Error(`ENOENT: no such file or directory, open '${filePath}'`), { code: 'ENOENT' })));
  return stream;
}
const mockFiles = new Map<string, FakeFile>();
jest.mock('fs', () => {
  const actual = jest.requireActual('fs');
  const fake = (filePath: unknown) => typeof filePath === 'string' && filePath.startsWith('/api_data/')
    ? mockFiles.get(filePath)
    : undefined;
  const statSync = (filePath: any, ...rest: any[]) => {
    const file = fake(filePath);
    return file ? { size: file.size } : actual.statSync(filePath, ...rest);
  };
  const createReadStream = (filePath: any, ...rest: any[]) => {
    if (typeof filePath === 'string' && filePath.startsWith('/api_data/')) {
      const file = fake(filePath);
      return file ? file.stream() : mockVanished(filePath);
    }
    return actual.createReadStream(filePath, ...rest);
  };
  const patched = { ...actual, statSync, createReadStream };
  return { __esModule: true, ...patched, default: patched };
});

const mockPoolQuery = jest.fn();
jest.mock('../util/postgres', () => ({ __esModule: true, default: { query: (...args: unknown[]) => mockPoolQuery(...args) } }));
for (const repository of ['articles', 'files', 'users', 'communities', 'communityEvents', 'plugins', 'emails', 'calls']) {
  jest.doMock(`../repositories/${repository}`, () => ({ __esModule: true, default: {} }));
}
jest.mock('../util/instanceConfig', () => ({ instanceConfigScriptTag: () => '' }));
jest.mock('puppeteer', () => ({ __esModule: true, default: {} }));

const USER = '00000000-0000-4000-8000-000000000001';

let server: Server;
let baseUrl: string;
let uncaught: jest.Mock;
let unhandled: jest.Mock;
let errorLog: jest.SpyInstance;
let log: jest.SpyInstance;

beforeAll(async () => {
  errorLog = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  const { default: getRoutes } = await import('../api/getRoutes');
  const app = express();
  app.use((req, res, next) => {
    // like srv/util/express.ts: every response defaults to JSON
    res.setHeader('Content-Type', 'application/json');
    (req as any).session = { user: { id: USER } };
    next();
  });
  app.use('/', getRoutes);
  server = app.listen(0);
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  errorLog.mockRestore();
  log.mockRestore();
});

beforeEach(() => {
  mockFiles.clear();
  mockPoolQuery.mockReset();
  uncaught = jest.fn();
  unhandled = jest.fn();
  process.on('uncaughtException', uncaught);
  process.on('unhandledRejection', unhandled);
});

afterEach(async () => {
  await new Promise(resolve => setTimeout(resolve, 20));
  process.off('uncaughtException', uncaught);
  process.off('unhandledRejection', unhandled);
  expect(uncaught).not.toHaveBeenCalled();
  expect(unhandled).not.toHaveBeenCalled();
});

function allow(type: 'video' | 'download') {
  mockPoolQuery.mockResolvedValue({ rows: [{ type, isAllowed: true }] });
}

function get(path: string, headers?: Record<string, string>) {
  return fetch(`${baseUrl}${path}`, { headers, signal: AbortSignal.timeout(2000) });
}

/** a stream that delivers `chunk` and then fails with an I/O error */
function failingAfter(chunk: Buffer) {
  let sent = false;
  return new Readable({
    read() {
      if (!sent) {
        sent = true;
        this.push(chunk);
      } else {
        setImmediate(() => this.destroy(Object.assign(new Error('EIO: i/o error, read'), { code: 'EIO' })));
      }
    },
  });
}

describe('gated file streaming', () => {
  it('serves a readable file', async () => {
    allow('download');
    mockFiles.set('/api_data/doc.pdf', { size: 3, stream: () => Readable.from([Buffer.from('pdf')]) });
    const response = await get('/gated-files/doc.pdf');
    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('application/pdf');
    expect(await response.text()).toBe('pdf');
  });

  it('answers 500 when the file vanished between stat and read (gated-files)', async () => {
    allow('download');
    // stat sees it, the read stream does not
    mockFiles.set('/api_data/gone.pdf', { size: 10, stream: () => mockVanished('/api_data/gone.pdf') });
    const response = await get('/gated-files/gone.pdf');
    expect(response.status).toBe(500);
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await response.text()).toBe('Internal server error');
  });

  it('answers 500 without the range headers when a range read fails before any data (gated-videos)', async () => {
    allow('video');
    mockFiles.set('/api_data/clip.mp4', { size: 100, stream: () => new Readable({
      read() { setImmediate(() => this.destroy(new Error('EIO: i/o error, read'))); },
    }) });
    const response = await get('/gated-videos/clip.mp4', { Range: 'bytes=0-9' });
    expect(response.status).toBe(500);
    expect(response.headers.get('content-range')).toBeNull();
    expect(response.headers.get('content-type')).toMatch(/^text\/plain/);
    expect(await response.text()).toBe('Internal server error');
  });

  it('aborts the response when the read fails mid-stream (gated-videos)', async () => {
    allow('video');
    mockFiles.set('/api_data/clip.mp4', { size: 100, stream: () => failingAfter(Buffer.alloc(10, 1)) });
    const response = await get('/gated-videos/clip.mp4');
    expect(response.status).toBe(200);
    // the socket is closed at once (undici: TypeError 'terminated'), not left
    // hanging until the client's timeout (TimeoutError)
    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'TypeError' });
  });

  it('aborts the response when the read fails mid-stream (gated-files)', async () => {
    allow('download');
    mockFiles.set('/api_data/doc.pdf', { size: 100, stream: () => failingAfter(Buffer.alloc(10, 1)) });
    const response = await get('/gated-files/doc.pdf');
    expect(response.status).toBe(200);
    // the socket is closed at once (undici: TypeError 'terminated'), not left
    // hanging until the client's timeout (TimeoutError)
    await expect(response.arrayBuffer()).rejects.toMatchObject({ name: 'TypeError' });
  });
});
