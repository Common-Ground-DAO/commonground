// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import validators from "../validators";
import { registerPostRoute } from "./util";
import errors from "../common/errors";
import eventHelper from "../repositories/event";
import { getLegacyCgidRp } from "../util/passkeyConfig";
import { createAuthenticationOptions, verifyAuthentication } from "../util/passkeys";
import ipRateLimitHandler from "../util/rateLimit";

// Legacy CG ID app (docs/auth-identity §7, "Legacy CG ID"). Mounted only on a
// process running with CG_LEGACY_CGID=true (the gateway), where it is the only
// passkey surface: authentication of existing credentials of the CG ID relying
// party (the host of CGID_URL), nothing else — no registration, no user id
// from the client. The assertion runs through the shared core; the main window
// then redeems it with User/login {type:'passkey-success'}.

const cgIdRouter = express.Router();

const PASSKEY_SUCCESS_TTL_MS = 5 * 60 * 1000;

const optionsRateLimiter = ipRateLimitHandler({
  bucket: 'passkey:legacy:options',
  windowMs: 60 * 60 * 1000,
  limit_v4_v6_64: 60,
  limit_v6_56: 200,
  limit_v6_48: 400,
});

registerPostRoute<
  API.CgId.ensureSession.Request,
  API.CgId.ensureSession.Response
>(
  cgIdRouter,
  '/ensureSession',
  undefined,
  async (request) => {
    await new Promise<void>((resolve, reject) => {
      request.session.save((e) => {
        if (e) {
          console.error("Error saving session", e);
          reject(e);
        }
        else {
          resolve();
        }
      })
    });
  }
);

registerPostRoute<
  API.CgId.generateAuthenticationOptions.Request,
  API.CgId.generateAuthenticationOptions.Response
>(
  cgIdRouter,
  '/generateAuthenticationOptions',
  validators.API.CgId.generateAuthenticationOptions,
  async (request, response) => {
    await optionsRateLimiter(request, response);
    // discoverable credentials only: no allowCredentials, nobody's credential
    // ids are ever handed out
    return await createAuthenticationOptions(getLegacyCgidRp(), request.session, {
      purpose: 'login',
      userId: null,
    });
  }
);

registerPostRoute<
  API.CgId.verifyAuthenticationResponse.Request,
  API.CgId.verifyAuthenticationResponse.Response
>(
  cgIdRouter,
  '/verifyAuthenticationResponse',
  validators.API.CgId.verifyAuthenticationResponse,
  async (request, response, data) => {
    delete request.session.passkeyData;
    let passkey: Awaited<ReturnType<typeof verifyAuthentication>>;
    try {
      passkey = await verifyAuthentication(getLegacyCgidRp(), request.session, data.authenticationResponse, {
        purpose: 'login',
        userId: null,
      });
    }
    catch (e) {
      // unknown and deleted credentials are reported as such (the popup
      // tells the user); every other failure is a plain "not verified"
      if (e instanceof Error && (e.message === errors.server.NOT_FOUND || e.message === errors.server.DELETED)) {
        throw e;
      }
      return false;
    }

    request.session.passkeyData = {
      step: 'success',
      passkeyId: passkey.id,
      userId: passkey.userId,
      // redeemed by User/login {type:'passkey-success'} right away
      expiresAt: Date.now() + PASSKEY_SUCCESS_TTL_MS,
    };
    eventHelper.emit({
      type: 'cliCgIdSignResponse',
      data: {
        type: 'authentication',
        success: true,
      },
      frontendRequestId: data.frontendRequestId,
    }, {
      sessionIds: [request.sessionID],
    });
    return true;
  }
);

export default cgIdRouter;
