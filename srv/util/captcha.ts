// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import redisManager from "../redis";
import axios from "./axios";
import { dockerSecret, realRandomHexString } from ".";

// altcha-lib is an ESM-only package; this backend compiles to CommonJS, so it
// is pulled in via dynamic import() (the only interop that works here). Its
// packaging trips node16's CJS/ESM type resolution, so it is loaded untyped and
// the two functions we use are wrapped with explicit signatures below.
type CreateChallengeFn = (options: {
  hmacKey: string;
  maxNumber?: number;
  expires?: Date;
}) => Promise<{ algorithm: string; challenge: string; maxnumber?: number; salt: string; signature: string }>;
type VerifySolutionFn = (payload: string, hmacKey: string, checkExpires?: boolean) => Promise<boolean>;

let altchaLibPromise: Promise<any> | undefined;
function loadAltchaLib(): Promise<{ createChallenge: CreateChallengeFn; verifySolution: VerifySolutionFn }> {
  if (!altchaLibPromise) {
    altchaLibPromise = import("altcha-lib").catch((e) => {
      altchaLibPromise = undefined;
      throw e;
    });
  }
  return altchaLibPromise;
}

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

// PoW difficulty. maxNumber caps how many hashes a client may need to try.
// The widget solves in parallel workers, so 500000 stays around a second on
// desktops and a few seconds on low-end mobile devices. Replay protection only
// blocks reusing a solved challenge — this cost is the sole brake on bulk
// registration, so don't lower it without reason. Tune via ALTCHA_MAX_NUMBER.
export const ALTCHA_MAX_NUMBER =
  Number.parseInt(process.env.ALTCHA_MAX_NUMBER || "", 10) || 500000;

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

export async function createCaptchaChallenge() {
  const [{ createChallenge }, hmacKey] = await Promise.all([loadAltchaLib(), getHmacKey()]);
  return createChallenge({
    hmacKey,
    maxNumber: ALTCHA_MAX_NUMBER,
    expires: new Date(Date.now() + CHALLENGE_TTL_MS),
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

async function verifyAltchaToken(token: string): Promise<boolean> {
  if (!token) {
    return false;
  }
  // Decode the widget payload (base64 JSON) to extract the challenge id used
  // for replay protection; verifySolution itself accepts the raw base64 string.
  let challengeId: string;
  try {
    const decoded = JSON.parse(Buffer.from(token, "base64").toString("utf-8"));
    if (!decoded || typeof decoded.challenge !== "string") {
      return false;
    }
    challengeId = decoded.challenge;
  } catch {
    return false;
  }
  const [{ verifySolution }, hmacKey] = await Promise.all([loadAltchaLib(), getHmacKey()]);
  const valid = await verifySolution(token, hmacKey);
  if (!valid) {
    return false;
  }
  // Replay protection: each solved challenge may only be redeemed once. The
  // challenge hash is unique per (salt, secret), so it doubles as a single-use
  // token id. SET NX returns null if the key already exists.
  await redisManager.isReady;
  const client = redisManager.getClient("data");
  const replayKey = `captcha:altcha:used:${challengeId}`;
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
