// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type express from "express";
import errors from "../common/errors";

/**
 * How the session's current authentication came about. Interactive logins,
 * account creation and `User/reauthenticate` record it together with `authAt`;
 * a device-key login (silent re-login) records neither, so it never counts as
 * a fresh authentication. `transfer` is a transfer-link redemption
 * (User/redeemTransferLink), which may add a sign-in method but never
 * satisfies the default step-up.
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

const DEFAULT_STEP_UP_LIST: readonly AuthMethod[] = [
  "passkey",
  "password",
  "wallet",
  "verificationCode",
  "twitter",
  "lukso",
  "farcaster",
  "signup",
];
const DEFAULT_STEP_UP_METHODS: ReadonlySet<AuthMethod> = new Set<AuthMethod>(DEFAULT_STEP_UP_LIST);

/**
 * Adding a sign-in method (srv/util/securityStep.ts requireAuthToAdd) also
 * accepts a fresh transfer-link session; removing or replacing one does not.
 */
export const ADD_SIGN_IN_METHOD_AUTH: readonly AuthMethod[] = [...DEFAULT_STEP_UP_LIST, "transfer"];

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
 * Session fields kept when an interactive login regenerates a session that
 * was already logged in as the same user: in-flight account linking and the
 * step-up state (which the new login then refreshes). Nothing is kept across
 * a change of user or from an anonymous session. (A device-key re-login of
 * the same user keeps the whole session, see establishLoginSession.)
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
 * login path ends here.
 *
 * - Whenever the session gains a principal or authority — anonymous → user,
 *   user A → user B, and every interactive login, which refreshes the step-up
 *   time — the session id is regenerated (an id known before the login is
 *   worthless afterwards: no session fixation), all pre-login state is
 *   dropped (except SAME_USER_CARRY_OVER on a re-login of the same user), the
 *   user is set and the authentication time and method are recorded.
 * - A device-key login of the user the session already belongs to (the
 *   automatic re-login on every page load) gains nothing: the session keeps
 *   its id. Regenerating it here destroyed the id the page's other requests
 *   were still using, so they ran anonymously (LOGIN_REQUIRED) until the new
 *   cookie arrived. The step-up time is left exactly as it was.
 *
 * The save is awaited, so the response only goes out once the session exists.
 */
export async function establishLoginSession(
  request: express.Request,
  login: { userId: string; deviceId: string; method: AuthMethod | "device" },
): Promise<void> {
  const previous = request.session;
  if (login.method === "device" && previous.user?.id === login.userId) {
    previous.user = { id: login.userId, deviceId: login.deviceId };
    // the challenge of this login is used up
    delete previous.signSecret;
    await saveSession(previous);
    return;
  }
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

/**
 * Logout: the session is replaced by a new, empty one (the old id is
 * destroyed in the store, so a copy of the old cookie is worthless) and the
 * save is awaited.
 */
export async function endLoginSession(request: express.Request): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    request.session.regenerate((e) => (e ? reject(e) : resolve()));
  });
  request.session.createdAt = new Date();
  await saveSession(request.session);
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
 * Until when the session's last interactive authentication counts for
 * sensitive actions (the default step-up), or null. Lets the web app know
 * after a silent re-login that it may still skip the "Confirm it's you"
 * dialog; the server's REAUTH_REQUIRED stays authoritative.
 */
export function stepUpValidUntil(request: express.Request): number | null {
  const { authAt } = request.session;
  return hasRecentAuth(request) && typeof authAt === "number" ? authAt + STEP_UP_MAX_AGE_MS : null;
}

/** Non-throwing form of requireRecentAuth: would it pass? */
export function hasRecentAuth(
  request: express.Request,
  options: { maxAgeMs?: number; allow?: readonly AuthMethod[] } = {},
): boolean {
  try {
    requireRecentAuth(request, options);
    return true;
  }
  catch {
    return false;
  }
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
