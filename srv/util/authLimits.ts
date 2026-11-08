// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The throttles of sign-up, sign-in, email codes and transfer links in one
 * place (docs/auth-identity, "Limits"). The rule (decision 21 of the cg.box
 * roadmap): a person who mistypes, retries or shares a network with many
 * others (mobile carriers, companies, universities) never runs into a
 * limit; limits only stop volumes that look like abuse, and every refusal
 * tells how long to wait (RateLimitError, srv/util/rateLimitError.ts).
 *
 * Per-IP limits count every attempt and are generous for that reason. Login
 * failure budgets count failures only (a successful sign-in never uses them
 * up) and are kept per sign-in identifier AND client network, so a third
 * party elsewhere cannot lock a user out; a much larger budget per
 * identifier across all networks stops distributed guessing. They are keyed
 * by the identifier as typed (normalized), never by the account it resolves
 * to: whether a username and an address belong to the same account must not
 * show in when a limit is reached. Guesses per issued code are bounded
 * separately (EMAIL_CODE_MAX_ATTEMPTS, SIGNUP_CODE_MAX_ATTEMPTS).
 */

import { EMAIL_CODE_RESEND_SECONDS } from '../common/authInputRules';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** IPv4 address / IPv6 /64, /56 and /48 (srv/util/rateLimit.ts) */
const perIp = (limit: number) => ({ limit_v4_v6_64: limit, limit_v6_56: limit * 3, limit_v6_48: limit * 6 });

const DEFAULTS = {
  /** User/createUser: accounts created per client network */
  createUser: {
    hour: { windowMs: HOUR, ...perIp(20) },
    day: { windowMs: DAY, ...perIp(50) },
  },
  passwordLogin: {
    /** attempts per client IP */
    ip: { windowMs: 15 * MINUTE, ...perIp(60) },
    /** failed attempts per identifier (as typed) from one network (IPv4 /24, IPv6 /56) */
    identifierFailuresPerNetwork: { windowMs: 15 * MINUTE, limit: 10 },
    /** failed attempts per identifier from all networks: the backstop against distributed guessing */
    identifierFailures: { windowMs: HOUR, limit: 100 },
  },
  codeLogin: {
    /** attempts per client IP */
    ip: { windowMs: 15 * MINUTE, ...perIp(60) },
    /** failed guesses per address from one network (IPv4 /24, IPv6 /56) and hour */
    identifierFailuresPerNetwork: { windowMs: HOUR, limit: 10 },
    /** failed guesses per address from all networks and hour */
    identifierFailures: { windowMs: HOUR, limit: 30 },
  },
  /**
   * Mails to an address the caller chooses (docs/email-notifications, "Send
   * limits"): per client IP against one client hammering the endpoint, per
   * target address against mail-bombing one inbox from many IPs. The
   * per-address cooldown is what the web app's "send again" countdown shows.
   */
  loginCodeMail: {
    ip: { windowMs: HOUR, ...perIp(30) },
    addressCooldown: { windowMs: EMAIL_CODE_RESEND_SECONDS * SECOND, limit: 1 },
    address: { windowMs: HOUR, limit: 10 },
  },
  signupCodeMail: {
    ip: { windowMs: HOUR, ...perIp(40) },
    addressCooldown: { windowMs: EMAIL_CODE_RESEND_SECONDS * SECOND, limit: 1 },
    address: { windowMs: HOUR, limit: 5 },
  },
  /** User/requestEmailVerification (signed in) */
  verificationMail: {
    ip: { windowMs: HOUR, ...perIp(30) },
    address: { windowMs: HOUR, limit: 5 },
    account: { windowMs: HOUR, limit: 5 },
  },
  passkey: {
    /** registration ceremonies while logged out (sign-up): options + verification count each */
    signupRegistration: { windowMs: HOUR, ...perIp(60) },
    /** login options: fetched on every view of the login form (passkey autofill) */
    loginOptions: { windowMs: HOUR, ...perIp(300) },
  },
  reauthenticate: {
    ip: { windowMs: 15 * MINUTE, ...perIp(30) },
    user: { windowMs: 15 * MINUTE, limit: 10 },
  },
  /** User/verifyCaptcha (signed in, raises the trust score): solved captchas per client network */
  verifyCaptcha: {
    ip: { windowMs: DAY, limit_v4_v6_64: 3, limit_v6_56: 10, limit_v6_48: 20 },
  },
  transfer: {
    /** links minted per user */
    createPerUser: { windowMs: HOUR, limit: 10 },
    /** preview + redemption attempts per client IP */
    ip: { windowMs: 15 * MINUTE, ...perIp(120) },
    /** failed previews/redemptions per client IP, checked before the lookup */
    ipFailures: { windowMs: 15 * MINUTE, limit: 20 },
    /** instance-wide failures per hour before a warning is logged (once per window) */
    alarm: { windowMs: HOUR, limit: 100 },
  },
  isEmailAvailable: {
    ip: { windowMs: HOUR, ...perIp(60) },
  },
  /**
   * Endpoints that store something for a visitor who is not signed in (and
   * so may start a session). A page load makes one device-login challenge.
   */
  preLogin: {
    /** User/getSignableSecret calls that start a new session (the request had none) */
    newChallengeSession: { windowMs: HOUR, ...perIp(600) },
    /** signed challenges checked: User/prepareWalletAction, Lukso/PrepareLuksoAction, Accounts/Farcaster/verifyLogin (each) */
    signatureCheck: { windowMs: HOUR, ...perIp(300) },
    /** X sign-in redirects (Twitter/startLogin) */
    xRedirect: { windowMs: HOUR, ...perIp(120) },
  },
};

