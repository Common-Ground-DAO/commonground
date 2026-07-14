// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import errors from "../common/errors";
import { ArticlePermission, CallPermission, ChannelPermission, CommunityPermission, PredefinedRole } from "../common/enums";
import chatHelper from "../repositories/chats";
import communityHelper from "../repositories/communities";
import eventHelper from "../repositories/event";
import messageHelper from "../repositories/messages";
import permissionHelper from "../repositories/permissions";
import validators from "../validators";
import { registerPostRoute } from "./util";
import notificationHelper from "../repositories/notifications";
import shortUUID from "short-uuid";
import { User } from "../util/express";
import ogs from 'open-graph-scraper';
import fileHelper from "../repositories/files";
import axios from "../util/axios";
import articleHelper from "../repositories/articles";
import botHelper from "../repositories/bots";
import { allowBotRoute } from "../util/botPrincipal";
import { enforceBotRateLimit } from "../util/botRateLimit";

const t = shortUUID();

const messagingRouter = express.Router();

for (const route of [
  '/loadMessages',
  '/messagesById',
  '/loadUpdates',
  '/createMessage',
  '/setReaction',
  '/unsetReaction',
] as const) {
  allowBotRoute('POST', `/Message${route}`);
}

const ARTICLE_ROOM_LIMIT = 5;

function isExactCommunityChannelAccess(
  access: API.Messages.MessageAccess,
): access is { communityId: string; channelId: string } {
  const keys = Object.keys(access).sort();
  return keys.length === 2
    && keys[0] === 'channelId'
    && keys[1] === 'communityId'
    && typeof (access as { channelId?: unknown }).channelId === 'string'
    && typeof (access as { communityId?: unknown }).communityId === 'string';
}

async function getMessageRequestUser(
  request: express.Request,
  access: API.Messages.MessageAccess,
  countAsMessage = false,
): Promise<User | undefined> {
  const principal = request.botPrincipal;
  if (!principal) return request.session.user;
  if (!isExactCommunityChannelAccess(access)) {
    throw new Error(errors.server.NOT_ALLOWED);
  }
  await enforceBotRateLimit(principal.tokenId, 'api');
  if (countAsMessage) {
    await enforceBotRateLimit(principal.tokenId, 'message');
  }
  await botHelper.assertActiveCommunityAccess(
    principal.user.id,
    principal.tokenId,
    access.communityId,
  );
  return principal.user;
}

async function checkMessageReadAccess(access: API.Messages.MessageAccess, userId?: string) {
  if ('communityId' in access) {
    await _checkAccessOrThrow(access, [
      ChannelPermission.CHANNEL_EXISTS,
      ChannelPermission.CHANNEL_READ,
    ], userId);
  }
  else if ('callId' in access) {
    await _checkAccessOrThrow(access, [
      CallPermission.CALL_EXISTS,
      CallPermission.CHANNEL_READ,
    ], userId);
  }
  else if ('articleId' in access) {
    await _checkAccessOrThrow(access, [ArticlePermission.ARTICLE_READ], userId);
  }
  else {
    await _checkAccessOrThrow(access, userId);
  }
}

