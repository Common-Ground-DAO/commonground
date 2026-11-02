// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * chat-sync read-state snapshot, mounted at `/Message` next to the message
 * router (srv/api.ts). Session users only: the route is not on the bot
 * allowlist, and a bot principal is refused here as well.
 */

import express from "express";
import errors from "../common/errors";
import { registerPostRoute } from "./util";
import validators from "../validators";
import syncStateHelper from "../repositories/syncState";

const syncStateRouter = express.Router();

registerPostRoute<
  API.Messages.getSyncState.Request,
  API.Messages.getSyncState.Response
>(
  syncStateRouter,
  '/getSyncState',
  validators.API.Message.getSyncState,
  async (request, response, data) => {
    if (request.botPrincipal) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await syncStateHelper.getSyncState(user.id, data);
  }
);

export default syncStateRouter;
