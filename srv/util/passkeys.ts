// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type express from "express";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";
import {
  decodeClientDataJSON,
  isoBase64URL,
  parseAuthenticatorData,
} from "@simplewebauthn/server/helpers";
import { randomBytes } from "node:crypto";
import errors from "../common/errors";
import redisManager from "../redis";
import passkeyHelper, { type NewPasskey, type PasskeyRow } from "../repositories/passkeys";
import type { RpConfig } from "./passkeyConfig";

/**
 * Shared WebAuthn core (docs/auth-identity §7). Both the main-origin `Passkey`
 * router and the legacy `CgId` router run their ceremonies through these
 * functions with their own `RpConfig`.
 *
 * Ceremony state is a small map of challenges in the session:
 *   session.webauthnChallenges[challenge] = { purpose, rpId, userId, ... }
 * - at most MAX_CHALLENGES entries (the oldest is evicted), so two tabs can
 *   run ceremonies side by side without overwriting each other;
 * - every entry expires (CHALLENGE_TTL_MS, AUTOFILL_CHALLENGE_TTL_MS for the
 *   long-lived conditional-UI request);
 * - a challenge is removed from the session BEFORE its response is verified,
 *   whatever the outcome, and additionally marked as used in Redis, so it can
 *   never be answered twice — not even by two concurrent requests that both
 *   loaded the session before either saved it.
 */

export type ChallengePurpose = "register" | "login" | "stepup";

export type ChallengeEntry = {
  purpose: ChallengePurpose;
  rpId: string;
  /** session user the ceremony was started for (null: anonymous) */
  userId: string | null;
  /** registration only: the WebAuthn user handle (base64url) the options carried */
  userHandle?: string;
  createdAt: number;
  expiresAt: number;
};

export type PendingPasskey = NewPasskey & { expiresAt: number };

export const MAX_CHALLENGES = 5;
export const CHALLENGE_TTL_MS = 5 * 60 * 1000;
export const AUTOFILL_CHALLENGE_TTL_MS = 10 * 60 * 1000;
/** how long a passkey registered during sign-up waits in the session for createUser */
export const PENDING_PASSKEY_TTL_MS = 15 * 60 * 1000;
export const SUPPORTED_ALGORITHM_IDS = [-8, -7, -257];

type Session = express.Request["session"];

export function storeChallenge(session: Session, challenge: string, entry: Omit<ChallengeEntry, "createdAt" | "expiresAt">, ttlMs: number, now = Date.now()) {
  const map: Record<string, ChallengeEntry> = { ...(session.webauthnChallenges || {}) };
  for (const [key, value] of Object.entries(map)) {
    if (!value || value.expiresAt <= now) {
      delete map[key];
    }
  }
  map[challenge] = { ...entry, createdAt: now, expiresAt: now + ttlMs };
  const keys = Object.keys(map).sort((a, b) => map[a].createdAt - map[b].createdAt);
  while (keys.length > MAX_CHALLENGES) {
    delete map[keys.shift()!];
  }
  session.webauthnChallenges = map;
}

/** Removes the challenge from the session and returns its entry if it was still valid. */
export function takeChallenge(session: Session, challenge: string, now = Date.now()): ChallengeEntry | null {
  const map = session.webauthnChallenges;
  if (!map || typeof challenge !== "string" || !Object.prototype.hasOwnProperty.call(map, challenge)) {
    return null;
  }
  const entry = map[challenge];
  const rest = { ...map };
  delete rest[challenge];
  session.webauthnChallenges = rest;
  if (!entry || entry.expiresAt <= now) {
    return null;
  }
  return entry;
}

/** Atomic single-use marker across requests (SET NX). */
export async function markChallengeUsed(challenge: string, ttlMs: number): Promise<boolean> {
  const result = await redisManager.getClient("data").set(
    `webauthn:challenge-used:${challenge}`,
    "1",
    { condition: "NX", expiration: { type: "PX", value: Math.max(1000, ttlMs) } },
  );
  return result === "OK";
}

