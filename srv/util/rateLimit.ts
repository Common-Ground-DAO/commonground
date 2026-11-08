// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from 'express';
import redisManager from '../redis';
import { withTimeout } from '../redis/client';
import errors from '../common/errors';
import { classifyForwardedIp } from './ipPrefix';
import { longestWait, RateLimitError, type LimitKind } from './rateLimitError';

const redisClient = redisManager.getClient('data');

export function extractIpFromRequest(req: express.Request) {
  const xForwardedFor = req.headers['x-forwarded-for'];
  return classifyForwardedIp(typeof xForwardedFor === 'string' ? xForwardedFor : '');
}

/**
 * Seconds until the window of `key` has room for one more hit, given that it
 * holds `count` hits and allows `limit`: the (count - limit + 1)-th oldest
 * hit has to leave the window first. Called only for a refused request.
 */
async function secondsUntilRoomInKey(key: string, count: number, limit: number, windowMs: number, now: number): Promise<number> {
  const rank = Math.max(0, count - limit);
  const [leaving] = await redisClient.zRangeWithScores(key, rank, rank);
  if (!leaving) {
    return 1;
  }
  return Math.max(1, Math.ceil((leaving.score + windowMs - now) / 1000));
}

/** one sliding-window counter: a Redis key, its limit and window, and what kind of limit it is */
export type LimitBucket = { key: string; limit: number; windowMs: number; kind: LimitKind };

/**
 * Records one hit in a bucket, drops what fell out of the window, and reports
 * whether the bucket is still within its limit (`wait` null) or how many
 * seconds the caller has to wait. A hit that busts the limit removes itself
 * again, so a blocked caller does not extend its own lockout; `release()`
 * takes back an accepted hit.
 */
async function hitBucket(bucket: LimitBucket, now: number): Promise<{ wait: number | null; release: () => Promise<void> }> {
  const { key, limit, windowMs } = bucket;
  const randVal = `${now}:${Math.random().toFixed(8)}`;
  // node-redis gives MULTI no command timeout: without withTimeout() a
  // request would wait for the whole outage of the server
  const results = await withTimeout(redisClient
    .multi()
    .zAdd(key, { value: randVal, score: now })
    .expire(key, Math.floor(windowMs / 1000))
    .zRemRangeByScore(key, 0, now - windowMs)
    .zCount(key, now - windowMs, now)
    // `execTyped()` (node-redis 5+) preserves the per-command reply types
    // of the chain; plain `exec()` now collapses them to `ReplyUnion[]`.
    .execTyped(), 'rate-limit MULTI');
  const release = async () => {
    await redisClient.zRem(key, randVal);
  };
  const count = results[3];
  if (count <= limit) {
    return { wait: null, release };
  }
  await release();
  return { wait: await secondsUntilRoomInKey(key, count - 1, limit, windowMs, now), release: async () => undefined };
}

/** whether the next hit would be refused (seconds to wait) or not (null), without recording one */
async function peekBucket(bucket: LimitBucket, now: number): Promise<number | null> {
  const { key, limit, windowMs } = bucket;
  const results = await withTimeout(redisClient
    .multi()
    .zRemRangeByScore(key, 0, now - windowMs)
    .zCount(key, now - windowMs, now)
    .execTyped(), 'rate-limit MULTI');
  const count = results[1];
  if (count < limit) {
    return null;
  }
  return secondsUntilRoomInKey(key, count, limit, windowMs, now);
}

/** the refusal for the bucket with the longest wait (null: nothing refused) */
function refusal(buckets: LimitBucket[], waits: (number | null)[]): RateLimitError | null {
  const wait = longestWait(waits);
  if (wait === null) {
    return null;
  }
  return new RateLimitError(wait, buckets[waits.indexOf(wait)].kind);
}

