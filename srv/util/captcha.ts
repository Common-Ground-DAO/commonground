// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import redisManager from "../redis";
import axios from "./axios";
import { createHmac } from "crypto";
import { dockerSecret, realRandomHexString } from ".";
import { createChallenge, randomInt, verifySolution } from "altcha-lib";
import { deriveKey } from "altcha-lib/algorithms/pbkdf2";
import type { Challenge, Solution } from "altcha-lib/types";

// altcha-lib 2 ships a CommonJS build alongside the ESM one, so it is imported
// statically and with real types. (v1 was ESM-only and had to be pulled in via
// an untyped dynamic import() — see git history if that ever regresses.)

// Captcha provider abstraction. Historically the server only supported Google
// reCAPTCHA and silently disabled captcha entirely when no secret key was
// configured — leaving self-hosted instances without any registration spam
// protection. ALTCHA (a self-hosted, privacy-friendly proof-of-work captcha)
// is now the fail-closed default so that "no key configured" no longer means
// "no captcha".

export type CaptchaProvider = "altcha" | "recaptcha" | "off";

const RECAPTCHA_SECRET_KEY =
  dockerSecret("google_recaptcha_secret_key") || process.env.GOOGLE_RECAPTCHA_SECRET_KEY || "";

function resolveProvider(): CaptchaProvider {
  const explicit = (process.env.CAPTCHA_PROVIDER || "").trim().toLowerCase();
  if (explicit === "altcha" || explicit === "recaptcha" || explicit === "off") {
    return explicit;
  }
  if (explicit) {
    console.warn(`Unknown CAPTCHA_PROVIDER "${explicit}", falling back to auto-detection`);
  }
  // No explicit provider: keep the historical behaviour for instances that
  // ship a reCAPTCHA secret (e.g. app.cg), otherwise fail closed with ALTCHA.
  return RECAPTCHA_SECRET_KEY ? "recaptcha" : "altcha";
}

export const CAPTCHA_PROVIDER: CaptchaProvider = resolveProvider();

if (CAPTCHA_PROVIDER === "recaptcha" && !RECAPTCHA_SECRET_KEY) {
  console.error(
    "ERROR! CAPTCHA_PROVIDER=recaptcha but no reCAPTCHA secret key is configured — " +
    "every captcha verification will be rejected and nobody can register. " +
    "Set GOOGLE_RECAPTCHA_SECRET_KEY (or the google_recaptcha_secret_key docker " +
    "secret), or set CAPTCHA_PROVIDER=altcha to use the self-hosted captcha."
  );
}

if (CAPTCHA_PROVIDER === "off") {
  console.warn(
    "WARNING! CAPTCHA_PROVIDER=off — captcha verification is DISABLED. " +
    "Registration has no spam protection. Only use this for development."
  );
}

// PoW difficulty. ALTCHA's v2 proof-of-work replaced v1's "hash the salt with
// every number up to maxNumber" with a key-derivation search: the client
// derives a PBKDF2 key for counter 0, 1, 2, … until the derived key matches the
// prefix the server published, so the total work is roughly
// `counter × cost` PBKDF2/SHA-256 iterations.
//
// `cost` is the per-attempt iteration count, `counter` the answer the client
// has to find. The counter is drawn per challenge from
// [ALTCHA_COUNTER_MAX/2, ALTCHA_COUNTER_MAX] so the work is neither constant
// nor predictable from the challenge.
//
// The defaults were measured, not guessed: driving the real widget in Chrome
// (16 cores) it solves ~0.44 ms per counter step at cost 5000, so a counter of
// ~3000 lands just under a second — the same UX target the v1 `maxNumber` of
// 500000 was tuned for. altcha-lib's own suggested counter range (5000–10000)
// measured 2.7–4.2 s here, which would have meant a noticeably worse wait on
// phones. It is still far more work than v1 asked for: ~15M PBKDF2/SHA-256
// iterations expected, against v1's ~250k bare SHA-256 hashes.
//
// Replay protection only blocks reusing a solved challenge — this cost is the
// sole brake on bulk registration, so don't lower it without reason.
export const ALTCHA_COST =
  Number.parseInt(process.env.ALTCHA_COST || "", 10) || 5000;
export const ALTCHA_COUNTER_MAX =
  Number.parseInt(process.env.ALTCHA_COUNTER_MAX || "", 10) || 4000;

// `ALTCHA_MAX_NUMBER` tuned the v1 proof of work and has no v2 equivalent.
// Silently ignoring it would leave an operator who raised it believing the
// captcha is harder than it is.
if (process.env.ALTCHA_MAX_NUMBER) {
  console.warn(
    "ALTCHA_MAX_NUMBER is set but no longer used — it configured ALTCHA's v1 " +
    "proof of work. Tune the v2 difficulty with ALTCHA_COST and " +
    "ALTCHA_COUNTER_MAX instead (total work ≈ counter × cost PBKDF2 iterations)."
  );
}

// Challenges (and therefore their single-use replay markers) live for 10
// minutes — long enough for a user to fill in the registration form, short
// enough to keep the replay-protection key space small.
const CHALLENGE_TTL_MS = 10 * 60 * 1000;

let hmacKeyPromise: Promise<string> | undefined;

