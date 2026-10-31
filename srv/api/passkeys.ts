// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import { UAParser } from "ua-parser-js";
import validators from "../validators";
import { registerPostRoute } from "./util";
import errors from "../common/errors";
import eventHelper from "../repositories/event";
import userHelper from "../repositories/users";
import passkeyHelper, { type PasskeyRow } from "../repositories/passkeys";
import ipRateLimitHandler from "../util/rateLimit";
import { getMainRp } from "../util/passkeyConfig";
import {
  createAuthenticationOptions,
  createRegistrationOptions,
  newUserHandle,
  PENDING_PASSKEY_TTL_MS,
  toPasskeyInfo,
  verifyRegistration,
} from "../util/passkeys";
import { requireRecentAuth } from "../util/authSession";
import { getVerifiedSignupEmail } from "../util/signupEmail";
import { emailEnabled } from "./emails";
import { notifyNewSignInMethod } from "../util/signInNotice";

// Passkeys on the instance's own origin (docs/auth-identity §7). Mounted only
// when the process is NOT in legacy CG ID mode. Login with a passkey is
// User/login {type:'passkey'}, re-authentication User/reauthenticate.

const passkeyRouter = express.Router();

const HOUR = 60 * 60 * 1000;
const anonymousRegistrationLimiter = ipRateLimitHandler({
  bucket: 'passkey:register:anon',
  windowMs: HOUR,
  limit_v4_v6_64: 20,
  limit_v6_56: 60,
  limit_v6_48: 120,
});
const loginOptionsLimiter = ipRateLimitHandler({
  bucket: 'passkey:login:options',
  windowMs: HOUR,
  limit_v4_v6_64: 120,
  limit_v6_56: 400,
  limit_v6_48: 800,
});

/**
 * Sign-up order: email code first, then the sign-in method, then createUser.
 * On an instance that sends mail, a sign-up passkey therefore needs the
 * session's verified sign-up address (EMAIL_VERIFICATION_REQUIRED otherwise).
 */
function requireVerifiedSignupEmail(request: express.Request): string | null {
  const verifiedEmail = getVerifiedSignupEmail(request.session);
  if (!verifiedEmail && emailEnabled()) {
    throw new Error(errors.server.EMAIL_VERIFICATION_REQUIRED);
  }
  return verifiedEmail;
}

function defaultPasskeyName(request: express.Request): string {
  const ua = UAParser(request.headers["user-agent"]);
  const browser = ua.browser.name;
  const os = ua.os.name;
  const name = browser && os ? `${browser} on ${os}` : browser || os || "Passkey";
  return name.slice(0, 64);
}

function ownDataPasskeys(rows: PasskeyRow[]): Models.Passkey.Data[] {
  return rows.map(row => ({
    credentialID: row.data.credentialID,
    credentialBackedUp: !!row.data.credentialBackedUp,
    credentialDeviceType: row.data.credentialDeviceType,
    createdAt: new Date(row.createdAt).toISOString(),
    updatedAt: new Date(row.updatedAt).toISOString(),
  }));
}

async function emitOwnPasskeys(userId: string, rows: PasskeyRow[]) {
  eventHelper.emit({
    type: 'cliUserOwnData',
    data: {
      passkeys: ownDataPasskeys(rows),
    },
  }, {
    userIds: [userId],
  });
}

registerPostRoute<
  API.Passkey.registrationOptions.Request,
  API.Passkey.registrationOptions.Response
>(
  passkeyRouter,
  '/registrationOptions',
  validators.API.Passkey.registrationOptions,
  async (request, response, data) => {
    const rp = getMainRp();
    const { user } = request.session;
    if (user) {
      // adding a sign-in method to an existing account
      requireRecentAuth(request);
      const [ownData, existing, existingHandle] = await Promise.all([
        userHelper.getOwnDataById(user.id),
        passkeyHelper.listUserPasskeys(user.id, rp.rpId),
        passkeyHelper.getUserHandle(user.id, rp.rpId),
      ]);
      const profileName = ownData.accounts.find(account => account.type === 'cg')?.displayName
        || ownData.accounts.find(account => account.type === ownData.displayAccount)?.displayName
        || null;
      const userName = ownData.email || profileName || user.id;
      return await createRegistrationOptions(rp, request.session, {
        userId: user.id,
        // one stable handle per account and RP: authenticators then replace
        // instead of piling up entries, and excludeCredentials works
        userHandle: existingHandle || newUserHandle(),
        userName,
        userDisplayName: profileName || userName,
        excludeCredentials: existing.map(row => ({
          id: row.data.credentialID,
          transports: row.data.transports,
        })),
      });
    }

    // sign-up: the account does not exist yet
    await anonymousRegistrationLimiter(request, response);
    if (!data.displayName) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    const verifiedEmail = requireVerifiedSignupEmail(request);
    return await createRegistrationOptions(rp, request.session, {
      userId: null,
      userHandle: newUserHandle(),
      userName: verifiedEmail || data.displayName,
      userDisplayName: data.displayName,
      excludeCredentials: [],
    });
  }
);

