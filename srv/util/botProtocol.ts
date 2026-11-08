// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type express from "express";
import errors from "../common/errors";
import { enforceBotRateLimit } from "./botRateLimit";
import { BOT_PROTOCOL_VERSION } from "../common/botProtocol";

export async function getBotIdentity(request: express.Request): Promise<API.Bot.whoami.Response> {
  const principal = request.botPrincipal;
  if (!principal) throw new Error(errors.server.NOT_ALLOWED);
  await enforceBotRateLimit(principal.tokenId, 'api');
  return {
    protocolVersion: BOT_PROTOCOL_VERSION,
    userId: principal.user.id,
    deviceId: principal.user.deviceId,
    tokenId: principal.tokenId,
  };
}
