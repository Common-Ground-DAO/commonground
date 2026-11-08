// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi from "joi";
import common from "../common";

// Legacy CG ID app (mounted only with CG_LEGACY_CGID=true): authentication
// only — no registration, no user id from the client.
const cgIdApi = {
  generateAuthenticationOptions: Joi.object<API.CgId.generateAuthenticationOptions.Request>({
  }).strict(true).required(),

  verifyAuthenticationResponse: Joi.object<API.CgId.verifyAuthenticationResponse.Request>({
    frontendRequestId: Joi.string().max(20).required(),
    authenticationResponse: common.WebAuthnAuthenticationResponse.required(),
  }).strict(true).required(),
}

export default cgIdApi;
