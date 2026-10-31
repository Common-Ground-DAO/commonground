// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import dns from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import { isIP, isIPv4, isIPv6, type LookupFunction } from 'node:net';
import zlib from 'node:zlib';
import { ipv6ToBytes } from './ipPrefix';

/**
 * Outbound HTTP(S) GET for URLs that come from users or from third-party data
 * (link previews, profile pictures, …).
 *
 * - only `http:` and `https:` URLs;
 * - every hop connects only to public unicast addresses: host names are
 *   resolved by a custom `lookup` at connect time, so the address that is
 *   checked is the address that is used, and IP literals are checked up front;
 * - redirects are followed manually, each hop re-validated;
 * - one deadline covers the whole request including redirects;
 * - the body (after decompression) is capped at `maxBytes`;
 * - the final response's content type must pass `acceptContentType`.
 *
 * No proxy environment variables are honoured and no cookies are kept.
 */

export type SafeFetchErrorCode =
  | 'INVALID_URL'
  | 'BLOCKED_ADDRESS'
  | 'TOO_MANY_REDIRECTS'
  | 'TOO_LARGE'
  | 'TIMEOUT'
  | 'BAD_STATUS'
  | 'BAD_CONTENT_TYPE'
  | 'NETWORK';

export class SafeFetchError extends Error {
  constructor(public readonly code: SafeFetchErrorCode, message?: string) {
    super(message ? `${code}: ${message}` : code);
    this.name = 'SafeFetchError';
  }
}

export type SafeFetchOptions = {
  /** Maximum decoded body size in bytes. */
  maxBytes: number;
  /** Deadline for the whole fetch, redirects included. Default 10 s. */
  timeoutMs?: number;
  /** Maximum number of redirects to follow. Default 5. */
  maxRedirects?: number;
  /** Receives the lower-cased media type without parameters (may be ''). */
  acceptContentType?: (mediaType: string) => boolean;
  headers?: Record<string, string>;
};

export type SafeFetchResult = {
  /** URL of the final hop, after redirects. */
  url: string;
  status: number;
  /** Lower-cased media type without parameters ('' if none was sent). */
  contentType: string;
  body: Buffer;
};

type V4Range = [number, number, number, number, number];

// Special-purpose IPv4 ranges (RFC 6890 and friends); none of them is a
// destination for a request on behalf of a user.
const BLOCKED_V4: V4Range[] = [
  [0, 0, 0, 0, 8], // "this" network
  [10, 0, 0, 0, 8], // private
  [100, 64, 0, 0, 10], // shared address space (CGN)
  [127, 0, 0, 0, 8], // loopback
  [169, 254, 0, 0, 16], // link-local, cloud metadata services
  [172, 16, 0, 0, 12], // private (Docker networks)
  [192, 0, 0, 0, 24], // IETF protocol assignments
  [192, 0, 2, 0, 24], // documentation
  [192, 88, 99, 0, 24], // 6to4 relay anycast
  [192, 168, 0, 0, 16], // private
  [198, 18, 0, 0, 15], // benchmarking
  [198, 51, 100, 0, 24], // documentation
  [203, 0, 113, 0, 24], // documentation
  [224, 0, 0, 0, 4], // multicast
  [240, 0, 0, 0, 4], // reserved, broadcast
];

function matchesPrefix(bytes: ArrayLike<number>, prefix: ArrayLike<number>, bits: number): boolean {
  for (let i = 0; bits > 0; i++, bits -= 8) {
    const mask = bits >= 8 ? 0xff : (0xff << (8 - bits)) & 0xff;
    if ((bytes[i] & mask) !== (prefix[i] & mask)) {
      return false;
    }
  }
  return true;
}

function isPublicV4Bytes(bytes: ArrayLike<number>): boolean {
  return !BLOCKED_V4.some(([a, b, c, d, bits]) => matchesPrefix(bytes, [a, b, c, d], bits));
}

function v6Prefix(groups: number[]): number[] {
  const bytes: number[] = [];
  for (const g of groups) {
    bytes.push(g >> 8, g & 0xff);
  }
  return bytes;
}

