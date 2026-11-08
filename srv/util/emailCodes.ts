// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { createHash, randomInt, randomUUID, timingSafeEqual } from "node:crypto";
import redisManager from "../redis";
import errors from "../common/errors";
import { normalizeEmail } from "./signupEmail";
import { EMAIL_CODE_GUESSES, EMAIL_CODE_LENGTH } from "../common/authInputRules";

/**
 * 8-digit codes mailed to an existing account (docs/auth-identity §5.5, §8):
 *
 * - `login`: the one-time code of the email login (User/sendOneTimePasswordForLogin
 *   → User/login {type:'verificationCode'}), valid LOGIN_CODE_TTL_MS;
 * - `reauth`: confirms a signed-in account action, valid LOGIN_CODE_TTL_MS;
 * - `verify`: confirms an address for the account (User/requestEmailVerification
 *   → User/verifyEmail), valid VERIFY_CODE_TTL_MS. The address only becomes the
 *   account's address once the code comes back.
 *
 * Each code is bound to its account, its purpose and the address it was sent
 * to: it only matches that address. One code per account and purpose (a new
 * one replaces the old one). Codes come from a CSPRNG, only a hash is kept
 * (in Valkey, with the expiry as TTL), a matching code is deleted in the same
 * step that accepts it, so it works once. Wrong guesses are limited per code
 * by the caller (`checkAttempt`, an atomic counter in Valkey).
 */

export type EmailCodePurpose = "login" | "verify" | "reauth";

export const LOGIN_CODE_TTL_MS = 15 * 60 * 1000;
export const VERIFY_CODE_TTL_MS = 24 * 60 * 60 * 1000;
// the guesses per code, shared with the web app (src/common/authInputRules.ts)
export const EMAIL_CODE_MAX_ATTEMPTS = EMAIL_CODE_GUESSES;

type StoredCode = {
  codeId: string;
  hash: string;
  email: string;
  expiresAt: number;
};

const codeKey = (purpose: EmailCodePurpose, userId: string) => `email-code:${purpose}:${userId}`;

function codeHash(purpose: EmailCodePurpose, userId: string, email: string, code: string) {
  return createHash("sha256").update(`${purpose}\n${userId}\n${normalizeEmail(email)}\n${code}`).digest("hex");
}

export function generateEmailCode(): string {
  // uniform over 00000000-99999999 (CSPRNG), leading zeros kept
  return randomInt(0, 10 ** EMAIL_CODE_LENGTH).toString().padStart(EMAIL_CODE_LENGTH, "0");
}

/** Issues a new code for `userId`, bound to `email`; returns the code to mail. */
export async function issueEmailCode(
  purpose: EmailCodePurpose,
  userId: string,
  email: string,
  now = Date.now(),
): Promise<string> {
  const ttlMs = purpose === "verify" ? VERIFY_CODE_TTL_MS : LOGIN_CODE_TTL_MS;
  const code = generateEmailCode();
  const stored: StoredCode = {
    codeId: randomUUID(),
    hash: codeHash(purpose, userId, email, code),
    email: email.trim(),
    expiresAt: now + ttlMs,
  };
  await redisManager.getClient("data").set(codeKey(purpose, userId), JSON.stringify(stored), {
    expiration: { type: "PX", value: ttlMs },
  });
  return code;
}

// deletes the key only if it still holds the code that was checked, so a
// newer code issued in the meantime survives and a code is accepted once
const DELETE_IF_UNCHANGED = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

/**
 * Checks `code` for `email` and uses it up. `checkAttempt(codeId)` runs
 * before the comparison and throws once the code's attempts are spent (for a
 * login code that becomes VERIFY_EMAIL_INVALID_TOKEN and the code is gone).
 * Returns the address the code was sent to.
 */
export async function consumeEmailCode(
  purpose: EmailCodePurpose,
  userId: string,
  email: string,
  code: string,
  checkAttempt: (codeId: string) => Promise<void>,
  now = Date.now(),
): Promise<{ email: string }> {
  const client = redisManager.getClient("data");
  const key = codeKey(purpose, userId);
  const raw = await client.get(key);
  if (!raw) {
    throw new Error(errors.server.VERIFY_EMAIL_INVALID_TOKEN);
  }
  let stored: StoredCode;
  try {
    stored = JSON.parse(raw);
  }
  catch {
    throw new Error(errors.server.VERIFY_EMAIL_INVALID_TOKEN);
  }
  // A login code must not tell whether one was sent to the address at all:
  // expired and exhausted login codes answer like a wrong code (and an
  // exhausted one is deleted). Verification codes belong to the signed-in
  // account and may say what went wrong.
  const silent = purpose !== "verify";
  if (!(stored.expiresAt > now)) {
    throw new Error(silent ? errors.server.VERIFY_EMAIL_INVALID_TOKEN : errors.server.VERIFY_EMAIL_EXPIRED_TOKEN);
  }
  try {
    await checkAttempt(stored.codeId);
  }
  catch (e) {
    if (silent && e instanceof Error && e.message === errors.server.RATE_LIMIT_EXCEEDED) {
      await client.eval(DELETE_IF_UNCHANGED, { keys: [key], arguments: [raw] });
      throw new Error(errors.server.VERIFY_EMAIL_INVALID_TOKEN);
    }
    throw e;
  }
  const expected = Buffer.from(stored.hash, "hex");
  const actual = Buffer.from(codeHash(purpose, userId, email, code), "hex");
  if (
    normalizeEmail(stored.email) !== normalizeEmail(email) ||
    expected.length !== actual.length ||
    !timingSafeEqual(expected, actual)
  ) {
    throw new Error(errors.server.VERIFY_EMAIL_INVALID_TOKEN);
  }
  const deleted = await client.eval(DELETE_IF_UNCHANGED, { keys: [key], arguments: [raw] });
  if (Number(deleted) !== 1) {
    // a concurrent request used it first
    throw new Error(errors.server.VERIFY_EMAIL_INVALID_TOKEN);
  }
  return { email: stored.email };
}

/** The address a pending `verify` code was sent to (null: none pending). */
export async function getPendingEmail(userId: string, now = Date.now()): Promise<string | null> {
  const raw = await redisManager.getClient("data").get(codeKey("verify", userId));
  if (!raw) {
    return null;
  }
  try {
    const stored: StoredCode = JSON.parse(raw);
    return stored.expiresAt > now ? stored.email : null;
  }
  catch {
    return null;
  }
}
