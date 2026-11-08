// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import http from 'node:http';
import { AddressInfo } from 'node:net';
import zlib from 'node:zlib';
import safeFetch, { createSafeFetch, isPublicAddress, parsePublicHttpUrl, SafeFetchError } from '../util/safeFetch';

describe('isPublicAddress', () => {
  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '93.184.215.14',
    '100.63.255.255',
    '100.128.0.0',
    '172.15.255.255',
    '172.32.0.0',
    '2606:4700:4700::1111',
    '2a00:1450:4001:82a::200e',
    '::ffff:8.8.8.8',
    '64:ff9b::808:808', // NAT64 of 8.8.8.8
    '2002:808:808::1', // 6to4 of 8.8.8.8
  ])('accepts %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(true);
  });

  it.each([
    '0.0.0.0',
    '10.0.0.1',
    '100.64.0.1',
    '127.0.0.1',
    '127.1.2.3',
    '169.254.169.254',
    '172.16.0.1',
    '172.31.255.255',
    '192.0.0.8',
    '192.168.1.1',
    '198.18.0.1',
    '224.0.0.1',
    '255.255.255.255',
    '::',
    '::1',
    '::127.0.0.1',
    '::ffff:127.0.0.1',
    '::ffff:7f00:1',
    '::ffff:169.254.169.254',
    '::ffff:10.0.0.1',
    '64:ff9b::7f00:1',
    '64:ff9b:1::1',
    '2002:7f00:1::1',
    '2001::1', // Teredo
    '2001:db8::1',
    'fc00::1',
    'fd00:ec2::254',
    'fe80::1',
    'fe80::1%eth0',
    'ff02::1',
    '[::1]',
    'not-an-ip',
    '',
  ])('rejects %s', (ip) => {
    expect(isPublicAddress(ip)).toBe(false);
  });
});

describe('parsePublicHttpUrl', () => {
  it.each([
    'file:///etc/passwd',
    'ftp://example.com/',
    'gopher://example.com/',
    'javascript:alert(1)',
    'data:text/html,hi',
    'http://user:pass@example.com/',
    'not a url',
  ])('rejects %s', (url) => {
    expect(() => parsePublicHttpUrl(url)).toThrow(SafeFetchError);
  });

  it.each([
    'http://127.0.0.1/',
    'http://2130706433/', // 127.0.0.1 as a single number
    'http://0x7f.1/',
    'http://[::1]:8080/',
    'http://[::ffff:169.254.169.254]/',
    'https://169.254.169.254/latest/meta-data/',
    'http://10.1.2.3:9333/',
  ])('rejects the internal address in %s', (url) => {
    expect(() => parsePublicHttpUrl(url)).toThrow('BLOCKED_ADDRESS');
  });

  it('accepts public http(s) URLs', () => {
    expect(parsePublicHttpUrl('https://example.com/a?b=c').hostname).toBe('example.com');
    expect(parsePublicHttpUrl('http://93.184.215.14/').hostname).toBe('93.184.215.14');
  });
});

