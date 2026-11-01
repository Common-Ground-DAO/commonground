// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The throttles of sign-in, email codes and transfer links in one place
 * (docs/auth-identity §5.4, §5.5, §11). Per-IP limits count every attempt and
 * are generous, because many users may share one address (mobile carriers,
 * companies) — especially on the day an instance moves. Login failure
 * budgets count failures only (a successful sign-in never uses them up) and
 * are kept per sign-in identifier AND client network, so a third party
 * elsewhere cannot lock a user out; a much larger budget per identifier
 * across all networks stops distributed guessing. They are keyed by the
 * identifier as typed (normalized), never by the account it resolves to:
 * whether a username and an address belong to the same account must not
 * show in when a limit is reached.
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** IPv4 address / IPv6 /64, /56 and /48 (srv/util/rateLimit.ts) */
const perIp = (limit: number) => ({ limit_v4_v6_64: limit, limit_v6_56: limit * 3, limit_v6_48: limit * 6 });

export const AUTH_LIMITS = {
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
    /** failed guesses per address from one network (IPv4 /24, IPv6 /56) and day */
    identifierFailuresPerNetwork: { windowMs: DAY, limit: 30 },
    /** failed guesses per address from all networks and day */
    identifierFailures: { windowMs: DAY, limit: 200 },
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
    ip: { windowMs: HOUR, ...perIp(30) },
  },
} as const;