export async function _checkAccessOrThrow(access: { channelId: string, communityId: string }, permissions: ChannelPermission[], userId?: string): Promise<void>;
export async function _checkAccessOrThrow(access: { channelId: string, callId: string }, permissions: CallPermission[], userId?: string): Promise<void>;
export async function _checkAccessOrThrow(access: { channelId: string, articleId: string, articleUserId: string } | { channelId: string, articleId: string, articleCommunityId: string }, permissions: ArticlePermission[], userId?: string): Promise<void>;
export async function _checkAccessOrThrow(access: { channelId: string, chatId: string }, userId?: string): Promise<void>;
export async function _checkAccessOrThrow(access: API.Messages.MessageAccess, userIdOrPermissions?: ArticlePermission[] | ChannelPermission[] | CallPermission[] | string, userId?: string) {
  console.log('checkAccessOrThrow', access);

  if ('communityId' in access && Array.isArray(userIdOrPermissions)) {
    const hasPermissions = await permissionHelper.hasPermissions({
      userId,
      channelId: access.channelId,
      communityId: access.communityId,
      permissions: userIdOrPermissions as ChannelPermission[],
    });
    if (!hasPermissions) {
      if (!userId) {
        throw new Error(errors.server.LOGIN_REQUIRED);
      }
      else {
        throw new Error(errors.server.NOT_ALLOWED);
      }
    }
  }
  else if ('callId' in access && Array.isArray(userIdOrPermissions)) {
    const hasPermissions = await permissionHelper.hasPermissions({
      userId,
      channelId: access.channelId,
      callId: access.callId,
      permissions: userIdOrPermissions as CallPermission[],
    });
    if (!hasPermissions) {
      if (!userId) {
        throw new Error(errors.server.LOGIN_REQUIRED);
      }
      else {
        throw new Error(errors.server.NOT_ALLOWED);
      }
    }
  }
  else if ('chatId' in access) {
    if (typeof userIdOrPermissions !== "string" || !userIdOrPermissions) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const isInChat = await chatHelper.isUserInChat(userIdOrPermissions, access.chatId);
    if (!isInChat) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
  }
  else if ('channelId' in access && Array.isArray(userIdOrPermissions)) {
    if ('communityId' in access) {
      const hasPermissions = await permissionHelper.hasPermissions({
        userId: userId,
        channelId: access.channelId,
        communityId: access.communityId,
        permissions: userIdOrPermissions as ChannelPermission[],
      });
      if (!hasPermissions) {
        if (!userId) {
          throw new Error(errors.server.LOGIN_REQUIRED);
        }
        else {
          throw new Error(errors.server.NOT_ALLOWED);
        }
      }
    } else if ('articleId' in access && 'articleCommunityId' in access) {
      // No need to check for user articles - always allowed af of july 2025
      const hasPermissions = await permissionHelper.hasPermissions({
        userId: userId,
        communityId: access.articleCommunityId,
        articleId: access.articleId,
        permissions: userIdOrPermissions as ArticlePermission[],
      });
      if (!hasPermissions) {
        if (!userId) {
          throw new Error(errors.server.LOGIN_REQUIRED);
        }
        else {
          throw new Error(errors.server.NOT_ALLOWED);
        }
      }
    }
  } else {
    throw new Error(errors.server.INVALID_REQUEST);
  }
}

async function emitMessageEvents(events: Events.Message.Message[], access: API.Messages.MessageAccess, excludeObject?: {
  userIds?: string[];
  deviceIds?: string[];
}) {
  if ('communityId' in access) {
    const channelRolePermissions = await communityHelper.getCommunityChannelRolePermissions(access.communityId, access.channelId);
    const notifyRoles = channelRolePermissions.filter(d => (
      d.permissions.includes("CHANNEL_EXISTS") &&
      d.permissions.includes("CHANNEL_READ")
    ));
    const publicRole = notifyRoles.find(d => d.roleTitle === PredefinedRole.Public);
    for (const event of events) {
      if (!!publicRole) {
        eventHelper.emit(event, {
          communityIds: [access.communityId],
        }, excludeObject);
      } else {
        eventHelper.emit(event, {
          roleIds: notifyRoles.map(d => d.roleId),
        }, excludeObject);
      }
    }
  }
  else if ('callId' in access) {
    // Todo: only send to call participants
    const callRolePermissions = await communityHelper.getCallRolePermissions(access.callId, access.channelId);
    const notifyRoles = callRolePermissions.filter(d => (
      d.permissions.includes("CALL_EXISTS") &&
      d.permissions.includes("CHANNEL_READ")
    ));
    for (const event of events) {
      eventHelper.emit(event, {
        roleIds: notifyRoles.map(d => d.roleId),
      }, excludeObject);
    }
  }
  else if ('chatId' in access) {
    const chat = await chatHelper.getChatById(access.chatId);
    for (const event of events) {
      eventHelper.emit(event, {
        userIds: chat.userIds,
      }, excludeObject);
    }
  }
  else if ('articleId' in access) {
    for (const event of events) {
      eventHelper.emit(event, {
        articleIds: [access.articleId],
      }, excludeObject);
    }
  }
  else {
    throw new Error("Incorrect access object");
  }
}

