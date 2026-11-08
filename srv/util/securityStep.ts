// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type express from "express";
import errors from "../common/errors";
import pool from "./postgres";
import redisManager from "../redis";
import { getSecurityFacts, type SecurityFacts } from "../repositories/loginMethods";
import { getProcessRpIdOrNull, isLegacyCgidMode } from "./passkeyConfig";
import { requireRecentAuth, SECURITY_STEP_AUTH } from "./authSession";
import { getSecurityStepVersion } from "./securityStepVersion";

/**
 * The account-security step (docs/auth-identity §11).
 *
 * An account must have, before it can use this instance:
 * - a sign-in method that works here: a passkey of this instance's relying
 *   party, a password, or a login-enabled EVM wallet (X, LUKSO and Farcaster
 *   accounts still sign in, but do not count);
 * - a verified email address (only on an instance that sends mail);
 * - a password that meets the policy, if it has a password and the last
 *   password sign-in showed it does not.
 *
 * The state is derived from the account, never from how the session came
 * about. While it is set, the api answers every request except the ones the
 * step needs with SECURITY_STEP_REQUIRED (securityStepMiddleware), and the
 * realtime servers refuse the login (isSecurityStepRequiredForRealtime).
 * Not enforced in legacy CG ID (gateway) mode: the gateway serves nothing but
 * sign-in and transfer links.
 */

export type SecurityStatus = API.User.getSecurityStatus.Response;

export function securityStepEnforced(): boolean {
  return !isLegacyCgidMode();
}

export function securityStatusFromFacts(facts: SecurityFacts, options: { emailRequired: boolean }): SecurityStatus {
  const needsSignInMethod = facts.passkeys + (facts.hasPassword ? 1 : 0) + facts.loginWallets === 0;
  const needsVerifiedEmail = options.emailRequired && !(facts.email && facts.emailVerified);
  const needsNewPassword = facts.hasPassword && facts.passwordChangeRequired;
  return {
    required: needsSignInMethod || needsVerifiedEmail || needsNewPassword,
    needsSignInMethod,
    needsVerifiedEmail,
    needsNewPassword,
    email: facts.email,
    emailVerified: facts.emailVerified,
    hasPassword: facts.hasPassword,
    passkeys: facts.passkeys,
    loginWallets: facts.loginWallets,
  };
}

const markerKey = (userId: string) => `security-step:${userId}`;
const MARKER_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * The account's state, computed from the database. `emailRequired`: whether
 * this instance sends mail (only the api and the job runner know). Records
 * the result for the realtime servers, which cannot tell whether mail is on.
 */
export async function computeSecurityStatus(userId: string, options: { emailRequired: boolean }): Promise<SecurityStatus> {
  // a deleted account (with a session left over) has nothing: it reaches
  // only the step's endpoints, i.e. it can sign out
  const facts = await getSecurityFacts(pool, userId, getProcessRpIdOrNull()) ?? {
    email: null,
    emailVerified: false,
    hasPassword: false,
    passwordChangeRequired: false,
    passkeys: 0,
    loginWallets: 0,
  };
  const status = securityStatusFromFacts(facts, options);
  if (!securityStepEnforced()) {
    return { ...status, required: false };
  }
  const client = redisManager.getClient("data");
  if (status.required) {
    await client.set(markerKey(userId), "1", { expiration: { type: "PX", value: MARKER_TTL_MS } });
  }
  else {
    await client.del(markerKey(userId));
  }
  return status;
}

/**
 * wsapi / call server: may this account log in a realtime connection? The
 * parts of the state that need no mail configuration come from the database
 * function `security_step_db_required` (SECURITY DEFINER: the call server's
 * role may not read users, passkeys or wallets — it only gets the answer);
 * the email part from the record the api keeps in Valkey (`useApiRecord`; the
 * call server has no Valkey access and checks the database part only —
 * joining a call goes through the api anyway).
 */
export async function isSecurityStepRequiredForRealtime(
  userId: string,
  options: { useApiRecord: boolean } = { useApiRecord: true },
): Promise<boolean> {
  if (!securityStepEnforced()) {
    return false;
  }
  const [dbRequired, marker] = await Promise.all([
    pool.query<{ required: boolean }>(
      `SELECT security_step_db_required($1::uuid, $2::text) AS "required"`,
      [userId, getProcessRpIdOrNull()],
    ).then(result => result.rows[0]?.required !== false),
    options.useApiRecord ? redisManager.getClient("data").get(markerKey(userId)) : Promise.resolve(null),
  ]);
  return dbRequired || marker === "1";
}

/**
 * What a session may do while the step is open (method + path, lower case;
 * the api routes are case-insensitive): find out what is missing, sign in or
 * out, re-authenticate, and add a sign-in method / verify the email.
 */
