// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import validators from "../validators";
import { registerPostRoute } from "./util";
import errors from "../common/errors";
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type GenerateAuthenticationOptionsOpts,
} from "@simplewebauthn/server";
import {
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from "@simplewebauthn/types";
import config from "../common/config";
import urls from "../util/urls";
import walletHelper from "../repositories/wallets";
import dayjs from "dayjs";
import eventHelper from "../repositories/event";

const walletRouter = express.Router();

let rpID: string;
let expectedOrigin: string | string[];
if (config.DEPLOYMENT === "dev") {
  rpID = "localhost";
  expectedOrigin = ["http://localhost:3000", "http://localhost:8000"];
}
else {
  // the CG ID app lives on its own origin (id.<domain>); derive it from
  // CGID_URL so self-hosted instances get working passkeys
  // (id.app.cg / id.staging.app.cg unchanged)
  const cgidOrigin = new URL(process.env.CGID_URL || `https://id.${urls.APP_HOSTNAME}`).origin;
  rpID = new URL(cgidOrigin).hostname;
  expectedOrigin = cgidOrigin;
}

registerPostRoute<
  API.CgId.ensureSession.Request,
  API.CgId.ensureSession.Response
>(
  walletRouter,
  '/ensureSession',
  undefined,
  async (request, response, data) => {
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
  API.CgId.getLoggedInUserData.Request,
  API.CgId.getLoggedInUserData.Response
>(
  walletRouter,
  '/getLoggedInUserData',
  undefined,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      return null;
    }

    const passkeysData = await walletHelper.getUserPasskeys(user.id);
    return {
      userId: user.id,
      passkeys: passkeysData.map(passkey => {
        const  { credentialID, credentialBackedUp, credentialDeviceType, transports } = passkey.data;
        return { credentialID, credentialBackedUp, credentialDeviceType, transports };
      }),
    }; 
  }
);

registerPostRoute<
  API.CgId.generateRegistrationOptions.Request,
  API.CgId.generateRegistrationOptions.Response
>(
  walletRouter,
  '/generateRegistrationOptions',
  validators.API.CgId.generateRegistrationOptions,
  async (request, response, data) => {
    const name = dayjs().tz(data.timezone).format("YYYY-MM-DD HH:mm");

    const options: PublicKeyCredentialCreationOptionsJSON = await generateRegistrationOptions({
      rpName: "Common Ground",
      rpID,
      userName: "Key " + name,
      userDisplayName: "Key " + name,
      // Don't prompt users for additional information about the authenticator
      // (Recommended for smoother UX)
      attestationType: 'none',
      // Prevent users from re-registering existing authenticators
      /* excludeCredentials: userPasskeys.map(passkey => ({
        id: passkey.id,
        // Optional
        transports: passkey.transports,
      })), */
      // See "Guiding use of authenticators via authenticatorSelection" below
      authenticatorSelection: {
        // Defaults
        residentKey: 'preferred',
        userVerification: 'preferred',
        // Optional: for now we don't want to enforce a specific attachment
        // authenticatorAttachment: 'cross-platform',
      },
      supportedAlgorithmIDs: [-7, -8, -257],
    });

    request.session.passkeyData = {
      step: 'registration_sign',
      options,
    };

    return options;
  }
);

registerPostRoute<
  API.CgId.generateAuthenticationOptions.Request,
  API.CgId.generateAuthenticationOptions.Response
>(
  walletRouter,
  '/generateAuthenticationOptions',
  validators.API.CgId.generateAuthenticationOptions,
  async (request, response, data) => {
    // Retrieve any of the user's previously-
    // registered authenticators
    const userId = data.userId;

    const generateOptions: GenerateAuthenticationOptionsOpts = {
      rpID,
    };
    if (userId) {
      const passkeys = await walletHelper.getUserPasskeys(userId);
      generateOptions.allowCredentials = passkeys.map(passkey => ({
        id: passkey.data.credentialID,
        transports: passkey.data.transports,
      }));
    }
    
    const options: PublicKeyCredentialRequestOptionsJSON = await generateAuthenticationOptions(generateOptions);
    request.session.passkeyData = {
      step: 'authentication_sign',
      options,
    };

    return options;
  }
);

registerPostRoute<
  API.CgId.verifyRegistrationResponse.Request,
  API.CgId.verifyRegistrationResponse.Response
>(
  walletRouter,
  '/verifyRegistrationResponse',
  validators.API.CgId.verifyRegistrationResponse,
  async (request, response, data) => {
    const { user } = request.session;

    const { passkeyData } = request.session;
    if (!passkeyData || passkeyData.step !== 'registration_sign') {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    const passkeyCreationOptions = passkeyData.options;

    let verified: boolean;

    try {
      const result = await verifyRegistrationResponse({
        response: data.registrationResponse,
        expectedChallenge: passkeyCreationOptions.challenge,
        expectedOrigin,
        expectedRPID: passkeyCreationOptions.rp.id,
      });

      if (result.verified === true && result.registrationInfo !== undefined) {
        verified = true;
        const {
          credentialID,
          credentialPublicKey,
          counter,
          credentialDeviceType,
          credentialBackedUp,
        } = result.registrationInfo;

        const userId = user?.id || null;

        const passkeyId = await walletHelper.addPasskey(userId, {
          webAuthnUserID: passkeyCreationOptions.user.id,
          credentialID,
          credentialPublicKeyBase64: Buffer.from(credentialPublicKey).toString("base64"),
          credentialDeviceType,
          credentialBackedUp,
          transports: data.registrationResponse.response.transports,
          debugData: {
            registrationOptions: passkeyCreationOptions,
            registrationResponse: data.registrationResponse,
            deviceInfo: undefined,
          },
        }, counter);

        if (userId) {
          const passkeys = await walletHelper.getUserPasskeys(userId);
          const eventPasskeys: Models.Passkey.Data[] = passkeys.map(passkey => {
            const  { createdAt, updatedAt } = passkey;
            const  { credentialID, credentialBackedUp, credentialDeviceType } = passkey.data;
            return { credentialID, credentialBackedUp, credentialDeviceType, createdAt, updatedAt };
          });
          eventHelper.emit({
            type: 'cliUserOwnData',
            data: {
              passkeys: eventPasskeys,
            },
          }, {
            userIds: [userId],
          });
        }

        request.session.passkeyData = {
          step: 'success',
          passkeyId,
          userId,
        };
      }
      else {
        verified = false;
      }
    }
    catch (e) {
      verified = false;
      console.log("Error verifying registration response", e);
    }

    if (verified === false) {
      delete request.session.passkeyData;
    }
    else {
      const { frontendRequestId } = data;
      eventHelper.emit({
        type: 'cliCgIdSignResponse',
        data: {
          type: 'registration',
          success: true,
        },
        frontendRequestId,
      }, {
        sessionIds: [request.sessionID],
      });
    }
    return verified;
  }
);

registerPostRoute<
  API.CgId.verifyAuthenticationResponse.Request,
  API.CgId.verifyAuthenticationResponse.Response
>(
  walletRouter,
  '/verifyAuthenticationResponse',
  validators.API.CgId.verifyAuthenticationResponse,
  async (request, response, data) => {
    const { passkeyData } = request.session;
    if (!passkeyData || passkeyData.step !== 'authentication_sign') {
      throw new Error(errors.server.INVALID_REQUEST);
    }

    const passkeyAuthenticationOptions = passkeyData.options;
    const credentialID = data.authenticationResponse.rawId;
    const webAuthnUserID = data.authenticationResponse.response.userHandle;

    if (!credentialID || !webAuthnUserID) {
      throw new Error(errors.server.INVALID_REQUEST);
    }

    const passkey = await walletHelper.getPasskeyByCredentialIdAndWebAuthnUserId({ credentialID, webAuthnUserID });

    if (!passkey) {
      delete request.session.passkeyData;
      throw new Error(errors.server.NOT_FOUND);
    }
    if (passkey.deletedAt !== null) {
      delete request.session.passkeyData;
      throw new Error(errors.server.DELETED);
    }

    let verified: boolean;

    const {
      credentialPublicKeyBase64,
      transports,
    } = passkey.data;

    try {
      const result = await verifyAuthenticationResponse({
        response: data.authenticationResponse,
        expectedChallenge: passkeyAuthenticationOptions.challenge,
        expectedOrigin,
        expectedRPID: passkeyAuthenticationOptions.rpId!,
        authenticator: {
          credentialID,
          credentialPublicKey: new Uint8Array(Buffer.from(credentialPublicKeyBase64, "base64")),
          transports,
          counter: passkey.counter,
        }
      });

      if (result.verified === true && result.authenticationInfo !== undefined) {
        verified = true;
        const { newCounter } = result.authenticationInfo;
        await walletHelper.updatePasskeyCounter(passkey.id, newCounter);
        request.session.passkeyData = {
          step: 'success',
          passkeyId: passkey.id,
          userId: passkey.userId,
        };
      }
      else {
        verified = false;
      }
    }
    catch (e) {
      verified = false;
      console.log("Error verifying registration response", e);
    }

    if (verified === false) {
      // clear session passkeyData, authentication needs to be restarted on the client
      delete request.session.passkeyData;
    }
    else {
      const { frontendRequestId } = data;
      eventHelper.emit({
        type: 'cliCgIdSignResponse',
        data: {
          type: 'authentication',
          success: true,
        },
        frontendRequestId,
      }, {
        sessionIds: [request.sessionID],
      });

      const { userId } = passkey;
      if (userId) {
        const passkeys = await walletHelper.getUserPasskeys(userId);
        const eventPasskeys: Models.Passkey.Data[] = passkeys.map(passkey => {
          const  { createdAt, updatedAt } = passkey;
          const  { credentialID, credentialBackedUp, credentialDeviceType } = passkey.data;
          return { credentialID, credentialBackedUp, credentialDeviceType, createdAt, updatedAt };
        });
        eventHelper.emit({
          type: 'cliUserOwnData',
          data: {
            passkeys: eventPasskeys,
          },
        }, {
          userIds: [userId],
        });
      }
    }
    return verified;
  }
);

export default walletRouter;