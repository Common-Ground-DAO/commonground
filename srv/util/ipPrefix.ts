// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { isIPv4, isIPv6 } from 'node:net';

/**
 * Client-IP classification for rate-limit keying, built on `node:net`.
 * Replaces the unmaintained `ip` package (GHSA-2p57-rm9w-gvfp, no fixed
 * release). Only what the rate limiter needs lives here — this is not a
 * general-purpose IP library.
 */

/**
 * Expand an IPv6 address to its 16 bytes. `addr` must already have passed
 * `net.isIPv6` — this function only expands, it does not validate.
 */
export function ipv6ToBytes(addr: string): Uint8Array {
  let s = addr;
  const lastColon = s.lastIndexOf(':');
  const tailGroup = s.slice(lastColon + 1);
  if (tailGroup.includes('.')) {
    // trailing dotted quad (v4-mapped/compat form) → two 16-bit groups
    const [a, b, c, d] = tailGroup.split('.').map(Number);
    s = `${s.slice(0, lastColon + 1)}${((a << 8) | b).toString(16)}:${((c << 8) | d).toString(16)}`;
  }
  const [headStr, tailStr] = s.split('::') as [string, string?];
  const head = headStr ? headStr.split(':').map((g) => parseInt(g, 16)) : [];
  const tail = tailStr ? tailStr.split(':').map((g) => parseInt(g, 16)) : [];
  const groups = [...head, ...new Array(8 - head.length - tail.length).fill(0), ...tail];
  const bytes = new Uint8Array(16);
  groups.forEach((g, i) => {
    bytes[2 * i] = g >> 8;
    bytes[2 * i + 1] = g & 0xff;
  });
  return bytes;
}

/**
 * Derive the rate-limit bucket keys from the first address in an
 * `X-Forwarded-For` value.
 *
 * - IPv4 clients key on the dotted address (one bucket).
 * - IPv6 clients key on their /64, /56 and /48 prefixes (three buckets, so a
 *   single subscriber allocation can't dodge the limit by rotating interface
 *   IDs), hex-encoded one byte = two zero-padded chars.
 * - `::ffff:a.b.c.d` (v4-mapped) keys on the embedded IPv4 like a plain v4
 *   client. The `ip`-based implementation rejected such requests outright.
 * - Anything else returns no keys, which the rate limiter treats as an
 *   invalid request.
 *
 * The v6 keys' zero-padding is new with the `node:net` rewrite: the old
 * unpadded per-byte hex could collide across different prefixes (0x12,0x03
 * and 0x01,0x23 both encoded as "123"), letting unrelated networks share a
 * bucket. Old-format keys simply age out within the rate-limit window.
 */
export function classifyForwardedIp(xForwardedFor: string): {
  ipString?: string;
  ip56String?: string;
  ip48String?: string;
} {
  const v4 = xForwardedFor.match(/^(\d{1,3}\.){3}\d{1,3}/);
  if (v4 && isIPv4(v4[0])) {
    return { ipString: v4[0] };
  }
  const v6 = xForwardedFor.match(/^[0-9a-f:.]+/i);
  if (v6 && isIPv6(v6[0])) {
    const bytes = ipv6ToBytes(v6[0]);
    const isMappedV4 =
      bytes[10] === 0xff && bytes[11] === 0xff && bytes.slice(0, 10).every((b) => b === 0);
    if (isMappedV4) {
      return { ipString: Array.from(bytes.slice(12)).join('.') };
    }
    const hexPrefix = (byteCount: number) =>
      Array.from(bytes.slice(0, byteCount))
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
    return { ipString: hexPrefix(8), ip56String: hexPrefix(7), ip48String: hexPrefix(6) };
  }
  return {};
}
