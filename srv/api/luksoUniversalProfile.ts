// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import errors from "../common/errors";
import { registerPostRoute } from "./util";
import validators from "../validators";
import onchainHelper from "../repositories/onchain";
import userHelper from "../repositories/users";
import { SIGNABLE_SECRET_LENGTH } from "./user";
import ipRateLimitHandler from "../util/rateLimit";
import { AUTH_LIMITS } from "../util/authLimits";
import { isGatewayMode } from "../util/gateway";

const luksoUniversalProfileRouter = express.Router();

// the check asks the chain (srv/util/authLimits.ts "preLogin")
const signatureCheckLimiter = ipRateLimitHandler({
  bucket: 'lukso:prepare-action',
  ...AUTH_LIMITS.preLogin.signatureCheck,
});

registerPostRoute<
  API.Lukso.PrepareLuksoAction.Request,
  API.Lukso.PrepareLuksoAction.Response
>(
  luksoUniversalProfileRouter,
  '/PrepareLuksoAction',
  validators.API.Lukso.PrepareLuksoAction,
  async (request, response, data) => {
    await signatureCheckLimiter(request, response);
    try {
      const { signSecret } = request.session;
      const secret = data.message.match(new RegExp(`Nonce: ([a-zA-Z0-9]{${SIGNABLE_SECRET_LENGTH}})`))?.[1];
      if (!signSecret || secret !== signSecret) {
        throw new Error(errors.server.INVALID_SECRET);
      }
      const isValidSignature = await onchainHelper.luksoIsValidSignature(data.address, data.signature, data.message);
      if (!isValidSignature) {
        throw new Error(errors.server.INVALID_SIGNATURE);
      }
      const universalProfileValid = !(await userHelper.isUniversalProfileAlreadyLinked(data.address));
      if (universalProfileValid && isGatewayMode()) {
        // a gateway (srv/util/gateway.ts) signs in existing accounts only: no
        // profile lookup, no sign-up prepared
        throw new Error(errors.server.ACCOUNT_DOES_NOT_EXIST);
      }
      const universalProfileExists = await onchainHelper.luksoGetUniversalProfileData(data.address);
      const readyForLogin = universalProfileExists && !universalProfileValid;
      const readyForCreation = universalProfileExists && universalProfileValid;
      
      request.session.lukso = { 
        username: universalProfileExists.username,
        profileImageUrl: universalProfileExists.profileImageUrl,
        address: data.address,
        message: data.message,
        signature: data.signature,
        description: universalProfileExists.description,
        existsAlready: !universalProfileValid,
       };
      return { universalProfileValid, universalProfileExists: !!universalProfileExists, readyForLogin, readyForCreation, description: universalProfileExists.description, username: universalProfileExists.username, profileImageUrl: universalProfileExists.profileImageUrl };
    } catch (e: any) {
      console.error("An error occurred preparing lukso action: ", e.message);
      if (e.message.includes('timeout')){
        throw new Error(errors.server.LUKSO_FETCH_TIMEOUT);
      } 
      switch (e.message) {
        case errors.server.INVALID_SIGNATURE:
          throw new Error(errors.server.INVALID_SIGNATURE);
        case errors.server.ACCOUNT_DOES_NOT_EXIST:
          throw new Error(errors.server.ACCOUNT_DOES_NOT_EXIST);
        case errors.server.LUKSO_PROFILE_NOT_FOUND:
          throw new Error(errors.server.LUKSO_PROFILE_NOT_FOUND);
        case errors.server.LUKSO_FETCH_FAILED:
          throw new Error(errors.server.LUKSO_FETCH_FAILED);
        case errors.server.LUKSO_FETCH_TIMEOUT:
          throw new Error(errors.server.LUKSO_FETCH_TIMEOUT);
        case errors.server.LUKSO_INVALID_FORMAT:
          throw new Error(errors.server.LUKSO_INVALID_FORMAT);
        default:
          throw new Error(errors.server.LUKSO_LOGIN_FAILED);
      }
    }
  }
);

export default luksoUniversalProfileRouter;
