// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import errors from "../common/errors";
import chatHelper from "../repositories/chats";
import eventHelper from "../repositories/event";
import validators from "../validators";
import { registerPostRoute } from "./util";
const chatRouter = express.Router();

registerPostRoute<
  API.Chat.startChat.Request,
  API.Chat.startChat.Response
>(
  chatRouter,
  '/startChat',
  validators.API.Chat.startChat,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const chat = await chatHelper.createChat(user.id, data);

    const event: Events.Chat.Chat = {
      type: "cliChatEvent",
      action: "new",
      data: chat,
    };
    eventHelper.emit(event, {
      userIds: chat.userIds,
    }, {
      deviceIds: [user.deviceId],
    });

    return chat;
  }
);

registerPostRoute<
  API.Chat.closeChat.Request,
  API.Chat.closeChat.Response
>(
  chatRouter,
  '/closeChat',
  validators.API.Chat.closeChat,
  async (request, response, requestData) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const chat = await chatHelper.getChatById(requestData.chatId);
    if (!chat.userIds.includes(user.id) || chat.userIds.length !== 2) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    await chatHelper.closeChat(user.id, requestData.chatId);

    const event: Events.Chat.Chat = {
      type: "cliChatEvent",
      action: "delete",
      data: { id: chat.id },
    };
    eventHelper.emit(event, {
      userIds: chat.userIds,
    }, {
      deviceIds: [user.deviceId],
    });
  }
);

registerPostRoute<
  API.Chat.getChats.Request,
  API.Chat.getChats.Response
>(
  chatRouter,
  '/getChats',
  undefined,
  async (request, response, requestData) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await chatHelper.getChats(user.id);
  }
);

export default chatRouter;