function clientChallenge(clientDataJSON: string): { challenge: string; origin: string } {
  try {
    const clientData = decodeClientDataJSON(clientDataJSON);
    if (typeof clientData.challenge !== "string" || typeof clientData.origin !== "string") {
      throw new Error("malformed clientDataJSON");
    }
    return { challenge: clientData.challenge, origin: clientData.origin };
  }
  catch {
    throw new Error(errors.server.INVALID_REQUEST);
  }
}

async function consumeChallenge(
  session: Session,
  clientDataJSON: string,
  expected: { purpose: ChallengePurpose; rpId: string; userId: string | null },
): Promise<{ challenge: string; entry: ChallengeEntry }> {
  const { challenge } = clientChallenge(clientDataJSON);
  const entry = takeChallenge(session, challenge);
  if (
    !entry ||
    entry.purpose !== expected.purpose ||
    entry.rpId !== expected.rpId ||
    entry.userId !== expected.userId
  ) {
    throw new Error(errors.server.INVALID_SECRET);
  }
  if (!(await markChallengeUsed(challenge, entry.expiresAt - Date.now()))) {
    throw new Error(errors.server.INVALID_SECRET);
  }
  return { challenge, entry };
}

export function newUserHandle(): string {
  return isoBase64URL.fromBuffer(new Uint8Array(randomBytes(32)));
}

// ---- registration -----------------------------------------------------------

export async function createRegistrationOptions(rp: RpConfig, session: Session, options: {
  userId: string | null;
  userHandle: string;
  userName: string;
  userDisplayName: string;
  excludeCredentials: { id: string; transports?: AuthenticatorTransportFuture[] }[];
}): Promise<PublicKeyCredentialCreationOptionsJSON> {
  const result = await generateRegistrationOptions({
    rpName: rp.rpName,
    rpID: rp.rpId,
    userID: isoBase64URL.toBuffer(options.userHandle),
    userName: options.userName,
    userDisplayName: options.userDisplayName,
    timeout: CHALLENGE_TTL_MS,
    attestationType: "none",
    excludeCredentials: options.excludeCredentials,
    authenticatorSelection: {
      residentKey: "required",
      requireResidentKey: true,
      userVerification: "required",
    },
    supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
  });
  storeChallenge(session, result.challenge, {
    purpose: "register",
    rpId: rp.rpId,
    userId: options.userId,
    userHandle: options.userHandle,
  }, CHALLENGE_TTL_MS);
  return result;
}

export async function verifyRegistration(rp: RpConfig, session: Session, response: RegistrationResponseJSON, options: {
  userId: string | null;
  name: string | null;
}): Promise<NewPasskey> {
  const { challenge, entry } = await consumeChallenge(session, response.response.clientDataJSON, {
    purpose: "register",
    rpId: rp.rpId,
    userId: options.userId,
  });
  if (!entry.userHandle) {
    throw new Error(errors.server.INVALID_SECRET);
  }
  let result: Awaited<ReturnType<typeof verifyRegistrationResponse>>;
  try {
    result = await verifyRegistrationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpId,
      requireUserPresence: true,
      requireUserVerification: true,
      supportedAlgorithmIDs: SUPPORTED_ALGORITHM_IDS,
    });
  }
  catch (e) {
    console.warn(`Passkey registration rejected (rp ${rp.rpId}): ${e instanceof Error ? e.message : String(e)}`);
    throw new Error(errors.server.INVALID_SIGNATURE);
  }
  if (!result.verified || !result.registrationInfo) {
    throw new Error(errors.server.INVALID_SIGNATURE);
  }
  const { credential, credentialDeviceType, credentialBackedUp, origin } = result.registrationInfo;
  return {
    rpId: rp.rpId,
    origin,
    name: options.name,
    webAuthnUserID: entry.userHandle,
    credentialID: credential.id,
    credentialPublicKeyBase64: Buffer.from(credential.publicKey).toString("base64"),
    credentialDeviceType,
    credentialBackedUp,
    transports: response.response.transports,
    counter: credential.counter,
  };
}

// ---- authentication ---------------------------------------------------------