// HMAC secret used to sign/verify ALTCHA challenges. Precedence:
//   1. docker secret `altcha_hmac_key`
//   2. env `ALTCHA_HMAC_KEY`
//   3. a value generated once and shared via Redis (get-or-set), so every
//      instance and every restart agree on the same secret without any manual
//      configuration.
async function getHmacKey(): Promise<string> {
  const configured = dockerSecret("altcha_hmac_key") || process.env.ALTCHA_HMAC_KEY;
  if (configured) {
    return configured;
  }
  if (!hmacKeyPromise) {
    hmacKeyPromise = (async () => {
      await redisManager.isReady;
      const client = redisManager.getClient("data");
      const key = "captcha:altcha:hmackey";
      const generated = realRandomHexString(32);
      // SET NX is atomic: only the first instance to reach it wins, everyone
      // else reads the stored value below.
      await client.set(key, generated, { condition: 'NX' });
      const stored = await client.get(key);
      return stored || generated;
    })().catch((e) => {
      hmacKeyPromise = undefined;
      throw e;
    });
  }
  return hmacKeyPromise;
}

// ALTCHA v2 uses two independent HMAC secrets: one signs the challenge
// parameters, the other signs the derived key in deterministic mode. Both are
// derived from the single configured secret rather than reusing it twice, so
// the existing `ALTCHA_HMAC_KEY` / `altcha_hmac_key` configuration keeps
// working and neither purpose can be substituted for the other.
async function getHmacSecrets(): Promise<{ hmacSignatureSecret: string; hmacKeySignatureSecret: string }> {
  const master = await getHmacKey();
  const derive = (label: string) =>
    createHmac("sha256", master).update(`altcha:v2:${label}`).digest("hex");
  return {
    hmacSignatureSecret: derive("signature"),
    hmacKeySignatureSecret: derive("key-signature"),
  };
}

export async function createCaptchaChallenge(): Promise<Challenge> {
  const secrets = await getHmacSecrets();
  return createChallenge({
    algorithm: "PBKDF2/SHA-256",
    cost: ALTCHA_COST,
    // Deterministic mode: the server picks the answer up front and publishes a
    // prefix of its derived key, so the client's work is bounded by `counter`
    // instead of depending on how lucky it gets.
    // altcha-lib's signature is `randomInt(max, min = 1)` — max first.
    counter: randomInt(ALTCHA_COUNTER_MAX, Math.ceil(ALTCHA_COUNTER_MAX / 2)),
    deriveKey,
    expiresAt: new Date(Date.now() + CHALLENGE_TTL_MS),
    ...secrets,
  });
}

async function verifyRecaptchaToken(token: string): Promise<boolean> {
  if (!RECAPTCHA_SECRET_KEY) {
    console.error("CAPTCHA_PROVIDER=recaptcha but no reCAPTCHA secret key configured");
    return false;
  }
  const googleResponse = await axios.post(
    `https://www.google.com/recaptcha/api/siteverify?secret=${RECAPTCHA_SECRET_KEY}&response=${token}`
  );
  return googleResponse.data.success as boolean;
}

// The widget posts base64(JSON) of `{ challenge: { parameters, signature },
// solution: { counter, derivedKey, time } }`. v1 sent a flat object with a
// `challenge` *string*; anything of that shape is rejected here rather than
// half-parsed, so a stale widget fails closed. The widget's `test: true`
// payload (challenge and solution both null) is rejected by the same checks.
function decodeAltchaPayload(token: string): { challenge: Challenge; solution: Solution } | null {
  let decoded: unknown;
  try {
    decoded = JSON.parse(Buffer.from(token, "base64").toString("utf-8"));
  } catch {
    return null;
  }
  if (!decoded || typeof decoded !== "object") {
    return null;
  }
  const { challenge, solution } = decoded as { challenge?: unknown; solution?: unknown };
  if (!challenge || typeof challenge !== "object" || !solution || typeof solution !== "object") {
    return null;
  }
  const { parameters, signature } = challenge as { parameters?: unknown; signature?: unknown };
  if (!parameters || typeof parameters !== "object" || typeof signature !== "string") {
    return null;
  }
  const { counter, derivedKey } = solution as { counter?: unknown; derivedKey?: unknown };
  if (typeof counter !== "number" || typeof derivedKey !== "string") {
    return null;
  }
  return {
    challenge: challenge as Challenge,
    solution: solution as Solution,
  };
}

async function verifyAltchaToken(token: string): Promise<boolean> {
  if (!token) {
    return false;
  }
  const payload = decodeAltchaPayload(token);
  if (!payload) {
    return false;
  }
  const secrets = await getHmacSecrets();
  // Checks the challenge signature (so its parameters are ours and unmodified),
  // its expiry, and that the derived key really is the one this challenge asked
  // for — i.e. that the proof of work was done.
  const result = await verifySolution({
    challenge: payload.challenge,
    solution: payload.solution,
    deriveKey,
    ...secrets,
  });
  if (!result.verified) {
    return false;
  }
  // Replay protection: each solved challenge may only be redeemed once. The
  // signature is an HMAC over the challenge parameters, which carry a random
  // nonce and salt, so it is unique per challenge and — having just been
  // verified — unforgeable. SET NX returns null if the key already exists.
  await redisManager.isReady;
  const client = redisManager.getClient("data");
  const replayKey = `captcha:altcha:used:${payload.challenge.signature}`;
  const set = await client.set(replayKey, "1", {
    condition: 'NX',
    expiration: { type: 'PX', value: CHALLENGE_TTL_MS },
  });
  return set !== null;
}

// Replaces the old verifyRecaptchaToken: verifies a captcha token according to
// the configured provider. `off` accepts anything (explicit opt-out only).
export async function verifyCaptchaToken(token: string): Promise<boolean> {
  switch (CAPTCHA_PROVIDER) {
    case "off":
      return true;
    case "recaptcha":
      return verifyRecaptchaToken(token);
    case "altcha":
    default:
      return verifyAltchaToken(token);
  }
}