/**
 * Counts one hit in each bucket — several windows (an hour and a day),
 * prefixes (IPv4, IPv6 /64, /56, /48) or keys (a client and a target
 * address) of one request. If any of them refuses, the hits counted in the
 * others are taken back: a refused request counts nowhere, so retrying
 * never fills one bucket while another one blocks. Throws RateLimitError
 * with the longest wait (and the kind of that limit).
 */
export async function enforceLimits(buckets: LimitBucket[]): Promise<void> {
  const now = Date.now();
  const hits = await Promise.all(buckets.map(bucket => hitBucket(bucket, now)));
  const error = refusal(buckets, hits.map(hit => hit.wait));
  if (error) {
    await Promise.all(hits.map(hit => hit.release()));
    throw error;
  }
}

/**
 * Refuses like enforceLimits when the next request would be refused, without
 * counting one: lets an earlier step of a multi-step flow warn before the
 * person has filled in everything (the account limit at the sign-up code
 * request).
 */
export async function peekLimits(buckets: LimitBucket[]): Promise<void> {
  const now = Date.now();
  const waits = await Promise.all(buckets.map(bucket => peekBucket(bucket, now)));
  const error = refusal(buckets, waits);
  if (error) {
    throw error;
  }
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

export type IpRateLimiter = ((req: express.Request, res: express.Response) => Promise<void>) & {
  /** like the limiter itself, without counting (peekLimits) */
  peek: (req: express.Request) => Promise<void>;
  /** the request's buckets, to enforce them together with others (enforceLimits) */
  buckets: (req: express.Request) => LimitBucket[];
};

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
  /** what the client is told was limited (default 'attempts') */
  kind?: LimitKind;
} & IdentityKeying): IpRateLimiter {
  const kind = options.kind ?? 'attempts';
  const { windowMs } = options;
  const buckets = (req: express.Request): LimitBucket[] => {
    const url = options.bucket ?? req.originalUrl;
    const identity = options.identity?.(req);
    if (identity !== undefined && options.limit_identity !== undefined) {
      // `id:` prefix so an identity can never collide with an IP bucket
      return [{ key: `ratelimit:${url}:id:${identity}`, limit: options.limit_identity, windowMs, kind }];
    }

    const { ipString, ip56String, ip48String } = extractIpFromRequest(req);
    if (!ipString) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    const result: LimitBucket[] = [{ key: `ratelimit:${url}:${ipString}`, limit: options.limit_v4_v6_64, windowMs, kind }];
    if (ip56String) {
      result.push({ key: `ratelimit:${url}:${ip56String}`, limit: options.limit_v6_56, windowMs, kind });
    }
    if (ip48String) {
      result.push({ key: `ratelimit:${url}:${ip48String}`, limit: options.limit_v6_48, windowMs, kind });
    }
    return result;
  };

  const rateLimiter = async (req: express.Request, _res: express.Response) => enforceLimits(buckets(req));
  const peek = (req: express.Request) => peekLimits(buckets(req));
  return Object.assign(rateLimiter, { peek, buckets });
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
        throw new RateLimitError(await secondsUntilRoomInKey(redisKey, results[1], options.limit, options.windowMs, now), 'attempts');
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
 * like enforceLimits — and refuses with RATE_LIMIT_EXCEEDED (removing
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
        throw new RateLimitError(await secondsUntilRoomInKey(redisKey, results[3] - 1, options.limit, options.windowMs, now), 'attempts');
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
 * may go to one target address. Throws RateLimitError when the key's
 * bucket is full. `bucket` names the counter family; keys of different
 * families never collide. `.buckets(key)` hands the bucket to enforceLimits,
 * to be counted together with others.
 */
export function keyRateLimitHandler(options: { bucket: string; windowMs: number; limit: number; kind?: LimitKind }) {
  const buckets = (key: string): LimitBucket[] => [{
    key: `ratelimit:${options.bucket}:key:${key}`,
    limit: options.limit,
    windowMs: options.windowMs,
    kind: options.kind ?? 'attempts',
  }];
  const limiter = (key: string) => enforceLimits(buckets(key));
  return Object.assign(limiter, { buckets });
}
