// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The password policy, shared by the server (Joi `common.Password`) and the
 * web app: at least PASSWORD_MIN_LENGTH characters, nothing else — no
 * composition rules, no blocklist. Existing shorter passwords still sign in;
 * the account then has to choose a new one (docs/auth-identity §5.4).
 */
export const PASSWORD_MIN_LENGTH = 8;

/** upper bound for request validation only (bcrypt reads the first 72 bytes) */
export const PASSWORD_MAX_LENGTH = 1024;

export function passwordMeetsPolicy(password: string): boolean {
  return password.length >= PASSWORD_MIN_LENGTH && password.length <= PASSWORD_MAX_LENGTH;
}
