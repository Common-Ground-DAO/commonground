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

export default function ipRateLimitHandler(options: {
  windowMs: number;
  limit_v4_v6_64: number;
  limit_v6_56: number;
  limit_v6_48: number;
}) {
  const rateLimiter = async (req: express.Request, res: express.Response) => {
    const url = req.originalUrl;
    const { ipString, ip56String, ip48String } = extractIpFromRequest(req);

    const now = Date.now();
    let promises: Promise<boolean>[] = [];
    function addPromise(key: string, limit: number) {
      const randVal = `${now}:${Math.random().toFixed(4)}`;
      promises.push(
        redisClient
          .multi()
          .zAdd(key, { value: randVal, score: now })
          .expire(key, Math.floor(options.windowMs / 1000))
          .zRemRangeByScore(key, 0, now - options.windowMs)
          .zCount(key, now - options.windowMs, now)
          .exec()
          .then((results) => {
            // console.log("RATE LIMIT RESULTS", results, limit)
            const count = (results[3] as number);
            if (count <= limit) {
              return true;
            }
            else {
              return redisClient.zRem(key, randVal).then(() => false);
            }
          })
      );
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