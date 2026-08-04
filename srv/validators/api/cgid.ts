// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi from "joi";
import common from "../common";
import {
  type AuthenticationResponseJSON,
  type RegistrationResponseJSON,
} from "@simplewebauthn/server";

const cgIdApi = {
  generateRegistrationOptions: Joi.object<API.CgId.generateRegistrationOptions.Request>({
    timezone: Joi.string().regex(/^[a-z0-9-_+\/]+$/i).max(50).required(),
  }).strict(true).required(),

  generateAuthenticationOptions: Joi.object<API.CgId.generateAuthenticationOptions.Request>({
    userId: common.Uuid,
  }).strict(true).required(),

  // Todo: make this more strict
  verifyRegistrationResponse: Joi.object<API.CgId.verifyRegistrationResponse.Request>({
    frontendRequestId: Joi.string().max(20).required(),
    registrationResponse: Joi.object<RegistrationResponseJSON>({
      authenticatorAttachment: Joi.string().required(),
      clientExtensionResults: Joi.object(),
      response: Joi.object(/*{
        Todo
      }*/).required(),
      id: Joi.string().required(),
      rawId: Joi.string().required(),
      type: Joi.string().valid('public-key').required(),
    }).required(),
  }).required(),

  // Todo: make this more strict
  verifyAuthenticationResponse: Joi.object<API.CgId.verifyAuthenticationResponse.Request>({
    frontendRequestId: Joi.string().max(20).required(),
    authenticationResponse: Joi.object<AuthenticationResponseJSON>({
      authenticatorAttachment: Joi.string().required(),
      clientExtensionResults: Joi.object(),
      response: Joi.object().required(),
      id: Joi.string().required(),
      rawId: Joi.string().required(),
      type: Joi.string().valid('public-key').required(),
    }).required(),
  }).required(),
}

export default cgIdApi;