async function createMessage(user: User, data: API.Messages.createMessage.Request, isModerationMessage: boolean) {
  let channelMessageNotificationData: Awaited<ReturnType<typeof messageHelper.getChannelMessageNotifyData>> = [];
  const { access } = data;
  if ('callId' in access) {
    const callData = await communityHelper.getCallDataById(access.callId);
    if (!callData) {
      throw new Error(errors.server.NOT_FOUND);
    }
    else if (callData.endedAt !== null) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
    else {
      const blockState = await communityHelper.getUserBlockState(user.id, callData.communityId);
      if (blockState !== null) {
        throw new Error(errors.server.NOT_ALLOWED);
      }
    }
    await _checkAccessOrThrow(access, [
      CallPermission.CALL_EXISTS,
      CallPermission.CHANNEL_READ,
      CallPermission.CHANNEL_WRITE,
    ], user.id);
    if (isModerationMessage) {
      await permissionHelper.hasPermissionsOrThrow({
        userId: user.id,
        communityId: callData.communityId,
        permissions: [
          CommunityPermission.COMMUNITY_MODERATE,
        ],
      });
    }
  }
  else if ('communityId' in access) {
    await _checkAccessOrThrow(access, [
      ChannelPermission.CHANNEL_EXISTS,
      ChannelPermission.CHANNEL_READ,
      ChannelPermission.CHANNEL_WRITE,
    ], user.id);
    const blockState = await communityHelper.getUserBlockState(user.id, access.communityId);
    if (blockState !== null) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
    if (isModerationMessage) {
      await permissionHelper.hasPermissionsOrThrow({
        userId: user.id,
        communityId: access.communityId,
        permissions: [
          CommunityPermission.COMMUNITY_MODERATE,
        ],
      });
    }
    channelMessageNotificationData = await messageHelper.getChannelMessageNotifyData({ channelId: access.channelId });
  }
  else if ('chatId' in access) {
    if (isModerationMessage) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
    await _checkAccessOrThrow(access, user.id);
  }
  else if ('articleId' in access) {
    await _checkAccessOrThrow(access, [
      ArticlePermission.ARTICLE_READ,
    ], user.id);

    
    if ('articleCommunityId' in access) {
      const isMember = await communityHelper.isCommunityMember(user.id, access.articleCommunityId);
      if (!isMember) {
        throw new Error(errors.server.NOT_ALLOWED);
      }

      const blockState = await communityHelper.getUserBlockState(user.id, access.articleCommunityId);
      if (blockState !== null) {
        throw new Error(errors.server.NOT_ALLOWED);
      }
    }
  }
  else {
    throw new Error('Invalid access object');
  }

  let parentMessage: Models.Message.ApiMessage | undefined;
  if (data.parentMessageId !== null) {
    parentMessage = (await messageHelper.loadMessagesById(user.id, {
      access,
      messageIds: [data.parentMessageId],
    }))[0];
    if (!parentMessage) {
      throw new Error(errors.server.NOT_FOUND);
    }
  }

  const { message, userAlias } = await messageHelper.createMessage(user.id, data);

  const event: Events.Message.Message = {
    type: "cliMessageEvent",
    action: "new",
    data: message,
  };

  emitMessageEvents([event], access, { deviceIds: [user.deviceId] });

  let notifications: (Omit<Models.Notification.ApiNotification, "id" | "createdAt" | "updatedAt" | "read"> & { userId: string })[] = [];
  const previewText = message.body.content.reduce<string[]>((agg, val) => {
    if (
      val.type === "link" ||
      val.type === "text" ||
      val.type === "tag" ||
      val.type === "richTextLink"
    ) {
      agg.push(val.value);
    }
    else if (val.type === "mention" && !!val.alias) {
      agg.push(val.alias);
    }
    return agg;
  }, []);
  let notificationText = previewText.join(' ');
  if (notificationText.length > 100) {
    notificationText = `${notificationText.slice(0, 100)}...`;
  }
  const notifiedUsers: Set<string> = new Set();

  if (!!parentMessage) {
    // is a reply
    if ('communityId' in access && !notifiedUsers.has(parentMessage.creatorId) && parentMessage.creatorId !== user.id) {
      notifiedUsers.add(parentMessage.creatorId);
      const notification: typeof notifications[0] = {
        type: 'Reply',
        userId: parentMessage.creatorId,
        subjectCommunityId: access.communityId,
        subjectItemId: message.id,
        subjectUserId: user.id,
        subjectArticleId: null,
        text: notificationText,
        extraData: {
          type: 'channelData',
          channelId: data.access.channelId,
          userAlias,
        }
      };
      notifications.push(notification);
    }

    if ('articleId' in access && !notifiedUsers.has(parentMessage.creatorId) && parentMessage.creatorId !== user.id) {
      let article: API.Community.getArticleList.Response[number] | API.User.getArticleList.Response[number] | null = null;
      if ('articleCommunityId' in access) {
        [article] = await articleHelper.getCommunityArticleList(user.id, { ids: [access.articleId], limit: 1 });
      } else if ('articleUserId' in access) {
        [article] = await articleHelper.getUserArticleList(user.id, { ids: [access.articleId], limit: 1 });
      }

      if (article) {
        notifiedUsers.add(parentMessage.creatorId);

        const notification: typeof notifications[0] = {
          type: 'Reply',
          userId: parentMessage.creatorId,
          subjectCommunityId: null,
          subjectItemId: message.id,
          subjectUserId: user.id,
          subjectArticleId: access.articleId,
          text: notificationText,
          extraData: {
            type: 'articleData',
            articleId: access.articleId,
            articleTitle: article?.article.title,
            articleOwner: 'communityArticle' in article ? {
              type: 'community',
              communityId: article.communityArticle.communityId,
            } : {
              type: 'user',
              userId: article?.userArticle.userId,
            }
          }
        };
        notifications.push(notification);
      }
    }
  }

  if ('chatId' in access) {
    const chat = await chatHelper.getChatByChannelId(access.channelId);
    if (!!chat) {
      const otherUserIds = chat.userIds.filter(id => id !== user.id);
      for (const otherUserId of otherUserIds) {
        if (notifiedUsers.has(otherUserId)) continue;
        notifiedUsers.add(otherUserId);

        const notification: typeof notifications[0] = {
          type: 'DM',
          userId: otherUserId,
          subjectCommunityId: null,
          subjectItemId: message.id,
          subjectUserId: message.creatorId,
          subjectArticleId: null,
          text: notificationText,
          extraData: {
            type: 'chatData',
            chatId: access.chatId,
            channelId: data.access.channelId,
            userAlias,
          }
        };
        notifications.push(notification);
      }
    }
  }

  const createsNotification = data.body.content.filter(item => {
    return item.type === "mention";
  });
  for (const item of createsNotification) {
    if (item.type === "mention") {
      if (notifiedUsers.has(item.userId) || item.userId === user.id) continue;
      notifiedUsers.add(item.userId);

      if ('communityId' in access) {
        const notification: typeof notifications[0] = {
          type: 'Mention',
          userId: item.userId,
          subjectCommunityId: access.communityId,
          subjectItemId: message.id,
          subjectUserId: user.id,
          subjectArticleId: null,
          text: notificationText,
          extraData: {
            type: 'channelData',
            channelId: access.channelId,
            userAlias,
          }
        };
        notifications.push(notification);
      }
    }
  }

  if ('communityId' in access) {
    const userIds = Array.from(new Set(notifications.map(n => n.userId)));
    const usersInCommunityArray = await communityHelper.areUsersCommunityMembers(userIds, access.communityId);
    const usersInCommunity = new Set(usersInCommunityArray.filter(d => d.isInCommunity === true).map(d => d.userId));
    // only create notifications for users
    // who really are in the community
    notifications = notifications.filter(n => usersInCommunity.has(n.userId));

    for (const channelNotificationData of channelMessageNotificationData) {
      for (const notifyUserId of channelNotificationData.userIds) {
        if (!notifiedUsers.has(notifyUserId) && notifyUserId !== message.creatorId) {
          notifiedUsers.add(notifyUserId);
          const notification: typeof notifications[0] = {
            type: 'ChannelMessage',
            userId: notifyUserId,
            subjectCommunityId: access.communityId,
            subjectItemId: message.id,
            subjectUserId: message.creatorId,
            subjectArticleId: null,
            text: notificationText,
            extraData: {
              type: 'channelDetailData',
              communityId: channelNotificationData.communityId,
              communityUrl: channelNotificationData.communityUrl,
              communityTitle: channelNotificationData.communityTitle,
              channelId: channelNotificationData.channelId,
              channelUrl: channelNotificationData.channelUrl,
              channelTitle: channelNotificationData.channelTitle,
              userAlias,
            }
          };
          notifications.push(notification);
        }
      }
    }
  }

  if (notifications.length > 0) {
    // create and emit notifications
    const notificationsWithoutDms = notifications.filter(notification => (
      notification.type === 'Mention' ||
      notification.type === 'Reply' ||
      notification.type === 'Follower'
    ));
    const result = await notificationHelper.createNotifications(notificationsWithoutDms);
    const apiNotifications: (Models.Notification.ApiNotification & { userId: string })[] = notificationsWithoutDms.map((n, i) => {
      const missing = result[i];
      return {
        ...n,
        ...missing,
        read: false,
      };
    });
    const dmDate = (new Date()).toISOString();
    // add notifications for missing DMs
    for (const notification of notifications) {
      if (notification.type === 'DM' || notification.type === 'ChannelMessage') {
        apiNotifications.push({
          ...notification,
          id: t.uuid(),
          createdAt: dmDate,
          updatedAt: dmDate,
          read: false,
        });
      }
    }
    for (const apiNotification of apiNotifications) {
      const { userId, ...notificationData } = apiNotification;
      eventHelper.sendWsOrWebPushNotificationEvent({
        userId,
        event: {
          type: 'cliNotificationEvent',
          action: 'new',
          data: notificationData,
        }
      });
    }
  }

  return message;
}

