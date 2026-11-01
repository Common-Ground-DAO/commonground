// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type express from "express";
import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import errors from "../common/errors";
import { EMAIL_CODE_GUESSES, EMAIL_CODE_LENGTH } from "../common/authInputRules";

/**
 * Email verification BEFORE an account exists (docs/auth-identity §6).
 *
 * `User/requestSignupEmailCode` mails an 8-digit code (CSPRNG) and keeps only
 * its hash (and a random id for the attempt budget in Redis) in the session, bound to the address it was sent to;
 * `User/verifySignupEmailCode` checks code and address and marks the session's
 * sign-up address as verified; `User/createUser` then creates the account
 * with exactly that address, already verified. A code expires after
 * SIGNUP_CODE_TTL_MS, allows SIGNUP_CODE_MAX_ATTEMPTS wrong guesses and is
 * single-use; requesting a new code (for any address) replaces the old state.
 * A code that expired or whose guesses are spent is dropped, but the address
 * and the captcha stay: a new code for it needs no new captcha.
 *
 * Captcha: `requestSignupEmailCode` checks the sign-up captcha before any
 * mail goes out and records `captchaAt` in the state (bound to the address).
 * A resend for the same address within SIGNUP_CAPTCHA_TTL_MS needs no new
 * captcha, and `createUser` with the verified address needs none either —
 * so the client never has to keep a captcha token alive across the steps.
 */

export const SIGNUP_CODE_TTL_MS = 15 * 60 * 1000;
// the guesses per code, shared with the web app (src/common/authInputRules.ts)
export const SIGNUP_CODE_MAX_ATTEMPTS = EMAIL_CODE_GUESSES;
/** how long a verified sign-up address stays usable for createUser */
export const SIGNUP_VERIFIED_TTL_MS = 60 * 60 * 1000;
/** how long a solved sign-up captcha covers resends and createUser */
export const SIGNUP_CAPTCHA_TTL_MS = 2 * 60 * 60 * 1000;

type Session = express.Request["session"];

export function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function codeHash(email: string, code: string) {
  return createHash("sha256").update(`${normalizeEmail(email)}\n${code}`).digest("hex");
}

export function generateSignupCode(): string {
  // uniform over 00000000-99999999 (CSPRNG), leading zeros kept
  return randomInt(0, 10 ** EMAIL_CODE_LENGTH).toString().padStart(EMAIL_CODE_LENGTH, "0");
}

/**
 * Whether the session's sign-up already passed the captcha for `email`
 * (recently): a resend of the code needs no new one.
 */
export function hasSignupCaptcha(session: Session, email: string, now = Date.now()): boolean {
  const state = session.signupEmail;
  return !!state
    && typeof state.captchaAt === "number"
    && now - state.captchaAt <= SIGNUP_CAPTCHA_TTL_MS
    && normalizeEmail(state.email) === normalizeEmail(email);
}

/**
 * Starts a new verification for `email`; returns the code to mail.
 * `captchaAt`: when the captcha for this sign-up was solved.
 */
export function startSignupEmailVerification(session: Session, email: string, now = Date.now(), captchaAt?: number): string {
  const code = generateSignupCode();
  session.signupEmail = {
    email: email.trim(),
    codeId: randomUUID(),
    codeHash: codeHash(email, code),
    expiresAt: now + SIGNUP_CODE_TTL_MS,
    attempts: 0,
    ...(captchaAt !== undefined ? { captchaAt } : {}),
  };
  return code;
}

/**
 * The address is taken: no code exists, but the state looks like it does
 * (a resend behaves the same, a code never matches).
 */
export function startSignupWithoutCode(session: Session, email: string, now = Date.now(), captchaAt?: number): void {
  session.signupEmail = {
    email: email.trim(),
    // an attempt budget like a real code has, so both behave the same
    codeId: randomUUID(),
    expiresAt: now + SIGNUP_CODE_TTL_MS,
    attempts: 0,
    ...(captchaAt !== undefined ? { captchaAt } : {}),
  };
}

/**
 * The code can no longer be used (expired, or its guesses are spent): the
 * address and the captcha stay, so "send a new code" needs no new captcha.
 */
function withoutCode(state: NonNullable<Session["signupEmail"]>): NonNullable<Session["signupEmail"]> {
  const { codeHash, ...rest } = state;
  return rest;
}

export function checkSignupEmailCode(session: Session, email: string, code: string, now = Date.now()): void {
  const state = session.signupEmail;
  if (!state || state.verifiedAt !== undefined || normalizeEmail(state.email) !== normalizeEmail(email)) {
    throw new Error(errors.server.VERIFY_EMAIL_INVALID_TOKEN);
  }
  // before the code check: an expired state answers the same with and
  // without a code (a taken address has none)
  if (state.expiresAt <= now) {
    session.signupEmail = withoutCode(state);
    throw new Error(errors.server.VERIFY_EMAIL_EXPIRED_TOKEN);
  }
  if (!state.codeHash) {
    throw new Error(errors.server.VERIFY_EMAIL_INVALID_TOKEN);
  }
  const expected = Buffer.from(state.codeHash, "hex");
  const actual = Buffer.from(codeHash(email, code), "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    const attempts = state.attempts + 1;
    session.signupEmail = attempts >= SIGNUP_CODE_MAX_ATTEMPTS
      ? withoutCode({ ...state, attempts })
      : { ...state, attempts };
    throw new Error(errors.server.VERIFY_EMAIL_INVALID_TOKEN);
  }
  session.signupEmail = {
    email: state.email,
    expiresAt: now + SIGNUP_VERIFIED_TTL_MS,
    attempts: state.attempts,
    verifiedAt: now,
    ...(state.captchaAt !== undefined ? { captchaAt: state.captchaAt } : {}),
  };
}

/**
 * Whether createUser may skip its captcha: the session holds a verified
 * sign-up address whose captcha was solved at requestSignupEmailCode.
 */
export function verifiedSignupPassedCaptcha(session: Session, now = Date.now()): boolean {
  const state = session.signupEmail;
  return getVerifiedSignupEmail(session, now) !== null
    && typeof state?.captchaAt === "number"
    && now - state.captchaAt <= SIGNUP_CAPTCHA_TTL_MS;
}

/** The session's verified sign-up address, or null. */
export function getVerifiedSignupEmail(session: Session, now = Date.now()): string | null {
  const state = session.signupEmail;
  if (!state || !state.verifiedAt || state.codeHash || state.expiresAt <= now) {
    return null;
  }
  return state.email;
}
