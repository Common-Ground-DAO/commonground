// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type express from "express";
import errors from "../common/errors";
import { clearSessionCookie, legacyDomainCookieCleanupActive } from "./sessionSetup";
import { loginGeneration, userSessionIndexOf, userSessionsOf } from "./userSessions";

/**
 * How the session's current authentication came about. Interactive logins,
 * account creation and `User/reauthenticate` record it together with `authAt`;
 * a device-key login (silent re-login) records neither, so it never counts as
 * a fresh authentication. `transfer` is a transfer-link redemption
 * (User/redeemTransferLink): it never satisfies the default step-up, and it
 * adds a sign-in method or an address only while the account still lacks
 * exactly that (the account-security step, srv/util/securityStep.ts).
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
 * What the account-security step accepts for adding what the account lacks
 * (srv/util/securityStep.ts requireAuthToAdd): any interactive sign-in, and a
 * transfer-link session. Nowhere else does a transfer-link session count —
 * for an account that is not in the step it is an ordinary sign-in, and
 * every change to its sign-in methods takes the default step-up.
 */
export const SECURITY_STEP_AUTH: readonly AuthMethod[] = [...DEFAULT_STEP_UP_LIST, "transfer"];

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
 * The login also marks the session as clear of the obsolete subdomain-scoped
 * cookie: the session middlewares expired it in this response
 * already if the request carried a session cookie (srv/util/sessionSetup.ts).
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
    markLegacyDomainCookieCleared(previous);
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
  const replaced = previous.user ? { userId: previous.user.id, sid: request.sessionID } : null;
  await new Promise<void>((resolve, reject) => {
    request.session.regenerate((e) => (e ? reject(e) : resolve()));
  });
  if (replaced) {
    await forgetSession(request, replaced.userId, replaced.sid);
  }
  const { session } = request;
  Object.assign(session, carried);
  session.createdAt = new Date();
  // the generation taken before the credential was checked
  const gen = loginGeneration(request);
  session.gen = gen;
  markLegacyDomainCookieCleared(session);
  session.user = { id: login.userId, deviceId: login.deviceId };
  if (login.method !== "device") {
    session.authAt = Date.now();
    session.authMethod = login.method;
  }
  await saveSession(session);
  // The account signed out its other devices after this login started (so
  // it may have checked a credential that is gone now): the new session and
  // the device key this login created go again. Read after the save and
  // after the device was created; a bump only happens after the change
  // committed, so a login that started after it checked the new state.
  const currentGeneration = userSessionsOf(request.sessionStore)?.currentGeneration;
  if (currentGeneration && (await currentGeneration(login.userId)) > gen) {
    const sessions = userSessionsOf(request.sessionStore);
    await endLoginSession(request);
    if (login.method !== "device") {
      await sessions?.discardDevice?.(login.deviceId).catch((e) => {
        console.error("Error deleting the device of a signed-out login", e instanceof Error ? e.message : e);
      });
    }
    throw new Error(login.method === "device" ? errors.server.NOT_FOUND : errors.server.NOT_ALLOWED);
  }
}

function markLegacyDomainCookieCleared(session: express.Request["session"]) {
  if (legacyDomainCookieCleanupActive()) {
    session.legacyDomainCookieCleared = true;
  }
}

/**
 * Logout: the session is destroyed in the store (a copy of its cookie is
 * worthless from now on) and the response expires the cookie. No new session
 * takes its place — anonymous requests need none, and an empty one would be
 * neither saved nor sent anyway; the rest of this request runs without
 * `request.session`. (A regenerated session would be: express-session saves
 * any session whose id changed.)
 */
export async function endLoginSession(request: express.Request): Promise<void> {
  const ended = request.session.user ? { userId: request.session.user.id, sid: request.sessionID } : null;
  await new Promise<void>((resolve, reject) => {
    request.session.destroy((e) => (e ? reject(e) : resolve()));
  });
  if (ended) {
    await forgetSession(request, ended.userId, ended.sid);
  }
  if (request.res) {
    clearSessionCookie(request.res);
  }
}

/**
 * Drops a session that is gone from the index of the user's sessions
 * (srv/util/userSessions.ts). A store without an index has nothing to drop.
 */
async function forgetSession(request: express.Request, userId: string, sid: string) {
  await userSessionIndexOf(request.sessionStore)?.forget(userId, sid);
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