registerPostRoute<
  API.Messages.createMessage.Request,
  API.Messages.createMessage.Response
>(
  messagingRouter,
  '/createMessage',
  validators.API.Message.createMessage,
  async (request, response, data) => {
    const user = await getMessageRequestUser(request, data.access, true);
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasTrustOrThrow({ userId: user.id, trust: '1.0' });

    return createMessage(user, data, false);
  }
);

registerPostRoute<
  API.Messages.createMessage.Request,
  API.Messages.createMessage.Response
>(
  messagingRouter,
  '/createModerationMessage',
  validators.API.Message.createModerationMessage,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasTrustOrThrow({ userId: user.id, trust: '1.0' });

    return createMessage(user, data, true);
  }
);

registerPostRoute<
  API.Messages.editMessage.Request,
  API.Messages.editMessage.Response
>(
  messagingRouter,
  '/editMessage',
  validators.API.Message.editMessage,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const { access } = data;
    if ('communityId' in access) {
      await _checkAccessOrThrow(access, [
        ChannelPermission.CHANNEL_EXISTS,
        ChannelPermission.CHANNEL_READ,
        ChannelPermission.CHANNEL_WRITE
      ], user.id);
    }
    else if ('callId' in access) {
      await _checkAccessOrThrow(access, [
        CallPermission.CALL_EXISTS,
        CallPermission.CHANNEL_READ,
        CallPermission.CHANNEL_WRITE,
      ], user.id);
    }
    else if ('articleId' in access) {
      await _checkAccessOrThrow(access, [
        ArticlePermission.ARTICLE_READ,
      ], user.id);
    }
    else {
      await _checkAccessOrThrow(access, user.id);
    }

    const result = await messageHelper.editMessage(user.id, data);
    const { id, ...updateData } = data;
    const event: Events.Message.Message = {
      type: "cliMessageEvent",
      action: "update",
      data: {
        ...updateData,
        id,
        channelId: access.channelId,
        updatedAt: result.updatedAt,
      },
    };

    emitMessageEvents([event], data.access, { deviceIds: [user.deviceId] });

    const returnVal: API.Messages.editMessage.Response = {
      editedAt: result.editedAt,
    }
    if (updateData.attachments) {
      returnVal.attachments = updateData.attachments;
    }

    return returnVal;
  }
);

