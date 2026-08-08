// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi from "joi";
import common from "../common";
import { messageAccessValidator } from "./message";

const socketApi = {
  login: Joi.object<API.Socket.login.Request>({
    secret: common.Secret.required(),
    deviceId: common.Uuid.required(),
    base64Signature: common.Base64DeviceSignature.required(),
  }).required().strict(true),

  joinCommunityVisitorRoom: Joi.object<API.Socket.joinCommunityVisitorRoom.Request>({
    communityId: common.Uuid.required(),
  }).required().strict(true),

  setTyping: Joi.object<API.Socket.setTyping.Request>({
    access: messageAccessValidator.required(),
    isTyping: Joi.boolean().required(),
  }).required().strict(true),
}

export default socketApi;