const OPEN_ROUTES = new Set([
  "POST /user/getsecuritystatus",
  "POST /user/checkloginstatus",
  "POST /user/ensuresession",
  "POST /user/getsignablesecret",
  "POST /user/login",
  "POST /user/logout",
  "POST /user/clearloginsession",
  "POST /user/reauthenticate",
  "POST /user/requestreauthenticationcode",
  "POST /user/setpassword",
  "POST /user/requestemailverification",
  "POST /user/verifyemail",
  "POST /user/preparewalletaction",
  "POST /user/addpreparedwallet",
  "POST /user/updatewallet",
  "POST /user/getwallets",
  "POST /user/getuserdata",
  "POST /user/previewtransferlink",
  "POST /user/redeemtransferlink",
  "POST /user/declinetransferlink",
  // one-click unsubscribe links in mails (token-authenticated)
  "GET /user/emailunsubscribe",
  "POST /user/emailunsubscribe",
  "POST /passkey/registrationoptions",
  "POST /passkey/verifyregistration",
  "POST /passkey/authenticationoptions",
  "POST /passkey/list",
  "GET /captcha/config",
  "GET /captcha/challenge",
  "GET /instance/config",
]);

export function isOpenDuringSecurityStep(method: string, path: string): boolean {
  let normalized = path.toLowerCase();
  while (normalized.length > 1 && normalized.endsWith("/")) {
    normalized = normalized.slice(0, -1);
  }
  return OPEN_ROUTES.has(`${method.toUpperCase()} ${normalized}`);
}

/**
 * computeSecurityStatus, together with the account's change counter
 * (srv/util/securityStepVersion.ts) read BEFORE the state is computed: a
 * change that lands in between moves the counter past the remembered value,
 * so it is never missed.
 */
export async function computeSecurityStatusVersioned(
  userId: string,
  options: { emailRequired: boolean },
): Promise<{ status: SecurityStatus; version: string | null }> {
  const version = await getSecurityStepVersion(userId);
  return { status: await computeSecurityStatus(userId, options), version };
}

/**
 * Remembers in the session that its account was found complete, with the
 * change counter read before that was computed (computeSecurityStatusVersioned).
 */
export function rememberSecurityStepClear(request: express.Request, userId: string, version: string | null): void {
  request.session.securityStepClearFor = { userId, version };
}

/**
 * api middleware, mounted in front of the API routers (srv/api.ts). A session
 * that was found complete remembers it (`securityStepClearFor`) as long as
 * the account's change counter stays the same; every login regenerates the
 * session, so a new login checks again.
 */
export function securityStepMiddleware(emailRequired: () => boolean): express.RequestHandler {
  return (request, response, next) => {
    if (request.botPrincipal || request.method === "OPTIONS" || !securityStepEnforced()) {
      return next();
    }
    const user = request.session?.user;
    if (!user) {
      return next();
    }
    (async () => {
      const cached = request.session.securityStepClearFor;
      if (cached && cached.userId === user.id && cached.version === await getSecurityStepVersion(user.id)) {
        return next();
      }
      const { status, version } = await computeSecurityStatusVersioned(user.id, { emailRequired: emailRequired() });
      if (!status.required) {
        rememberSecurityStepClear(request, user.id, version);
        return next();
      }
      delete request.session.securityStepClearFor;
      if (isOpenDuringSecurityStep(request.method, `${request.baseUrl}${request.path}`)) {
        return next();
      }
      response.json({ status: "ERROR", error: errors.server.SECURITY_STEP_REQUIRED });
    })().catch(next);
  };
}

export type SignInAddition = "sign-in-method" | "email";

/**
 * How old the session's sign-in (or transfer link) may be for adding what the
 * account-security step asks for — long enough to finish the step calmly.
 */
export const SECURITY_STEP_AUTH_MAX_AGE_MS = 60 * 60 * 1000;

/**
 * Guard for actions that ADD a way into the account (a passkey, a sign-in
 * wallet, a first password, an X/LUKSO/Farcaster account; an email address
 * while the account has no verified one). Runs before any side effect.
 *
 * - While the account lacks exactly what is being added (the security step),
 *   it may have nothing to re-authenticate with: an interactive sign-in or a
 *   transfer link within SECURITY_STEP_AUTH_MAX_AGE_MS is enough
 *   (SECURITY_STEP_AUTH). A silent device-key session alone is not
 *   (REAUTH_REQUIRED; the user signs in again or gets a new transfer link).
 * - Otherwise the default step-up applies, as for removing or replacing a
 *   method: a transfer-link session is an ordinary sign-in there and does not
 *   count.
 *
 * Whether the account lacks it is computed from the database at the time of
 * the request (computeSecurityStatus, with this process's mail setting) —
 * not from the session's cached "complete" mark, the realtime record in
 * Valkey or anything the client says.
 */
export async function requireAuthToAdd(
  request: express.Request,
  what: SignInAddition,
  options: { emailRequired: boolean },
): Promise<{ userId: string }> {
  const user = request.session?.user;
  if (!user) {
    throw new Error(errors.server.LOGIN_REQUIRED);
  }
  if (securityStepEnforced()) {
    const status = await computeSecurityStatus(user.id, options);
    if (
      (what === "sign-in-method" && status.needsSignInMethod) ||
      (what === "email" && status.needsVerifiedEmail)
    ) {
      return requireRecentAuth(request, { allow: SECURITY_STEP_AUTH, maxAgeMs: SECURITY_STEP_AUTH_MAX_AGE_MS });
    }
  }
  return requireRecentAuth(request);
}
