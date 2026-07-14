// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import errors from "../common/errors";
import botHelper from "../repositories/bots";
import validators from "../validators";
import { registerPostRoute } from "./util";
import botTokenHelper from "../repositories/botTokens";

const botRouter = express.Router();

function sessionUserId(request: express.Request) {
  const user = request.session.user;
  if (!user) throw new Error(errors.server.LOGIN_REQUIRED);
  return user.id;
}

registerPostRoute<API.Bot.listBots.Request, API.Bot.listBots.Response>(
  botRouter,
  '/list',
  validators.API.Bot.listBots,
  (request, response, data) => botHelper.listBots(sessionUserId(request), data),
);

registerPostRoute<API.Bot.listCommunityBots.Request, API.Bot.listCommunityBots.Response>(
  botRouter,
  '/listCommunityBots',
  validators.API.Bot.listCommunityBots,
  (request, response, data) => botHelper.listCommunityBots(sessionUserId(request), data.communityId),
);

registerPostRoute<API.Bot.listInstallableUserBots.Request, API.Bot.listInstallableUserBots.Response>(
  botRouter,
  '/listInstallableUserBots',
  validators.API.Bot.listInstallableUserBots,
  (request, response, data) => botHelper.listInstallableUserBots(sessionUserId(request), data),
);

registerPostRoute<API.Bot.createBot.Request, API.Bot.createBot.Response>(
  botRouter,
  '/create',
  validators.API.Bot.createBot,
  (request, response, data) => botHelper.createBot(sessionUserId(request), data),
);

registerPostRoute<API.Bot.updateBot.Request, API.Bot.updateBot.Response>(
  botRouter,
  '/update',
  validators.API.Bot.updateBot,
  (request, response, data) => botHelper.updateBot(sessionUserId(request), data),
);

registerPostRoute<API.Bot.disableBot.Request, API.Bot.disableBot.Response>(
  botRouter,
  '/disable',
  validators.API.Bot.disableBot,
  (request, response, data) => botHelper.disableBot(sessionUserId(request), data.botUserId),
);

registerPostRoute<API.Bot.installBot.Request, API.Bot.installBot.Response>(
  botRouter,
  '/install',
  validators.API.Bot.installBot,
  (request, response, data) => botHelper.installBot(sessionUserId(request), data),
);

registerPostRoute<API.Bot.removeBot.Request, API.Bot.removeBot.Response>(
  botRouter,
  '/remove',
  validators.API.Bot.removeBot,
  (request, response, data) => botHelper.removeBot(sessionUserId(request), data),
);

registerPostRoute<API.Bot.setBotRoles.Request, API.Bot.setBotRoles.Response>(
  botRouter,
  '/setRoles',
  validators.API.Bot.setBotRoles,
  (request, response, data) => botHelper.setBotRoles(sessionUserId(request), data),
);

registerPostRoute<API.Bot.setAllowUserBots.Request, API.Bot.setAllowUserBots.Response>(
  botRouter,
  '/setAllowUserBots',
  validators.API.Bot.setAllowUserBots,
  (request, response, data) => botHelper.setAllowUserBots(sessionUserId(request), data.communityId, data.allowUserBots),
);

registerPostRoute<API.Bot.issueToken.Request, API.Bot.issueToken.Response>(
  botRouter,
  '/tokens/issue',
  validators.API.Bot.issueToken,
  (request, response, data) => botTokenHelper.issueToken(sessionUserId(request), data.botUserId, data.name),
);

registerPostRoute<API.Bot.listTokens.Request, API.Bot.listTokens.Response>(
  botRouter,
  '/tokens/list',
  validators.API.Bot.listTokens,
  (request, response, data) => botTokenHelper.listTokens(sessionUserId(request), data.botUserId),
);

registerPostRoute<API.Bot.revokeToken.Request, API.Bot.revokeToken.Response>(
  botRouter,
  '/tokens/revoke',
  validators.API.Bot.revokeToken,
  (request, response, data) => botTokenHelper.revokeToken(sessionUserId(request), data.botUserId, data.tokenId),
);

export default botRouter;
