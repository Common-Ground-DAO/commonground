// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Input rules of sign-up and sign-in, shared by the server (Joi,
 * srv/validators) and the web app, which checks them in the form before
 * anything is sent (docs/auth-identity, "Limits"). The password policy has
 * its own module (passwordPolicy.ts).
 */

/** the CG profile name, which is also the username: 3-30 letters, digits, - and _ */
export const PROFILE_NAME_PATTERN = /^[a-z0-9_-]{3,30}$/i;
export const PROFILE_NAME_RULE = "Use 3-30 characters: letters, numbers, - and _.";

/** a mailed 8-digit code (sign-up, login, email confirmation), leading zeros included */
export const EMAIL_CODE_LENGTH = 8;
export const EMAIL_CODE_PATTERN = /^[0-9]{8}$/;
/** wrong guesses a code allows before it stops working (a new code is needed) */
export const EMAIL_CODE_GUESSES = 5;

/**
 * The same address gets at most one code per this many seconds (sign-up and
 * login codes, srv/util/authLimits.ts): the "send again" countdown.
 */
export const EMAIL_CODE_RESEND_SECONDS = 60;

/** spaces and dashes people copy along with a code ("123 456") are dropped */
export function normalizeEmailCode(value: string): string {
  return value.replace(/[\s-]+/g, '');
}