registerPostRoute<
  API.Messages.deleteMessage.Request,
  API.Messages.deleteMessage.Response
>(
  messagingRouter,
  '/deleteMessage',
  validators.API.Message.deleteMessage,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const { access } = data;
    if ('communityId' in access) {
      const permissions = [
        ChannelPermission.CHANNEL_EXISTS,
        ChannelPermission.CHANNEL_READ,
        ChannelPermission.CHANNEL_WRITE,
      ];
      if (data.creatorId !== user.id) {
        // user wants to delete another user's message
        permissions.push(ChannelPermission.CHANNEL_MODERATE);
      }
      await _checkAccessOrThrow(access, permissions, user.id);
    }
    else if ('callId' in access) {
      const permissions = [
        CallPermission.CALL_EXISTS,
        CallPermission.CHANNEL_READ,
        CallPermission.CHANNEL_WRITE,
      ];
      if (data.creatorId !== user.id) {
        // user wants to delete another user's message
        permissions.push(CallPermission.CALL_MODERATE);
      }
      await _checkAccessOrThrow(access, permissions, user.id);
    }
    else if ('articleId' in access) {
      if (data.creatorId !== user.id) {
        // user wants to delete another user's message
        throw new Error(errors.server.NOT_ALLOWED);
      }

      await _checkAccessOrThrow(access, [
        ArticlePermission.ARTICLE_READ,
      ], user.id);
    }
    else {
      if (data.creatorId !== user.id) {
        // user wants to delete another user's message
        throw new Error(errors.server.NOT_ALLOWED);
      }
      await _checkAccessOrThrow(access, user.id);
    }

    const result = await messageHelper.deleteMessage(user.id, data);
    const events: Events.Message.Message[] = [{
      type: "cliMessageEvent",
      action: "delete",
      data: {
        channelId: access.channelId,
        deletedIds: [data.messageId],
      },
    }];

    if (!!result && result.updatedParentIdToNull.length > 0) {
      result.updatedParentIdToNull.forEach(messageId => {
        events.push({
          type: "cliMessageEvent",
          action: "update",
          data: {
            id: messageId,
            channelId: access.channelId,
            parentMessageId: null,
            updatedAt: result.dbNow,
          },
        });
      })
    }

    emitMessageEvents(events, data.access);
  }
);