registerPostRoute<
  API.Passkey.verifyRegistration.Request,
  API.Passkey.verifyRegistration.Response
>(
  passkeyRouter,
  '/verifyRegistration',
  validators.API.Passkey.verifyRegistration,
  async (request, response, data) => {
    const rp = getMainRp();
    const { user } = request.session;
    const name = data.name || defaultPasskeyName(request);
    if (user) {
      requireRecentAuth(request);
      const passkey = await verifyRegistration(rp, request.session, data.registrationResponse, {
        userId: user.id,
        name,
      });
      await passkeyHelper.addPasskey(user.id, passkey);
      const rows = await passkeyHelper.listUserPasskeys(user.id, rp.rpId);
      await emitOwnPasskeys(user.id, rows);

      // tell the account's verified address that a sign-in method was added
      notifyNewSignInMethod(user.id, `passkey "${name}"`);
      return { status: 'attached', passkeys: rows.map(toPasskeyInfo) };
    }

    await anonymousRegistrationLimiter(request, response);
    requireVerifiedSignupEmail(request);
    const passkey = await verifyRegistration(rp, request.session, data.registrationResponse, {
      userId: null,
      name,
    });
    request.session.pendingPasskey = {
      ...passkey,
      expiresAt: Date.now() + PENDING_PASSKEY_TTL_MS,
    };
    return { status: 'pending' };
  }
);

registerPostRoute<
  API.Passkey.authenticationOptions.Request,
  API.Passkey.authenticationOptions.Response
>(
  passkeyRouter,
  '/authenticationOptions',
  validators.API.Passkey.authenticationOptions,
  async (request, response, data) => {
    const rp = getMainRp();
    if (data.purpose === 'stepup') {
      const { user } = request.session;
      if (!user) {
        throw new Error(errors.server.LOGIN_REQUIRED);
      }
      const rows = await passkeyHelper.listUserPasskeys(user.id, rp.rpId);
      if (rows.length === 0) {
        throw new Error(errors.server.NOT_FOUND);
      }
      return await createAuthenticationOptions(rp, request.session, {
        purpose: 'stepup',
        userId: user.id,
        allowCredentials: rows.map(row => ({ id: row.data.credentialID, transports: row.data.transports })),
      });
    }
    await loginOptionsLimiter(request, response);
    // login: discoverable credentials only — never anyone's credential ids
    return await createAuthenticationOptions(rp, request.session, {
      purpose: 'login',
      userId: null,
      conditional: data.conditional === true,
    });
  }
);

registerPostRoute<
  API.Passkey.list.Request,
  API.Passkey.list.Response
>(
  passkeyRouter,
  '/list',
  validators.API.Passkey.list,
  async (request) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const rows = await passkeyHelper.listUserPasskeys(user.id, getMainRp().rpId);
    return rows.map(toPasskeyInfo);
  }
);

registerPostRoute<
  API.Passkey.rename.Request,
  API.Passkey.rename.Response
>(
  passkeyRouter,
  '/rename',
  validators.API.Passkey.rename,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await passkeyHelper.rename(user.id, getMainRp().rpId, data.id, data.name);
  }
);

registerPostRoute<
  API.Passkey.remove.Request,
  API.Passkey.remove.Response
>(
  passkeyRouter,
  '/remove',
  validators.API.Passkey.remove,
  async (request, response, data) => {
    const { userId } = requireRecentAuth(request);
    const rp = getMainRp();
    const result = await passkeyHelper.removeUnlessLastMethod(userId, rp.rpId, data.id);
    if (result === 'not-found') {
      throw new Error(errors.server.NOT_FOUND);
    }
    if (result === 'last') {
      throw new Error(errors.server.LAST_LOGIN_METHOD);
    }
    await emitOwnPasskeys(userId, await passkeyHelper.listUserPasskeys(userId, rp.rpId));
  }
);

export default passkeyRouter;
