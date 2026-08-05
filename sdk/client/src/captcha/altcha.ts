/**
 * Native ALTCHA v2 proof-of-work solver (PBKDF2 counter search).
 *
 * Contract: GET /api/v2/Captcha/challenge (srv/api/captcha.ts) returns an
 * altcha-lib v2 challenge `{parameters, signature}`; the registration token
 * (`recaptchaToken` field) is `base64(JSON({challenge, solution}))` verified
 * by srv/util/captcha.ts verifyAltchaPayload → altcha-lib verifySolution.
 * Solved challenges are single-use (Redis SET NX on the signature) and expire
 * at `parameters.expiresAt` (unix seconds, 10 min TTL).
 *
 * The search: password = nonce-bytes ‖ uint32-BE(counter); PBKDF2(password,
 * salt-bytes, cost iterations, keyLength bytes, SHA-256); a counter solves
 * the challenge when the derived key starts with the signed keyPrefix.
 * Implemented against node:crypto only — no altcha-lib dependency.
 */

import { pbkdf2 } from "node:crypto";
import { promisify } from "node:util";
import type { HttpTransport } from "../transport/http.js";

const pbkdf2Async = promisify(pbkdf2);

export interface AltchaChallengeParameters {
  /** e.g. "PBKDF2/SHA-256" */
  algorithm: string;
  /** hex nonce; solver password = nonce bytes + counter */
  nonce: string;
  /** hex salt for the KDF */
  salt: string;
  /** KDF iteration count */
  cost: number;
  /** derived key length in bytes */
  keyLength: number;
  /** hex prefix the derived key must start with */
  keyPrefix: string;
  /** unix seconds */
  expiresAt?: number;
  [extra: string]: unknown;
}

export interface AltchaChallenge {
  parameters: AltchaChallengeParameters;
  /** HMAC over the canonical parameters — must be echoed back untouched */
  signature: string;
}

export interface AltchaSolution {
  counter: number;
  /** full derived key, hex */
  derivedKey: string;
  /** solve duration in ms (informational) */
  time: number;
}

function hexToBuffer(hex: string): Buffer {
  return Buffer.from(hex, "hex");
}

function digestFor(algorithm: string): string {
  switch (algorithm) {
    case "PBKDF2/SHA-512":
      return "sha512";
    case "PBKDF2/SHA-384":
      return "sha384";
    case "PBKDF2/SHA-256":
      return "sha256";
    default:
      throw new Error(`unsupported ALTCHA algorithm: ${algorithm}`);
  }
}

export interface SolveOptions {
  /** Abort after this many ms (default 90s, matches altcha-lib). */
  timeoutMs?: number;
}

/**
 * Brute-force the counter until the derived key matches the signed prefix.
 * Returns null on timeout (a fresh challenge should then be fetched).
 */
export async function solveAltchaChallenge(
  challenge: AltchaChallenge,
  options: SolveOptions = {},
): Promise<AltchaSolution | null> {
  const { nonce, salt, cost, keyLength, keyPrefix, algorithm } = challenge.parameters;
  const digest = digestFor(algorithm);
  const nonceBuf = hexToBuffer(nonce);
  const saltBuf = hexToBuffer(salt);
  const prefixBuf = hexToBuffer(keyPrefix);
  const timeoutMs = options.timeoutMs ?? 90_000;

  const password = Buffer.alloc(nonceBuf.length + 4);
  nonceBuf.copy(password, 0);

  const start = performance.now();
  for (let counter = 0; ; counter++) {
    if (counter % 10 === 0 && performance.now() - start > timeoutMs) {
      return null;
    }
    password.writeUInt32BE(counter, nonceBuf.length);
    const derivedKey = await pbkdf2Async(password, saltBuf, cost, keyLength, digest);
    if (derivedKey.subarray(0, prefixBuf.length).equals(prefixBuf)) {
      return {
        counter,
        derivedKey: derivedKey.toString("hex"),
        time: Math.floor((performance.now() - start) * 10) / 10,
      };
    }
  }
}

/** Encode challenge + solution as the token `createUser` expects. */
export function buildCaptchaToken(challenge: AltchaChallenge, solution: AltchaSolution): string {
  return Buffer.from(JSON.stringify({ challenge, solution })).toString("base64");
}

/** GET /Captcha/config — the provider the server actually verifies against. */
export async function fetchCaptchaConfig(
  transport: HttpTransport,
): Promise<{ provider: "altcha" | "recaptcha" | "off" }> {
  return transport.getJson("Captcha/config");
}

/** GET /Captcha/challenge — a fresh ALTCHA v2 challenge (404 unless provider=altcha). */
export async function fetchAltchaChallenge(transport: HttpTransport): Promise<AltchaChallenge> {
  const challenge = await transport.getJson<AltchaChallenge>("Captcha/challenge");
  if (!challenge?.parameters?.keyPrefix || !challenge.signature) {
    throw new Error("Captcha/challenge did not return an ALTCHA v2 challenge");
  }
  return challenge;
}

/**
 * The full dance: fetch a challenge, solve it, return the single-use token.
 * Throws on timeout — callers registering a user should just retry once.
 */
export async function obtainCaptchaToken(
  transport: HttpTransport,
  options: SolveOptions = {},
): Promise<string> {
  const challenge = await fetchAltchaChallenge(transport);
  const solution = await solveAltchaChallenge(challenge, options);
  if (!solution) {
    throw new Error("ALTCHA solve timed out");
  }
  return buildCaptchaToken(challenge, solution);
}