registerPostRoute<
  API.Messages.deleteAllUserMessages.Request,
  API.Messages.deleteAllUserMessages.Response
>(
  messagingRouter,
  '/deleteAllUserMessages',
  validators.API.Message.deleteAllUserMessages,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const { access } = data;
    if ('communityId' in access) {
      const permissions = [
        ChannelPermission.CHANNEL_EXISTS,
        ChannelPermission.CHANNEL_READ,
        ChannelPermission.CHANNEL_WRITE,
        ChannelPermission.CHANNEL_MODERATE,
      ];
      await _checkAccessOrThrow(access, permissions, user.id);

    } else {
      throw new Error("Not yet supported for chats");
    }

    const result = await messageHelper.deleteAllUserMessages(data);

    const events: Events.Message.Message[] = [];
    events.push({
      type: "cliMessageEvent",
      action: "delete",
      data: {
        channelId: data.access.channelId,
        deletedIds: result.deletedIds,
      },
    });
    for (const updatedMessageId of result.updatedParentIdToNull) {
      events.push({
        type: "cliMessageEvent",
        action: "update",
        data: {
          channelId: data.access.channelId,
          id: updatedMessageId,
          updatedAt: result.dbNow,
          parentMessageId: null,
        },
      });
    }

    emitMessageEvents(events, access);
  }
);

