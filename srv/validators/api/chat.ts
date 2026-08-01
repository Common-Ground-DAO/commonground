// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi from "joi";
import common from "../common";

const chatApi = {
  startChat: Joi.object({
    otherUserId: common.Uuid.required(),
  }).strict(true).required(),

  closeChat: Joi.object({
    chatId: common.Uuid.required(),
  }).strict(true).required(),
}

export default chatApi;