describe('safeFetch against a local server', () => {
  let server: http.Server;
  let base: string;
  let port: number;
  let hits: string[];
  // resolves when the server side of a response to that path is closed
  let closed: Map<string, Promise<void>>;

  const endless = (res: http.ServerResponse) => {
    const chunk = Buffer.alloc(16 * 1024, 'x');
    const interval = setInterval(() => res.write(chunk), 5);
    res.on('close', () => clearInterval(interval));
  };

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      hits.push(req.url || '');
      const url = new URL(req.url || '/', 'http://localhost');
      closed.set(url.pathname, new Promise((resolve) => res.on('close', () => resolve())));
      switch (url.pathname) {
        case '/page':
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end('<html><head><title>hi</title></head></html>');
          return;
        case '/gzip':
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
          res.end(zlib.gzipSync('<html>compressed</html>'));
          return;
        case '/bomb':
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Encoding': 'gzip' });
          res.end(zlib.gzipSync(Buffer.alloc(5_000_000)));
          return;
        case '/big':
          res.writeHead(200, { 'Content-Type': 'text/html', 'Content-Length': '5000000' });
          res.end(Buffer.alloc(5_000_000));
          return;
        case '/chunked':
          res.writeHead(200, { 'Content-Type': 'text/html' });
          for (let i = 0; i < 50; i++) res.write(Buffer.alloc(100_000));
          res.end();
          return;
        case '/image':
          res.writeHead(200, { 'Content-Type': 'image/png' });
          res.end('png');
          return;
        case '/redirect':
          res.writeHead(302, { Location: url.searchParams.get('to') || '/page' });
          res.end();
          return;
        case '/redirect-endless':
          res.writeHead(302, { Location: '/page', 'Content-Type': 'text/html' });
          endless(res);
          return;
        case '/error-endless':
          res.writeHead(500, { 'Content-Type': 'text/html' });
          endless(res);
          return;
        case '/loop':
          res.writeHead(302, { Location: '/loop' });
          res.end();
          return;
        case '/hang':
          // never answers
          return;
        case '/slowbody':
          // headers and a first chunk, then nothing
          res.writeHead(200, { 'Content-Type': 'text/html' });
          res.write('<html>');
          return;
        case '/notfound':
          res.writeHead(404);
          res.end();
          return;
      }
      res.writeHead(500);
      res.end();
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    port = (server.address() as AddressInfo).port;
    base = `http://127.0.0.1:${port}`;
  });

  afterAll(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });

  beforeEach(() => {
    hits = [];
    closed = new Map();
  });

  const closedWithin = (path: string, ms: number) => Promise.race([
    closed.get(path)!.then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), ms)),
  ]);

  // Only the loopback test server is reachable for this instance.
  const loopbackFetch = createSafeFetch((address) => address === '127.0.0.1');

  it('never connects to loopback with the default address policy', async () => {
    await expect(safeFetch(`${base}/page`, { maxBytes: 1000 })).rejects.toThrow('BLOCKED_ADDRESS');
    await expect(safeFetch(`http://localhost:${port}/page`, { maxBytes: 1000 })).rejects.toThrow('BLOCKED_ADDRESS');
    expect(hits).toEqual([]);
  });

  it('fetches a page', async () => {
    const result = await loopbackFetch(`${base}/page`, {
      maxBytes: 1000,
      acceptContentType: (type) => type === 'text/html',
    });
    expect(result.status).toBe(200);
    expect(result.contentType).toBe('text/html');
    expect(result.body.toString()).toContain('<title>hi</title>');
    expect(result.url).toBe(`${base}/page`);
  });

  it('decodes gzip', async () => {
    const result = await loopbackFetch(`${base}/gzip`, { maxBytes: 1000 });
    expect(result.body.toString()).toBe('<html>compressed</html>');
  });

  it('caps the decoded size', async () => {
    await expect(loopbackFetch(`${base}/bomb`, { maxBytes: 1_000_000 })).rejects.toThrow('TOO_LARGE');
    await expect(loopbackFetch(`${base}/big`, { maxBytes: 1_000_000 })).rejects.toThrow('TOO_LARGE');
    await expect(loopbackFetch(`${base}/chunked`, { maxBytes: 1_000_000 })).rejects.toThrow('TOO_LARGE');
  });

  it('checks the content type', async () => {
    await expect(loopbackFetch(`${base}/image`, {
      maxBytes: 1000,
      acceptContentType: (type) => type.startsWith('text/'),
    })).rejects.toThrow('BAD_CONTENT_TYPE');
  });

  it('follows redirects and reports the final URL', async () => {
    const result = await loopbackFetch(`${base}/redirect?to=/page`, { maxBytes: 1000 });
    expect(result.url).toBe(`${base}/page`);
  });

  it('re-checks every redirect target', async () => {
    for (const to of [
      'http://169.254.169.254/latest/meta-data/',
      'http://127.0.0.2/',
      'http://[::1]/',
      'file:///etc/passwd',
    ]) {
      await expect(loopbackFetch(`${base}/redirect?to=${encodeURIComponent(to)}`, { maxBytes: 1000 }))
        .rejects.toThrow(/BLOCKED_ADDRESS|INVALID_URL/);
    }
    expect(hits.every((hit) => hit.startsWith('/redirect'))).toBe(true);
  });

  it('closes the connection of a redirect whose body does not end', async () => {
    const result = await loopbackFetch(`${base}/redirect-endless`, { maxBytes: 1000, timeoutMs: 5000 });
    expect(result.url).toBe(`${base}/page`);
    expect(await closedWithin('/redirect-endless', 1000)).toBe(true);
  });

  it('closes the connection of an error response whose body does not end', async () => {
    await expect(loopbackFetch(`${base}/error-endless`, { maxBytes: 1000, timeoutMs: 5000 })).rejects.toThrow('BAD_STATUS');
    expect(await closedWithin('/error-endless', 1000)).toBe(true);
  });

  it('limits the number of redirects', async () => {
    await expect(loopbackFetch(`${base}/loop`, { maxBytes: 1000, maxRedirects: 3 })).rejects.toThrow('TOO_MANY_REDIRECTS');
    expect(hits.length).toBe(4);
  });

  it('times out', async () => {
    await expect(loopbackFetch(`${base}/hang`, { maxBytes: 1000, timeoutMs: 300 })).rejects.toThrow('TIMEOUT');
    await expect(loopbackFetch(`${base}/slowbody`, { maxBytes: 1000, timeoutMs: 300 })).rejects.toThrow('TIMEOUT');
  });

  it('rejects error statuses', async () => {
    await expect(loopbackFetch(`${base}/notfound`, { maxBytes: 1000 })).rejects.toThrow('BAD_STATUS');
  });
});