registerPostRoute<
  API.Messages.loadMessages.Request,
  API.Messages.loadMessages.Response
>(
  messagingRouter,
  '/loadMessages',
  validators.API.Message.loadMessages,
  async (request, response, data) => {
    const user = await getMessageRequestUser(request, data.access);
    const { access } = data;
    await checkMessageReadAccess(access, user?.id);

    return await messageHelper.loadMessages(user?.id, data);
  }
)

registerPostRoute<
  API.Messages.messagesById.Request,
  API.Messages.messagesById.Response
>(
  messagingRouter,
  '/messagesById',
  validators.API.Message.messagesById,
  async (request, response, data) => {
    const user = await getMessageRequestUser(request, data.access);
    const { access } = data;
    await checkMessageReadAccess(access, user?.id);

    return await messageHelper.loadMessagesById(user?.id, data);
  }
);

registerPostRoute<
  API.Messages.loadUpdates.Request,
  API.Messages.loadUpdates.Response
>(
  messagingRouter,
  '/loadUpdates',
  validators.API.Message.loadUpdates,
  async (request, response, data) => {
    const user = await getMessageRequestUser(request, data.access);
    const { access } = data;
    await checkMessageReadAccess(access, user?.id);

    return await messageHelper.loadMessageUpdates(user?.id, data);
  }
);

registerPostRoute<
  API.Messages.setReaction.Request,
  API.Messages.setReaction.Response
>(
  messagingRouter,
  '/setReaction',
  validators.API.Message.setReaction,
  async (request, response, data) => {
    const user = await getMessageRequestUser(request, data.access);
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await permissionHelper.hasTrustOrThrow({ userId: user.id, trust: '1.0' });

    const { access } = data;
    await checkMessageReadAccess(access, user.id);

    const result = await messageHelper.setReaction(user.id, data);

    if (!!result) {
      const event: Events.Message.Event = {
        type: "cliMessageEvent",
        action: "update",
        data: {
          channelId: access.channelId,
          id: data.messageId,
          updatedAt: result.updatedAt,
          reactions: result.reactions,
        },
      };
      emitMessageEvents([event], access, { userIds: [user.id] });
      const userEvent = {
        ...event,
        data: {
          ...event.data,
          ownReaction: data.reaction,
        }
      };
      eventHelper.emit(userEvent, {
        userIds: [user.id],
      });
    }
  }
);

registerPostRoute<
  API.Messages.unsetReaction.Request,
  API.Messages.unsetReaction.Response
>(
  messagingRouter,
  '/unsetReaction',
  validators.API.Message.unsetReaction,
  async (request, response, data) => {
    const user = await getMessageRequestUser(request, data.access);
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const { access } = data;
    await checkMessageReadAccess(access, user.id);
    const result = await messageHelper.unsetReaction(user.id, data);

    if (!!result) {
      const event: Events.Message.Event = {
        type: "cliMessageEvent",
        action: "update",
        data: {
          channelId: access.channelId,
          id: data.messageId,
          updatedAt: result.updatedAt,
          reactions: result.reactions,
        },
      };
      emitMessageEvents([event], access, { userIds: [user.id] });
      const userEvent = {
        ...event,
        data: {
          ...event.data,
          ownReaction: null,
        }
      };
      eventHelper.emit(userEvent, {
        userIds: [user.id],
      });
    }
  }
);