// IPv6 ranges that are never a legitimate public destination.
const BLOCKED_V6: [number[], number][] = [
  [v6Prefix([0, 0, 0, 0, 0, 0]), 96], // unspecified, loopback, IPv4-compatible
  [v6Prefix([0x64, 0xff9b, 1]), 48], // local-use NAT64
  [v6Prefix([0x100, 0, 0, 0]), 64], // discard-only
  [v6Prefix([0x2001]), 23], // IETF protocol assignments (incl. Teredo)
  [v6Prefix([0x2001, 0xdb8]), 32], // documentation
  [v6Prefix([0x3fff]), 20], // documentation
  [v6Prefix([0xfc00]), 7], // unique local
  [v6Prefix([0xfe80]), 10], // link-local
  [v6Prefix([0xfec0]), 10], // site-local (deprecated)
  [v6Prefix([0xff00]), 8], // multicast
];

/**
 * Whether `address` (an IPv4 or IPv6 literal) is a public unicast address.
 * IPv6 forms that embed an IPv4 address (v4-mapped, NAT64 well-known prefix,
 * 6to4) are judged by the embedded address. Anything unparseable is not
 * public.
 */
export function isPublicAddress(address: string): boolean {
  const ip = address.startsWith('[') && address.endsWith(']') ? address.slice(1, -1) : address;
  if (isIPv4(ip)) {
    return isPublicV4Bytes(ip.split('.').map(Number));
  }
  if (!isIPv6(ip) || ip.includes('%')) {
    // zone ids only exist for link-local scopes
    return false;
  }
  const bytes = ipv6ToBytes(ip);
  if (matchesPrefix(bytes, v6Prefix([0, 0, 0, 0, 0, 0xffff]), 96)) {
    return isPublicV4Bytes(bytes.slice(12));
  }
  if (matchesPrefix(bytes, v6Prefix([0x64, 0xff9b, 0, 0, 0, 0]), 96)) {
    return isPublicV4Bytes(bytes.slice(12));
  }
  if (matchesPrefix(bytes, v6Prefix([0x2002]), 16)) {
    return isPublicV4Bytes(bytes.slice(2, 6));
  }
  return !BLOCKED_V6.some(([prefix, bits]) => matchesPrefix(bytes, prefix, bits));
}

/**
 * Parses `rawUrl` and checks scheme, credentials and (for IP literals) the
 * address. Host names are checked later, when they are resolved.
 */
export function parsePublicHttpUrl(rawUrl: string, base?: string): URL {
  return parseHttpUrl(rawUrl, base, isPublicAddress);
}

type AddressCheck = (address: string) => boolean;

function parseHttpUrl(rawUrl: string, base: string | undefined, isAllowedAddress: AddressCheck): URL {
  let url: URL;
  try {
    url = new URL(rawUrl, base);
  } catch {
    throw new SafeFetchError('INVALID_URL');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new SafeFetchError('INVALID_URL', 'scheme');
  }
  if (url.username || url.password) {
    throw new SafeFetchError('INVALID_URL', 'credentials');
  }
  const host = url.hostname.startsWith('[') ? url.hostname.slice(1, -1) : url.hostname;
  if (!host) {
    throw new SafeFetchError('INVALID_URL', 'host');
  }
  if (isIP(host) && !isAllowedAddress(host)) {
    throw new SafeFetchError('BLOCKED_ADDRESS');
  }
  return url;
}

function createLookup(isAllowedAddress: AddressCheck): LookupFunction {
  return ((hostname: string, options: dns.LookupOptions, callback: (...args: any[]) => void) => {
    dns.lookup(hostname, { family: options?.family, hints: options?.hints, all: true }, (err, addresses) => {
      if (err) {
        callback(err);
        return;
      }
      // Reject the host if *any* of its addresses is internal, so the outcome
      // does not depend on which address the connection attempt picks.
      if (addresses.length === 0 || !addresses.every((a) => isAllowedAddress(a.address))) {
        callback(new SafeFetchError('BLOCKED_ADDRESS'));
        return;
      }
      if (options?.all) {
        callback(null, addresses);
      } else {
        callback(null, addresses[0].address, addresses[0].family);
      }
    });
  }) as LookupFunction;
}

function mediaTypeOf(header: string | string[] | undefined): string {
  const value = Array.isArray(header) ? header[0] : header;
  return (value || '').split(';')[0].trim().toLowerCase();
}

function decoderFor(encoding: string | undefined) {
  switch ((encoding || '').trim().toLowerCase()) {
    case '':
    case 'identity':
      return null;
    case 'gzip':
    case 'x-gzip':
      return zlib.createGunzip();
    case 'deflate':
      return zlib.createInflate();
    case 'br':
      return zlib.createBrotliDecompress();
    default:
      throw new SafeFetchError('BAD_CONTENT_TYPE', 'content-encoding');
  }
}

