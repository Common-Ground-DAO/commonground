// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { createHash, createHmac } from 'node:crypto';
import type express from 'express';
import ipRateLimitHandler, { keyRateLimitHandler } from './rateLimit';
import { dockerSecret } from '.';

// Send limits for the endpoints that make the server mail an address the
// caller chooses (docs/email-notifications, "Send limits"). Three dimensions,
// each a sliding window in Redis:
//   - per client IP (IPv4 address / IPv6 /64, with looser /56 and /48 caps),
//     against one client hammering the endpoint,
//   - per target address, against mail-bombing one inbox from many IPs,
//   - per account (requestEmailVerification only, which needs a login).
// Every check of a request counts, even when a later one rejects it.
//
// The per-address limit of the login code is a trade-off: anyone who knows an
// address can use up its budget and so keep its owner from getting a code for
// a while. A short cooldown (1/min) with a higher hourly cap (10/h) keeps
// that window short while still capping the mail volume to one inbox.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

const KEY_LABEL = 'cg-mail-send-limit-v1';
let addressKey: Buffer | null | undefined;

/**
 * Redis key part for a target address: an HMAC with a key derived from the
 * session secret (like the unsubscribe key), so the keys can't be matched
 * against a list of known addresses. Never stored in clear.
 */
export function mailTargetKey(address: string): string {
  if (addressKey === undefined) {
    const secret = dockerSecret('redis_secret') || process.env.REDIS_SECRET;
    addressKey = secret ? createHmac('sha256', secret).update(KEY_LABEL).digest() : null;
  }
  const normalized = address.trim().toLowerCase();
  return addressKey
    ? createHmac('sha256', addressKey).update(normalized).digest('base64url')
    // no session secret (a misconfigured dev setup): plain hash, still no clear text
    : createHash('sha256').update(normalized).digest('base64url');
}

const otpIpLimit = ipRateLimitHandler({
  bucket: 'mail:otp:ip',
  windowMs: HOUR,
  limit_v4_v6_64: 10,
  limit_v6_56: 30,
  limit_v6_48: 60,
});
const otpTargetCooldown = keyRateLimitHandler({ bucket: 'mail:otp:to:min', windowMs: MINUTE, limit: 1 });
const otpTargetLimit = keyRateLimitHandler({ bucket: 'mail:otp:to', windowMs: HOUR, limit: 10 });

const verifyIpLimit = ipRateLimitHandler({
  bucket: 'mail:verify:ip',
  windowMs: HOUR,
  limit_v4_v6_64: 10,
  limit_v6_56: 30,
  limit_v6_48: 60,
});
const verifyTargetLimit = keyRateLimitHandler({ bucket: 'mail:verify:to', windowMs: HOUR, limit: 5 });
const verifyAccountLimit = keyRateLimitHandler({ bucket: 'mail:verify:user', windowMs: HOUR, limit: 5 });

/** POST /User/sendOneTimePasswordForLogin: 10/h per IP; per address 1/min and 10/h. */
export async function limitOneTimePasswordMail(request: express.Request, response: express.Response, address: string) {
  await otpIpLimit(request, response);
  const key = mailTargetKey(address);
  await otpTargetCooldown(key);
  await otpTargetLimit(key);
}

/** POST /User/requestEmailVerification: 10/h per IP, 5/h per address, 5/h per account. */
export async function limitVerificationMail(request: express.Request, response: express.Response, address: string, userId: string) {
  await verifyIpLimit(request, response);
  await verifyAccountLimit(userId);
  await verifyTargetLimit(mailTargetKey(address));
}

const signupIpLimit = ipRateLimitHandler({
  bucket: 'mail:signup:ip',
  windowMs: HOUR,
  limit_v4_v6_64: 10,
  limit_v6_56: 30,
  limit_v6_48: 60,
});
const signupTargetCooldown = keyRateLimitHandler({ bucket: 'mail:signup:to:min', windowMs: MINUTE, limit: 1 });
const signupTargetLimit = keyRateLimitHandler({ bucket: 'mail:signup:to', windowMs: HOUR, limit: 5 });

/** POST /User/requestSignupEmailCode: 10/h per IP; per address 1/min and 5/h. */
export async function limitSignupCodeMail(request: express.Request, response: express.Response, address: string) {
  await signupIpLimit(request, response);
  const key = mailTargetKey(address);
  await signupTargetCooldown(key);
  await signupTargetLimit(key);
}
