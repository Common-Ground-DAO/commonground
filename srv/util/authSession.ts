// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type express from "express";
import errors from "../common/errors";

/**
 * How the session's current authentication came about. Interactive logins,
 * account creation and `User/reauthenticate` record it together with `authAt`;
 * a device-key login (silent re-login) records neither, so it never counts as
 * a fresh authentication. `transfer` is reserved for transfer-link redemption,
 * which may add a sign-in method but never satisfies the default step-up.
 */
export type AuthMethod =
  | "passkey"
  | "password"
  | "wallet"
  | "verificationCode"
  | "twitter"
  | "lukso"
  | "farcaster"
  | "signup"
  | "transfer";

/** Window in which a sensitive action accepts the last authentication. */
export const STEP_UP_MAX_AGE_MS = 5 * 60 * 1000;

const DEFAULT_STEP_UP_METHODS: ReadonlySet<AuthMethod> = new Set<AuthMethod>([
  "passkey",
  "password",
  "wallet",
  "verificationCode",
  "twitter",
  "lukso",
  "farcaster",
  "signup",
]);

function saveSession(session: express.Request["session"]) {
  return new Promise<void>((resolve, reject) => {
    session.save((e) => {
      if (e) {
        console.error("Error saving session", e);
        reject(e);
      }
      else {
        resolve();
      }
    });
  });
}

/**
 * Session fields kept when the session was already logged in as the same
 * user (a device-key re-login, e.g. after the page reload that ends the X
 * OAuth redirect): in-flight account linking and the step-up state. Nothing
 * is kept across a change of user or from an anonymous session.
 */
const SAME_USER_CARRY_OVER = [
  "passport",
  "twitter",
  "lukso",
  "farcaster",
  "preparedCredential",
  "authAt",
  "authMethod",
] as const;

/**
 * Turns the request's session into a logged-in session for `userId`. Every
 * login path ends here: the session id is regenerated (so an id known before
 * the login is worthless afterwards), all pre-login state is dropped (except
 * SAME_USER_CARRY_OVER on a re-login of the same user), the user is set, and —
 * for anything but a device-key login — the authentication time and method
 * are recorded. The save is awaited, so the response only goes out once the
 * new session exists.
 */
export async function establishLoginSession(
  request: express.Request,
  login: { userId: string; deviceId: string; method: AuthMethod | "device" },
): Promise<void> {
  const previous = request.session;
  const carried: Record<string, unknown> = {};
  if (previous.user?.id === login.userId) {
    for (const key of SAME_USER_CARRY_OVER) {
      if (previous[key] !== undefined) {
        carried[key] = previous[key];
      }
    }
  }
  await new Promise<void>((resolve, reject) => {
    request.session.regenerate((e) => (e ? reject(e) : resolve()));
  });
  const { session } = request;
  Object.assign(session, carried);
  session.createdAt = new Date();
  session.user = { id: login.userId, deviceId: login.deviceId };
  if (login.method !== "device") {
    session.authAt = Date.now();
    session.authMethod = login.method;
  }
  await saveSession(session);
}

/** Records a successful re-authentication of the session's user. */
export async function recordReauthentication(request: express.Request, method: AuthMethod): Promise<number> {
  const now = Date.now();
  request.session.authAt = now;
  request.session.authMethod = method;
  await saveSession(request.session);
  return now + STEP_UP_MAX_AGE_MS;
}

/**
 * Guard for sensitive actions: the first statement of every protected handler.
 * Throws LOGIN_REQUIRED without a session user and REAUTH_REQUIRED unless the
 * session authenticated within `maxAgeMs` with an accepted method. It runs
 * before any side effect, so a client can safely retry the same request after
 * `User/reauthenticate`.
 */
export function requireRecentAuth(
  request: express.Request,
  options: { maxAgeMs?: number; allow?: readonly AuthMethod[] } = {},
): { userId: string } {
  const session = request.session;
  const user = session?.user;
  if (!user) {
    throw new Error(errors.server.LOGIN_REQUIRED);
  }
  const maxAgeMs = options.maxAgeMs ?? STEP_UP_MAX_AGE_MS;
  const allowed = options.allow ? new Set(options.allow) : DEFAULT_STEP_UP_METHODS;
  const { authAt, authMethod } = session;
  const now = Date.now();
  if (
    typeof authAt !== "number" ||
    !authMethod ||
    !allowed.has(authMethod) ||
    authAt > now ||
    now - authAt > maxAgeMs
  ) {
    throw new Error(errors.server.REAUTH_REQUIRED);
  }
  return { userId: user.id };
}
