// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import errors from "../common/errors";
import chatHelper from "../repositories/chats";
import eventHelper from "../repositories/event";
import validators from "../validators";
import { registerPostRoute } from "./util";
import assistantTemplates from '../assistant/templates';
import assistantQueue, { Priority } from '../assistant/queue';
import { userPremiumState } from "../assistant/data/user";
import { createDialogItem, deleteDialogItem, getDialogItem, getDialogList, updateDialogItem } from "../assistant/data/dialog";
import { getCommunityExtraData } from "../assistant/data/community";
import { getUserExtraData } from "../assistant/data/user";
import { getModelAvailability } from "../assistant/data/assistant";
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

registerPostRoute<
  API.Chat.getOwnAssistantChats.Request,
  API.Chat.getOwnAssistantChats.Response
>(
  chatRouter,
  '/getOwnAssistantChats',
  validators.API.Chat.getOwnAssistantChats,
  async (request, response, requestData) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await getDialogList({
      userId: user.id,
      communityId: requestData.type === 'community' ? requestData.communityId : null,
    });
  }
);

registerPostRoute<
  API.Chat.loadAssistantChat.Request,
  API.Chat.loadAssistantChat.Response
>(
  chatRouter,
  '/loadAssistantChat',
  validators.API.Chat.loadAssistantChat,
  async (request, response, requestData) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const { dialogId } = requestData;
    const dialog = await getDialogItem({
      userId: user.id,
      dialogId
    });
    const messages = dialog.request.messages.filter(message => message.role !== 'system' && message.role !== 'tool') as Assistant.Message[];
    return {
      model: dialog.model,
      messages,
    };
  }
);

registerPostRoute<
  API.Chat.startAssistantChat.Request,
  API.Chat.startAssistantChat.Response
>(
  chatRouter,
  '/startAssistantChat',
  validators.API.Chat.startAssistantChat,
  async (request, response, requestData) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const { template: templateName, message } = requestData;
    let template: Assistant.Request | undefined;
    const userExtraData = await getUserExtraData(user.id);
    switch (templateName) {
      case 'community_v1':
        if (!requestData.communityId) {
          throw new Error(errors.server.INVALID_REQUEST);
        }
        const communityExtraData = await getCommunityExtraData(user.id, requestData.communityId);
        if (!communityExtraData) {
          throw new Error(errors.server.NOT_FOUND);
        }
        template = assistantTemplates["community_v1"](userExtraData, communityExtraData, requestData.model);
        break;
      case 'user_v1':
        // Todo: Implement user template and add extraData
        template = assistantTemplates["user_v1"](userExtraData, requestData.model);
        break;
    }
    if (!template) {
      throw new Error(`Template ${templateName} not found`);
    }
    const assistantRequest: Assistant.Request = {
      model: requestData.model,
      messages: [...template.messages, {
        role: 'user',
        content: message,
      }],
      tools: template.tools,
      extraData: template.extraData,
    };

    const premiumState = await userPremiumState(user.id);
    let priority: 0 | 1 | 2 | 3 = 0;
    if (premiumState === 'silver') {
      priority = 1;
    }
    else if (premiumState === 'free') {
      priority = 2;
    }
    const { dialogId, createdAt } = await createDialogItem({
      userId: user.id,
      communityId: requestData.template === 'community_v1' ? requestData.communityId : null,
      request: assistantRequest
    });
    const queueData = await assistantQueue.addQueueItem({
      request: assistantRequest,
      dialogId,
      userId: user.id,
      deviceId: user.deviceId,
      priority
    });
    return {
      dialogId,
      queueData,
      createdAt,
    };
  }
);

registerPostRoute<
  API.Chat.continueAssistantChat.Request,
  API.Chat.continueAssistantChat.Response
>(
  chatRouter,
  '/continueAssistantChat',
  validators.API.Chat.continueAssistantChat,
  async (request, response, requestData) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const { dialogId, message } = requestData;
    const { request: assistantRequest } = await getDialogItem({
      userId: user.id,
      dialogId
    });
    assistantRequest.messages.push({
      role: 'user',
      content: message,
    });
    const premiumState = await userPremiumState(user.id);
    let priority: 0 | 1 | 2 | 3 | 4 = 0;
    if (premiumState === 'silver') {
      priority = 1;
    }
    else if (premiumState === 'free') {
      priority = 2;
    }
    await updateDialogItem({
      userId: user.id,
      request: assistantRequest,
      dialogId
    });
    const queueData = await assistantQueue.addQueueItem({
      request: assistantRequest,
      dialogId,
      userId: user.id,
      deviceId: user.deviceId,
      priority
    });
    return {
      dialogId,
      queueData,
    };
  }
);

registerPostRoute<
  API.Chat.deleteAssistantChat.Request,
  API.Chat.deleteAssistantChat.Response
>(
  chatRouter,
  '/deleteAssistantChat',
  validators.API.Chat.deleteAssistantChat,
  async (request, response, requestData) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await deleteDialogItem({
      userId: user.id,
      dialogId: requestData.dialogId,
    });
  }
);

registerPostRoute<
  API.Chat.getAssistantQueueData.Request,
  API.Chat.getAssistantQueueData.Response
>(
  chatRouter,
  '/getAssistantQueueData',
  validators.API.Chat.getAssistantQueueData,
  async (request, response, requestData) => {
    return await assistantQueue.getQueueData({
      priority: requestData.ownPriority as Priority,
      score: requestData.ownScore,
      model: requestData.model,
    });
  }
);

registerPostRoute<
  API.Chat.getAssistantAvailability.Request,
  API.Chat.getAssistantAvailability.Response
>(
  chatRouter,
  '/getAssistantAvailability',
  undefined,
  async (request, response, requestData) => {
    const assistants = await getModelAvailability();
    return {
      assistants: assistants.map(assistant => ({
        modelName: assistant.modelName,
        title: assistant.title,
        isAvailable: assistant.isAvailable,
      })),
    };
  }
);

export default chatRouter;