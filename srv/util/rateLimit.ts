// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from 'express';
import redisManager from '../redis';
import { withTimeout } from '../redis/client';
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
  // node-redis gives MULTI no command timeout: without withTimeout() a
  // request would wait for the whole outage of the server
  return withTimeout(redisClient
    .multi()
    .zAdd(key, { value: randVal, score: now })
    .expire(key, Math.floor(windowMs / 1000))
    .zRemRangeByScore(key, 0, now - windowMs)
    .zCount(key, now - windowMs, now)
    // `execTyped()` (node-redis 5+) preserves the per-command reply types
    // of the chain; plain `exec()` now collapses them to `ReplyUnion[]`.
    .execTyped(), 'rate-limit MULTI')
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
  /**
   * Name of the counter, instead of the request URL. Needed for routes that
   * carry data in the query string: with the URL as the key, every distinct
   * query would get a bucket of its own.
   */
  bucket?: string;
} & IdentityKeying) {
  const rateLimiter = async (req: express.Request, res: express.Response) => {
    const url = options.bucket ?? req.originalUrl;
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

/**
 * Counts only failures, per key: `assertBelow(key)` refuses with
 * RATE_LIMIT_EXCEEDED once `limit` failures fell into the window — without
 * counting the request itself —, `recordFailure(key)` counts one. For budgets
 * that successes must never use up (per account, per client IP).
 */
export function keyFailureLimiter(options: { bucket: string; windowMs: number; limit: number }) {
  const keyFor = (key: string) => `ratelimit:${options.bucket}:failures:${key}`;
  return {
    async assertBelow(key: string): Promise<void> {
      const redisKey = keyFor(key);
      const now = Date.now();
      const results = await withTimeout(redisClient
        .multi()
        .zRemRangeByScore(redisKey, 0, now - options.windowMs)
        .zCount(redisKey, now - options.windowMs, now)
        .execTyped(), 'failure-limit MULTI');
      if (results[1] >= options.limit) {
        throw new Error(errors.server.RATE_LIMIT_EXCEEDED);
      }
    },
    async recordFailure(key: string): Promise<void> {
      const redisKey = keyFor(key);
      const now = Date.now();
      await withTimeout(redisClient
        .multi()
        .zAdd(redisKey, { value: `${now}:${Math.random().toFixed(6)}`, score: now })
        .expire(redisKey, Math.ceil(options.windowMs / 1000))
        .execTyped(), 'failure-limit MULTI');
    },
  };
}

export type FailureReservation = {
  /** the attempt succeeded: it does not count as a failure */
  release(): Promise<void>;
};

/**
 * A failure budget that holds under parallel attempts: `reserve(key)` counts
 * the attempt as a failure up front — adding it and counting in one MULTI,
 * like countWithinWindow — and refuses with RATE_LIMIT_EXCEEDED (removing
 * its own entry again) once the window holds more than `limit`. An attempt
 * that then succeeds calls `release()`; one that fails keeps its entry, so
 * it stays counted. N parallel attempts can therefore never get more than
 * `limit` checks through.
 */
export function failureBudget(options: { bucket: string; windowMs: number; limit: number }) {
  return {
    async reserve(key: string): Promise<FailureReservation> {
      const redisKey = `ratelimit:${options.bucket}:failures:${key}`;
      const now = Date.now();
      const entry = `${now}:${Math.random().toFixed(8)}`;
      const results = await withTimeout(redisClient
        .multi()
        .zAdd(redisKey, { value: entry, score: now })
        .expire(redisKey, Math.ceil(options.windowMs / 1000))
        .zRemRangeByScore(redisKey, 0, now - options.windowMs)
        .zCount(redisKey, now - options.windowMs, now)
        .execTyped(), 'failure-budget MULTI');
      const release = async () => {
        await redisClient.zRem(redisKey, entry);
      };
      if (results[3] > options.limit) {
        await release();
        throw new Error(errors.server.RATE_LIMIT_EXCEEDED);
      }
      return { release };
    },
  };
}

/**
 * Reserves one slot in each budget (see failureBudget); if one of them is
 * spent, the slots already taken are given back and RATE_LIMIT_EXCEEDED is
 * thrown.
 */
export async function reserveFailures(
  reservations: { budget: ReturnType<typeof failureBudget>; key: string }[],
): Promise<FailureReservation> {
  const taken: FailureReservation[] = [];
  try {
    for (const { budget, key } of reservations) {
      taken.push(await budget.reserve(key));
    }
  }
  catch (e) {
    await Promise.all(taken.map(reservation => reservation.release()));
    throw e;
  }
  return {
    release: async () => {
      await Promise.all(taken.map(reservation => reservation.release()));
    },
  };
}

/**
 * The client's network for per-account failure budgets: the IPv4 /24, or the
 * IPv6 /56 — so that a third party elsewhere cannot spend a user's budget.
 */
export function clientPrefixKey(req: express.Request): string {
  const { ipString, ip56String } = extractIpFromRequest(req);
  if (ip56String) {
    return `v6:${ip56String}`;
  }
  if (ipString) {
    return `v4:${ipString.split('.').slice(0, 3).join('.')}`;
  }
  throw new Error(errors.server.INVALID_REQUEST);
}

/** keyFailureLimiter keyed on the client IP (IPv4 address / IPv6 /64). */
export function ipFailureLimiter(options: { bucket: string; windowMs: number; limit: number }) {
  const limiter = keyFailureLimiter(options);
  const keyFor = (req: express.Request) => {
    const { ipString } = extractIpFromRequest(req);
    if (!ipString) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    return ipString;
  };
  return {
    assertBelow: (req: express.Request) => limiter.assertBelow(keyFor(req)),
    recordFailure: (req: express.Request) => limiter.recordFailure(keyFor(req)),
  };
}

/**
 * Sliding-window limit on an arbitrary key the caller computes — for limits
 * that are neither per IP nor "the request's identity", e.g. how many mails
 * may go to one target address. Throws RATE_LIMIT_EXCEEDED when the key's
 * bucket is full. `bucket` names the counter family; keys of different
 * families never collide.
 */
export function keyRateLimitHandler(options: { bucket: string; windowMs: number; limit: number }) {
  return async (key: string) => {
    const withinLimit = await countWithinWindow(
      `ratelimit:${options.bucket}:key:${key}`,
      options.limit,
      options.windowMs,
      Date.now(),
    );
    if (!withinLimit) {
      throw new Error(errors.server.RATE_LIMIT_EXCEEDED);
    }
  };
}