type Limit = { windowMs: number; limit?: number; limit_v4_v6_64?: number; limit_v6_56?: number; limit_v6_48?: number };

/**
 * Test hook: CG_TEST_AUTH_LIMITS='{"createUser.hour": 1, ...}' lowers single
 * limits, so a test instance can show every limit message without hundreds
 * of requests (the e2e instance passes E2E_AUTH_LIMITS through). A value can
 * only lower a limit, never raise it; for per-IP limits it sets the IPv4 /
 * IPv6-/64 value (the wider prefixes scale with it). Unknown names and
 * malformed values stop the process: a typo must not go unnoticed.
 */
export function applyLimitOverrides<T extends Record<string, Record<string, Limit>>>(limits: T, raw: string | undefined): T {
  if (!raw || !raw.trim()) {
    return limits;
  }
  const overrides = JSON.parse(raw) as Record<string, unknown>;
  const result = JSON.parse(JSON.stringify(limits)) as T;
  for (const [name, value] of Object.entries(overrides)) {
    const [section, entry] = name.split('.');
    const limit = result[section]?.[entry] as Limit | undefined;
    if (!limit || typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new Error(`CG_TEST_AUTH_LIMITS: "${name}": ${JSON.stringify(value)} is not a known limit and a whole number >= 1`);
    }
    if (limit.limit !== undefined) {
      limit.limit = Math.min(limit.limit, value);
    }
    else {
      const factor = value / limit.limit_v4_v6_64!;
      if (factor < 1) {
        limit.limit_v4_v6_64 = value;
        limit.limit_v6_56 = Math.max(value, Math.floor(limit.limit_v6_56! * factor));
        limit.limit_v6_48 = Math.max(value, Math.floor(limit.limit_v6_48! * factor));
      }
    }
  }
  console.warn(`[auth limits] lowered for testing (CG_TEST_AUTH_LIMITS): ${Object.keys(overrides).join(', ')}`);
  return result;
}

export const AUTH_LIMITS = applyLimitOverrides(DEFAULTS, process.env.CG_TEST_AUTH_LIMITS);

/** the defaults, before any test override (unit tests, docs) */
export const AUTH_LIMIT_DEFAULTS = DEFAULTS;