function requestOnce(
  url: URL,
  headers: Record<string, string>,
  lookup: LookupFunction,
  signal: AbortSignal,
): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    const transport = url.protocol === 'https:' ? https : http;
    const req = transport.request(url, {
      method: 'GET',
      headers,
      lookup,
      signal,
      agent: false,
    });
    req.on('response', resolve);
    req.on('error', reject);
    req.end();
  });
}

function readBody(
  response: http.IncomingMessage,
  maxBytes: number,
): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const declared = Number(response.headers['content-length']);
    if (Number.isFinite(declared) && declared > maxBytes) {
      response.destroy();
      reject(new SafeFetchError('TOO_LARGE'));
      return;
    }
    let decoder: zlib.Gunzip | zlib.Inflate | zlib.BrotliDecompress | null;
    try {
      decoder = decoderFor(response.headers['content-encoding']);
    } catch (e) {
      response.destroy();
      reject(e);
      return;
    }
    const stream = decoder ? response.pipe(decoder) : response;
    const chunks: Buffer[] = [];
    let total = 0;
    let done = false;
    const fail = (error: unknown) => {
      if (done) return;
      done = true;
      response.destroy();
      decoder?.destroy();
      reject(error);
    };
    stream.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > maxBytes) {
        fail(new SafeFetchError('TOO_LARGE'));
        return;
      }
      chunks.push(chunk);
    });
    stream.on('end', () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks));
    });
    stream.on('error', fail);
    if (decoder) {
      response.on('error', fail);
    }
  });
}

const DEFAULT_HEADERS: Record<string, string> = {
  'User-Agent': 'Mozilla/5.0 (compatible; CommonGround/1.0)',
  'Accept-Encoding': 'gzip, deflate, br',
};

/**
 * Builds a fetch function. `isAllowedAddress` exists for tests, which need a
 * loopback server; production code uses the default export.
 */
export function createSafeFetch(isAllowedAddress: AddressCheck = isPublicAddress) {
  const lookup = createLookup(isAllowedAddress);

  return async function safeFetch(rawUrl: string, options: SafeFetchOptions): Promise<SafeFetchResult> {
    const { maxBytes, timeoutMs = 10_000, maxRedirects = 5, acceptContentType } = options;
    const headers = { ...DEFAULT_HEADERS, ...options.headers };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      let url = parseHttpUrl(rawUrl, undefined, isAllowedAddress);
      for (let hop = 0; ; hop++) {
        const response = await requestOnce(url, headers, lookup, controller.signal);
        const status = response.statusCode || 0;

        if (status >= 300 && status < 400 && response.headers.location) {
          // The body of a redirect or error response is never read; closing
          // the connection keeps a server from streaming into it.
          response.destroy();
          if (hop >= maxRedirects) {
            throw new SafeFetchError('TOO_MANY_REDIRECTS');
          }
          url = parseHttpUrl(response.headers.location, url.toString(), isAllowedAddress);
          continue;
        }

        if (status < 200 || status >= 300) {
          response.destroy();
          throw new SafeFetchError('BAD_STATUS', String(status));
        }

        const contentType = mediaTypeOf(response.headers['content-type']);
        if (acceptContentType && !acceptContentType(contentType)) {
          response.destroy();
          throw new SafeFetchError('BAD_CONTENT_TYPE', contentType);
        }

        const body = await readBody(response, maxBytes);
        return { url: url.toString(), status, contentType, body };
      }
    } catch (e: any) {
      if (e instanceof SafeFetchError) {
        throw e;
      }
      if (controller.signal.aborted) {
        throw new SafeFetchError('TIMEOUT');
      }
      if (e?.cause instanceof SafeFetchError) {
        throw e.cause;
      }
      throw new SafeFetchError('NETWORK', e?.code || e?.message);
    } finally {
      clearTimeout(timer);
      // Tears down any request of this call that is still open.
      controller.abort();
    }
  };
}

const safeFetch = createSafeFetch();
export default safeFetch;

/** Upper bound for a remote image that is handed to `saveImage()`. */
export const REMOTE_IMAGE_MAX_BYTES = 8 * 1024 * 1024;

/** Fetches a remote image (e.g. a profile picture) and returns its bytes. */
export async function fetchRemoteImage(url: string, headers?: Record<string, string>): Promise<Buffer> {
  const result = await safeFetch(url, {
    maxBytes: REMOTE_IMAGE_MAX_BYTES,
    headers: { Accept: 'image/*', ...headers },
    acceptContentType: (type) => type === '' || type.startsWith('image/') || type === 'application/octet-stream',
  });
  return result.body;
}
