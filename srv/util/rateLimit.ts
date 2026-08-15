// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from 'express';
import redisManager from '../redis';
import errors from '../common/errors';
import { classifyForwardedIp } from './ipPrefix';

const redisClient = redisManager.getClient('data');

export function extractIpFromRequest(req: express.Request) {
  const xForwardedFor = req.headers['x-forwarded-for'];
  return classifyForwardedIp(typeof xForwardedFor === 'string' ? xForwardedFor : '');
}

/**
 * Sliding-window counter for one bucket: record this hit, drop what fell out of
 * the window, and report whether the bucket is still within `limit`. A hit that
 * busts the limit removes itself again, so a blocked caller does not extend its
 * own lockout.
 */
function countWithinWindow(
  key: string,
  limit: number,
  windowMs: number,
  now: number,
): Promise<boolean> {
  const randVal = `${now}:${Math.random().toFixed(4)}`;
  return redisClient
    .multi()
    .zAdd(key, { value: randVal, score: now })
    .expire(key, Math.floor(windowMs / 1000))
    .zRemRangeByScore(key, 0, now - windowMs)
    .zCount(key, now - windowMs, now)
    // `execTyped()` (node-redis 5+) preserves the per-command reply types
    // of the chain; plain `exec()` now collapses them to `ReplyUnion[]`.
    .execTyped()
    .then((results) => {
      const count = results[3];
      if (count <= limit) {
        return true;
      }
      return redisClient.zRem(key, randVal).then(() => false);
    });
}

/**
 * Optional per-request identity to count against *instead of* the IP prefixes,
 * with `limit_identity` as its budget. Returning `undefined` for a given
 * request falls back to IP keying, so one limiter can cover both an
 * authenticated and an anonymous branch of the same route.
 *
 * For routes a logged-in user hits repeatedly, IP keying pools every client
 * behind one CGNAT or campus NAT into a single bucket; keying on the account
 * bills the actor instead. Only safe where the identity cannot be minted
 * freely — a session user id, not a client-supplied header.
 *
 * The two fields are paired in the type so a caller cannot supply an extractor
 * whose limit is silently ignored.
 */
type IdentityKeying =
  | { identity: (req: express.Request) => string | undefined; limit_identity: number }
  | { identity?: undefined; limit_identity?: undefined };

export default function ipRateLimitHandler(options: {
  windowMs: number;
  limit_v4_v6_64: number;
  limit_v6_56: number;
  limit_v6_48: number;
} & IdentityKeying) {
  const rateLimiter = async (req: express.Request, res: express.Response) => {
    const url = req.originalUrl;
    const now = Date.now();

    const identity = options.identity?.(req);
    if (identity !== undefined && options.limit_identity !== undefined) {
      // `id:` prefix so an identity can never collide with an IP bucket
      const withinLimit = await countWithinWindow(
        `ratelimit:${url}:id:${identity}`,
        options.limit_identity,
        options.windowMs,
        now,
      );
      if (!withinLimit) {
        throw new Error(errors.server.RATE_LIMIT_EXCEEDED);
      }
      return;
    }

    const { ipString, ip56String, ip48String } = extractIpFromRequest(req);

    let promises: Promise<boolean>[] = [];
    function addPromise(key: string, limit: number) {
      promises.push(countWithinWindow(key, limit, options.windowMs, now));
    }

    if (ipString) {
      const key = `ratelimit:${url}:${ipString}`;
      addPromise(key, options.limit_v4_v6_64);
    }
    else {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    if (ip56String) {
      const key = `ratelimit:${url}:${ip56String}`;
      addPromise(key, options.limit_v6_56);
    }
    if (ip48String) {
      const key = `ratelimit:${url}:${ip48String}`;
      addPromise(key, options.limit_v6_48);
    }
    const promiseResults = await Promise.all(promises);
    if (!promiseResults.every(p => p)) {
      throw new Error(errors.server.RATE_LIMIT_EXCEEDED);
    }
  };
  return rateLimiter;
}