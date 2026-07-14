// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi from "joi";
import { BotOwnerType, BotPlatformPresenceMode } from "../../common/enums";
import common from "../common";

const ownerType = Joi.string().valid(...Object.values(BotOwnerType)).required();
const ownerId = Joi.when('ownerType', {
  is: BotOwnerType.PLATFORM,
  then: Joi.equal(null).required(),
  otherwise: common.Uuid.required(),
});
const platformPresence = Joi.object<API.Bot.PlatformPresence>({
  mode: Joi.string().valid(...Object.values(BotPlatformPresenceMode)).required(),
  communityIds: Joi.array().items(common.Uuid).unique().required(),
}).strict(true);
const roleIds = Joi.array().items(common.Uuid).unique().required();

const botApi = {
  listBots: Joi.object<API.Bot.listBots.Request>({
    ownerType,
    ownerId,
  }).strict(true).required(),

  createBot: Joi.object<API.Bot.createBot.Request>({
    ownerType,
    ownerId,
    displayName: Joi.string().trim().min(1).max(255).required(),
    imageId: Joi.alternatives().try(common.ImageId, Joi.equal(null)).required(),
    description: Joi.string().allow('', null).max(2000).required(),
    platformPresence: Joi.when('ownerType', {
      is: BotOwnerType.PLATFORM,
      then: platformPresence.required(),
      otherwise: Joi.forbidden(),
    }),
  }).strict(true).required(),

  updateBot: Joi.object<API.Bot.updateBot.Request>({
    botUserId: common.Uuid.required(),
    displayName: Joi.string().trim().min(1).max(255),
    imageId: Joi.alternatives().try(common.ImageId, Joi.equal(null)),
    description: Joi.string().allow('', null).max(2000),
    platformPresence,
  }).min(2).strict(true).required(),

  disableBot: Joi.object<API.Bot.disableBot.Request>({
    botUserId: common.Uuid.required(),
  }).strict(true).required(),

  installBot: Joi.object<API.Bot.installBot.Request>({
    botUserId: common.Uuid.required(),
    communityId: common.Uuid.required(),
    roleIds,
  }).strict(true).required(),

  removeBot: Joi.object<API.Bot.removeBot.Request>({
    botUserId: common.Uuid.required(),
    communityId: common.Uuid.required(),
  }).strict(true).required(),

  setBotRoles: Joi.object<API.Bot.setBotRoles.Request>({
    botUserId: common.Uuid.required(),
    communityId: common.Uuid.required(),
    roleIds,
  }).strict(true).required(),

  setAllowUserBots: Joi.object<API.Bot.setAllowUserBots.Request>({
    communityId: common.Uuid.required(),
    allowUserBots: Joi.boolean().strict().required(),
  }).strict(true).required(),
};

export default botApi;
