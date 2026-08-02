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

  getOwnAssistantChats: Joi.object({
    type: Joi.string().valid('user', 'community').required(),
    communityId: Joi.when('type', {
      is: 'community',
      then: common.Uuid.required(),
      otherwise: Joi.forbidden(),
    }),
  }).strict(true).required(),

  loadAssistantChat: Joi.object({
    dialogId: common.Uuid.required(),
  }).strict(true).required(),

  startAssistantChat: Joi.object({
    template: Joi.string().valid('community_v1', 'user_v1').required(),
    model: common.Assistant.ModelName.required(),
    communityId: Joi.when('template', {
      is: 'community_v1',
      then: common.Uuid.required(),
      otherwise: Joi.forbidden(),
    }),
    message: Joi.string().required(),
  }).strict(true).required(),

  continueAssistantChat: Joi.object({
    dialogId: common.Uuid.required(),
    message: Joi.string().required(),
  }).strict(true).required(),

  deleteAssistantChat: Joi.object({
    dialogId: common.Uuid.required(),
  }).strict(true).required(),

  getAssistantQueueData: Joi.object({
    ownPriority: Joi.number().required(),
    ownScore: Joi.number().required(),
    model: common.Assistant.ModelName.required(),
  }).strict(true).required(),
}

export default chatApi;
