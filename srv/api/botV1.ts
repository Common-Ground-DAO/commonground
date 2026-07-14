// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import errors from "../common/errors";
import messageRouter from "./messages";
import { registerPostRoute } from "./util";
import { allowBotRoute } from "../util/botPrincipal";
import { getBotIdentity } from "../util/botProtocol";

const botV1Router = express.Router();

allowBotRoute('POST', '/BotV1/whoami');

// The public bot protocol is bearer-only. Human management remains on the
// internal /api/v2/Bot surface used by the web application.
botV1Router.use((request, response, next) => {
  if (request.botPrincipal) {
    next();
    return;
  }
  response.status(403).send({ status: 'ERROR', error: errors.server.NOT_ALLOWED });
});

registerPostRoute<API.Bot.whoami.Request, API.Bot.whoami.Response>(
  botV1Router,
  '/whoami',
  undefined,
  request => getBotIdentity(request),
);

botV1Router.use('/messages', messageRouter);

export default botV1Router;
