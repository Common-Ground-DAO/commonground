// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi from "joi";
import common from "../common";

const passkeyApi = {
  list: Joi.object<API.Passkey.list.Request>({}).strict(true),

  // anonymous callers (sign-up) name the account the passkey is created for;
  // logged-in callers get the label from their account
  registrationOptions: Joi.object<API.Passkey.registrationOptions.Request>({
    displayName: common.CgProfileDisplayName,
  }).strict(true).required(),

  verifyRegistration: Joi.object<API.Passkey.verifyRegistration.Request>({
    registrationResponse: common.WebAuthnRegistrationResponse.required(),
    name: common.PasskeyName,
  }).strict(true).required(),

  authenticationOptions: Joi.object<API.Passkey.authenticationOptions.Request>({
    purpose: Joi.string().valid('login', 'stepup').required(),
    // conditional mediation (autofill): longer-lived challenge
    conditional: Joi.boolean(),
  }).strict(true).required(),

  rename: Joi.object<API.Passkey.rename.Request>({
    id: common.Uuid.required(),
    name: common.PasskeyName.required(),
  }).strict(true).required(),

  remove: Joi.object<API.Passkey.remove.Request>({
    id: common.Uuid.required(),
  }).strict(true).required(),
};

export default passkeyApi;