export async function createAuthenticationOptions(rp: RpConfig, session: Session, options: {
  purpose: "login" | "stepup";
  userId: string | null;
  allowCredentials?: { id: string; transports?: AuthenticatorTransportFuture[] }[];
  conditional?: boolean;
}): Promise<PublicKeyCredentialRequestOptionsJSON> {
  const ttl = options.conditional ? AUTOFILL_CHALLENGE_TTL_MS : CHALLENGE_TTL_MS;
  const result = await generateAuthenticationOptions({
    rpID: rp.rpId,
    allowCredentials: options.allowCredentials || [],
    userVerification: "required",
    timeout: ttl,
  });
  storeChallenge(session, result.challenge, {
    purpose: options.purpose,
    rpId: rp.rpId,
    userId: options.userId,
  }, ttl);
  return result;
}

/**
 * Verifies an assertion and records the use (counter, lastUsedAt). Returns the
 * credential row; callers decide what its owner may do (a row without owner
 * is returned too — only the legacy flow has such rows).
 */
export async function verifyAuthentication(rp: RpConfig, session: Session, response: AuthenticationResponseJSON, options: {
  purpose: "login" | "stepup";
  userId: string | null;
}): Promise<PasskeyRow> {
  const { challenge } = await consumeChallenge(session, response.response.clientDataJSON, {
    purpose: options.purpose,
    rpId: rp.rpId,
    userId: options.userId,
  });
  if (response.id !== response.rawId) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  const passkey = await passkeyHelper.getByCredentialId(rp.rpId, response.id);
  if (!passkey) {
    throw new Error(errors.server.NOT_FOUND);
  }
  if (passkey.deletedAt !== null) {
    throw new Error(errors.server.DELETED);
  }
  if (options.purpose === "stepup" && passkey.userId !== options.userId) {
    throw new Error(errors.server.NOT_ALLOWED);
  }
  const { userHandle } = response.response;
  if (userHandle !== undefined && userHandle !== passkey.data.webAuthnUserID) {
    throw new Error(errors.server.INVALID_SIGNATURE);
  }

  const storedCounter = Number(passkey.counter) || 0;
  let receivedCounter: number;
  try {
    receivedCounter = parseAuthenticatorData(isoBase64URL.toBuffer(response.response.authenticatorData)).counter;
  }
  catch {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  if ((storedCounter > 0 || receivedCounter > 0) && receivedCounter <= storedCounter) {
    // a cloned authenticator, or a replayed assertion: never accepted, and
    // worth an operator's attention
    console.warn(`[security] passkey signature counter did not increase: passkey ${passkey.id}, user ${passkey.userId}, stored ${storedCounter}, received ${receivedCounter}`);
    throw new Error(errors.server.INVALID_SIGNATURE);
  }

  let result: Awaited<ReturnType<typeof verifyAuthenticationResponse>>;
  try {
    result = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge,
      expectedOrigin: rp.origins,
      expectedRPID: rp.rpId,
      requireUserVerification: true,
      credential: {
        id: passkey.data.credentialID,
        publicKey: new Uint8Array(Buffer.from(passkey.data.credentialPublicKeyBase64, "base64")),
        transports: passkey.data.transports,
        counter: storedCounter,
      },
    });
  }
  catch (e) {
    console.warn(`Passkey assertion rejected (rp ${rp.rpId}, passkey ${passkey.id}): ${e instanceof Error ? e.message : String(e)}`);
    throw new Error(errors.server.INVALID_SIGNATURE);
  }
  if (!result.verified) {
    throw new Error(errors.server.INVALID_SIGNATURE);
  }
  await passkeyHelper.recordUse(passkey.id, result.authenticationInfo.newCounter);
  return passkey;
}

// ---- presentation -----------------------------------------------------------

export function toPasskeyInfo(row: PasskeyRow): Models.Passkey.Info {
  return {
    id: row.id,
    credentialID: row.data.credentialID,
    userHandle: row.data.webAuthnUserID,
    name: row.name,
    credentialDeviceType: row.data.credentialDeviceType,
    credentialBackedUp: !!row.data.credentialBackedUp,
    transports: row.data.transports,
    createdAt: new Date(row.createdAt).toISOString(),
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : null,
  };
}