registerPostRoute<
  API.Messages.setChannelLastRead.Request,
  API.Messages.setChannelLastRead.Response
>(
  messagingRouter,
  '/setChannelLastRead',
  validators.API.Message.setChannelLastRead,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    await messageHelper.setChannelLastRead(user.id, data);

    const event: Events.Channel.LastRead = {
      type: 'cliChannelLastRead',
      channelId: data.access.channelId,
      lastRead: data.lastRead,
    };
    eventHelper.emit(event, {
      userIds: [user.id],
    });
  }
);

registerPostRoute<
  API.Messages.getUrlPreview.Request,
  API.Messages.getUrlPreview.Response
>(
  messagingRouter,
  '/getUrlPreview',
  validators.API.Message.getUrlPreview,
  async (request, response, data) => {
    const { url } = data;
    const metadataResult = await ogs({ url });
    if (metadataResult.error) {
      throw new Error(errors.server.INVALID_REQUEST);
    }

    let imageUrl: string;
    const { ogImage } = metadataResult.result;
    if (typeof ogImage === 'string') {
      imageUrl = ogImage;
    } else if (Array.isArray(ogImage)) {
      imageUrl = ogImage[0].url;
    } else {
      imageUrl = ogImage?.url || '';
    }

    let imageId = '';
    if (imageUrl) {
      try {
        const imageResponse = await axios.get(imageUrl, { responseType: 'arraybuffer' });
        if (imageResponse.status === 200) {
          const buffer = Buffer.from(imageResponse.data, "utf-8");
          const image = await fileHelper.saveImage(null, { type: 'urlPreviewImage' }, buffer, { width: 250, height: 167 }, { withoutEnlargement: true });
          imageId = image.fileId;
        }
      } catch (e) {
        console.error('Failed to fetch image preview');
      }
    }

    return {
      title: metadataResult.result.ogTitle || '',
      description: metadataResult.result.ogDescription || metadataResult.result.twitterDescription || '',
      imageId,
      url: metadataResult.result.ogUrl || url
    }
  }
);

registerPostRoute<
  API.Messages.joinArticleEventRoom.Request,
  API.Messages.joinArticleEventRoom.Response
>(
  messagingRouter,
  '/joinArticleEventRoom',
  validators.API.Message.joinArticleEventRoom,
  async (request, response, data) => {
    const { user } = request.session;
    if ('articleId' in data.access && user?.deviceId) {
      await _checkAccessOrThrow(data.access, [
        ArticlePermission.ARTICLE_READ,
      ], user.id);

      if (request.session.temporaryArticleIds && request.session.temporaryArticleIds.length >= ARTICLE_ROOM_LIMIT) {
        const oldArticleId = request.session.temporaryArticleIds.shift();
        if (oldArticleId) {
          // TODO: Emit leave event for the old article room
          eventHelper.deviceLeaveRooms(user.deviceId, {
            articleIds: [oldArticleId],
          });
        }
      }

      if (!request.session.temporaryArticleIds) {
        request.session.temporaryArticleIds = [];
      }
      request.session.temporaryArticleIds.push(data.access.articleId);
      eventHelper.deviceJoinRooms(user.deviceId, {
        articleIds: [data.access.articleId],
      });
    }
  }
);
registerPostRoute<
  API.Messages.leaveArticleEventRoom.Request,
  API.Messages.leaveArticleEventRoom.Response
>(
  messagingRouter,
  '/leaveArticleEventRoom',
  validators.API.Message.leaveArticleEventRoom,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    if ('articleId' in data.access) {
      await _checkAccessOrThrow(data.access, [
        ArticlePermission.ARTICLE_READ,
      ], user.id);
      const articleId = data.access.articleId;
      request.session.temporaryArticleIds = request.session.temporaryArticleIds?.filter(id => id !== articleId);
      eventHelper.deviceLeaveRooms(user.deviceId, {
        articleIds: [data.access.articleId],
      });
    }
  }
);

// TODO: Unread count

export default messagingRouter;
