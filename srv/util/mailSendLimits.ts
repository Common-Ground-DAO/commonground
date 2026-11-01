// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { createHash, createHmac } from 'node:crypto';
import type express from 'express';
import ipRateLimitHandler, { enforceLimits, keyRateLimitHandler } from './rateLimit';
import { AUTH_LIMITS } from './authLimits';
import { dockerSecret } from '.';

// Send limits for the endpoints that make the server mail an address the
// caller chooses (docs/email-notifications, "Send limits"). Three dimensions,
// each a sliding window in Redis:
//   - per client IP (IPv4 address / IPv6 /64, with looser /56 and /48 caps),
//     against one client hammering the endpoint,
//   - per target address, against mail-bombing one inbox from many IPs,
//   - per account (requestEmailVerification only, which needs a login).
// The limits of a request are counted together (enforceLimits): a refused
// request counts in none of them, and the refusal names the longest wait.
// The numbers are in srv/util/authLimits.ts.
//
// The per-address limit of the login code is a trade-off: anyone who knows an
// address can use up its budget and so keep its owner from getting a code for
// a while. A short cooldown (1/min) with a higher hourly cap (10/h) keeps
// that window short while still capping the mail volume to one inbox.

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

const otpIpLimit = ipRateLimitHandler({ bucket: 'mail:otp:ip', kind: 'mail', ...AUTH_LIMITS.loginCodeMail.ip });
const otpTargetCooldown = keyRateLimitHandler({ bucket: 'mail:otp:to:min', kind: 'mail', ...AUTH_LIMITS.loginCodeMail.addressCooldown });
const otpTargetLimit = keyRateLimitHandler({ bucket: 'mail:otp:to', kind: 'mail', ...AUTH_LIMITS.loginCodeMail.address });

const verifyIpLimit = ipRateLimitHandler({ bucket: 'mail:verify:ip', kind: 'mail', ...AUTH_LIMITS.verificationMail.ip });
const verifyTargetLimit = keyRateLimitHandler({ bucket: 'mail:verify:to', kind: 'mail', ...AUTH_LIMITS.verificationMail.address });
const verifyAccountLimit = keyRateLimitHandler({ bucket: 'mail:verify:user', kind: 'mail', ...AUTH_LIMITS.verificationMail.account });

/** POST /User/sendOneTimePasswordForLogin: per IP; per address a cooldown and an hourly cap. */
export async function limitOneTimePasswordMail(request: express.Request, response: express.Response, address: string) {
  const key = mailTargetKey(address);
  await enforceLimits([...otpIpLimit.buckets(request), ...otpTargetCooldown.buckets(key), ...otpTargetLimit.buckets(key)]);
}

/** POST /User/requestEmailVerification: per IP, per address, per account. */
export async function limitVerificationMail(request: express.Request, response: express.Response, address: string, userId: string) {
  await enforceLimits([
    ...verifyIpLimit.buckets(request),
    ...verifyAccountLimit.buckets(userId),
    ...verifyTargetLimit.buckets(mailTargetKey(address)),
  ]);
}

const signupIpLimit = ipRateLimitHandler({ bucket: 'mail:signup:ip', kind: 'mail', ...AUTH_LIMITS.signupCodeMail.ip });
const signupTargetCooldown = keyRateLimitHandler({ bucket: 'mail:signup:to:min', kind: 'mail', ...AUTH_LIMITS.signupCodeMail.addressCooldown });
const signupTargetLimit = keyRateLimitHandler({ bucket: 'mail:signup:to', kind: 'mail', ...AUTH_LIMITS.signupCodeMail.address });

/** POST /User/requestSignupEmailCode: per IP; per address a cooldown and an hourly cap. */
export async function limitSignupCodeMail(request: express.Request, response: express.Response, address: string) {
  const key = mailTargetKey(address);
  await enforceLimits([...signupIpLimit.buckets(request), ...signupTargetCooldown.buckets(key), ...signupTargetLimit.buckets(key)]);
}
