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
import { createTranslator } from "short-uuid";
import { User } from "../util/express";
import ogs from 'open-graph-scraper';
import fileHelper from "../repositories/files";
import safeFetch from "../util/safeFetch";
import ipRateLimitHandler from "../util/rateLimit";
import redisManager from "../redis";
import { createHash } from "crypto";
import articleHelper from "../repositories/articles";
import botHelper from "../repositories/bots";
import { allowBotRoute } from "../util/botPrincipal";
import { enforceBotRateLimit } from "../util/botRateLimit";
import { requestSockets, senderExcept, type RequestSockets } from "../util/requestSocket";
import callHelper from "../repositories/calls";

const t = createTranslator();

/** Caps for what `/getUrlPreview` will buffer from a caller-supplied URL. */
const URL_PREVIEW_MAX_BYTES = 1_000_000;
const URL_PREVIEW_MAX_IMAGE_BYTES = 8_000_000;
/** Cap for the title and description returned (and cached) per preview. */
const URL_PREVIEW_MAX_TEXT = 2_000;
/** Previews are cached per URL so repeated requests do not refetch. */
const URL_PREVIEW_CACHE_SECONDS = 60 * 60;
/** Longest URL a preview links to; matches the request validator. */
const URL_PREVIEW_MAX_URL = 2048;
/** Serialized previews above this size are returned but not cached. */
const URL_PREVIEW_MAX_CACHED_BYTES = 8 * 1024;

/**
 * The page's `og:url` if it is a usable http(s) link, otherwise the URL the
 * preview was requested for.
 */
function previewLink(ogUrl: string | undefined, requestUrl: string): string {
  if (!ogUrl || ogUrl.length > URL_PREVIEW_MAX_URL) {
    return requestUrl;
  }
  try {
    const parsed = new URL(ogUrl);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return requestUrl;
    }
    const href = parsed.toString();
    return href.length <= URL_PREVIEW_MAX_URL ? href : requestUrl;
  } catch {
    return requestUrl;
  }
}

/**
 * Previews that miss the cache fetch a page and possibly an image, which then
 * runs through image processing; the budget sits well above what typing and
 * pasting links in the composer produces.
 */
const urlPreviewRateLimiter = ipRateLimitHandler({
  windowMs: 1000 * 60, // 1 min
  identity: (req) => req.session?.user?.id,
  limit_identity: 30,
  limit_v4_v6_64: 30,
  limit_v6_56: 60,
  limit_v6_48: 120,
});

const messagingRouter = express.Router();

for (const route of [
  '/loadMessages',
  '/messagesById',
  '/loadUpdates',
  '/createMessage',
  '/setReaction',
  '/unsetReaction',
] as const) {
  allowBotRoute('POST', `/BotV1/messages${route}`);
}

const ARTICLE_ROOM_LIMIT = 5;
/**
 * Socket-scoped article rooms (`session.socketArticleRooms`): at most
 * ARTICLE_ROOM_LIMIT per socket, and at most this many entries per session
 * (entries of closed tabs are never left explicitly). Both are soft bounds:
 * concurrent requests of one session write the session last-write-wins, so
 * an entry can be lost while its socket stays in the room (until it
 * disconnects).
 */
const SESSION_SOCKET_ARTICLE_ROOM_LIMIT = 50;

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
  // Every permission below is evaluated for the community, chat, call or
  // article in the access object, while the message queries use
  // `access.channelId`; both must refer to the same channel.
  const requestingUserId = typeof userIdOrPermissions === 'string' ? userIdOrPermissions : userId;
  if (!(await messageHelper.isChannelInAccessScope(access, requestingUserId))) {
    throw new Error(errors.server.NOT_ALLOWED);
  }

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

type MessageEventExcept = {
  userIds?: string[];
  deviceIds?: string[];
  deviceSockets?: { deviceId: string; socketId: string }[];
};

/**
 * Emits message events to everyone who may read the channel. Callers do not
 * wait for it, so it never rejects: a failed target query is logged (the
 * events of that call are lost to live delivery; clients catch up through
 * `getChanges`).
 */
function emitMessageEvents(events: Events.Message.Message[], access: API.Messages.MessageAccess, excludeObject?: MessageEventExcept): Promise<void> {
  return emitMessageEventsToReaders(events, access, excludeObject).catch(e => {
    console.error("Error emitting message events", e);
  });
}

async function emitMessageEventsToReaders(events: Events.Message.Message[], access: API.Messages.MessageAccess, excludeObject?: MessageEventExcept) {
  if ('communityId' in access) {
    const channelRolePermissions = await communityHelper.getCommunityChannelRolePermissions(access.communityId, access.channelId);
    const notifyRoles = channelRolePermissions.filter(d => (
      d.permissions.includes("CHANNEL_EXISTS") &&
      d.permissions.includes("CHANNEL_READ")
    ));
    const publicRole = notifyRoles.find(d => d.roleTitle === PredefinedRole.Public);
    for (const event of events) {
      const scopedEvent: Events.Message.Message = {
        ...event,
        data: { ...event.data, communityId: access.communityId },
      } as Events.Message.Message;
      if (!!publicRole) {
        eventHelper.emit(scopedEvent, {
          communityIds: [access.communityId],
        }, excludeObject);
      } else {
        eventHelper.emit(scopedEvent, {
          roleIds: notifyRoles.map(d => d.roleId),
        }, excludeObject);
      }
    }
  }
  else if ('callId' in access) {
    // the reader roles, the call's present members who may read its chat
    // (also when that comes from Public) and, when Public may read, the
    // community room (members and visitors): nobody joins a Public role
    // room. One emit, so a socket in several of these rooms gets each event
    // once. Either query may fail on its own: the other targets still get
    // the event.
    const [callRolePermissions, activeMemberUserIds] = await Promise.all([
      communityHelper.getCallRolePermissions(access.callId, access.channelId).catch(e => {
        console.error("Error reading the call's reader roles", e);
        return [] as Awaited<ReturnType<typeof communityHelper.getCallRolePermissions>>;
      }),
      callHelper.getActiveMemberUserIds(access.callId, [CallPermission.CALL_EXISTS, CallPermission.CHANNEL_READ]).catch(e => {
        console.error("Error reading the call's present members", e);
        return [] as string[];
      }),
    ]);
    const notifyRoles = callRolePermissions.filter(d => (
      d.permissions.includes("CALL_EXISTS") &&
      d.permissions.includes("CHANNEL_READ")
    ));
    const publicRole = notifyRoles.find(d => d.roleTitle === PredefinedRole.Public);
    for (const event of events) {
      eventHelper.emit(event, {
        roleIds: notifyRoles.map(d => d.roleId),
        userIds: activeMemberUserIds,
        communityIds: publicRole ? [publicRole.communityId] : [],
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

/**
 * The events of a (soft) delete: one `delete` with every deleted id, its
 * highest `syncSeq` and all of them in `syncSeqs` (a multi-row delete bumps
 * the channel sequence once per row), plus an `update` for every reply whose
 * parent was deleted (`parentMessageId: null`, with its own `syncSeq`).
 */
export function deleteResultEvents(
  channelId: string,
  result: Awaited<ReturnType<typeof messageHelper.deleteMessage>>,
): Events.Message.Message[] {
  const events: Events.Message.Message[] = [];
  if (result.deletedIds.length > 0) {
    events.push({
      type: "cliMessageEvent",
      action: "delete",
      data: {
        channelId,
        deletedIds: result.deletedIds,
        ...(result.deletedSyncSeqs.length > 0 ? {
          syncSeq: result.deletedSyncSeqs.reduce((max, seq) => Math.max(max, seq)),
          syncSeqs: result.deletedSyncSeqs,
        } : {}),
      },
    });
  }
  for (const parent of result.updatedParents) {
    events.push({
      type: "cliMessageEvent",
      action: "update",
      data: {
        id: parent.id,
        channelId,
        parentMessageId: null,
        updatedAt: result.dbNow,
        syncSeq: parent.syncSeq,
      },
    });
  }
  return events;
}

async function createMessage(
  user: User,
  sender: RequestSockets,
  data: API.Messages.createMessage.Request,
  isModerationMessage: boolean,
  creatorIsBot = false,
) {
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
      // a retry of a create whose parent was deleted in the meantime
      const stored = await messageHelper.getOwnStoredMessage(user.id, access.channelId, data.id);
      if (stored) {
        return stored;
      }
      throw new Error(errors.server.NOT_FOUND);
    }
  }

  const { message, userAlias, created } = await messageHelper.createMessage(user.id, data);
  if (!created) {
    // a retry of a create that is stored already: its events and
    // notifications went out with the first one
    return message;
  }

  const event: Events.Message.Message = {
    type: "cliMessageEvent",
    action: "new",
    data: { ...message, creatorIsBot },
  };

  emitMessageEvents([event], access, senderExcept(sender));

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

    return createMessage(user, requestSockets(request, user.deviceId), data, false, !!request.botPrincipal);
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

    return createMessage(user, requestSockets(request, user.deviceId), data, true);
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
        editedAt: result.editedAt,
        syncSeq: result.syncSeq,
      },
    };

    emitMessageEvents([event], data.access, senderExcept(requestSockets(request, user.deviceId)));

    const returnVal: API.Messages.editMessage.Response = {
      editedAt: result.editedAt,
      updatedAt: result.updatedAt,
      syncSeq: result.syncSeq,
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
    // Creator and channel come from the stored message, not from the
    // request; the permission checks below run against that channel.
    const message = await messageHelper.getMessageOwnership(data.messageId);
    if (!message || message.channelId !== access.channelId) {
      throw new Error(errors.server.NOT_FOUND);
    }
    const isOwnMessage = message.creatorId === user.id;
    if ('communityId' in access) {
      const permissions = [
        ChannelPermission.CHANNEL_EXISTS,
        ChannelPermission.CHANNEL_READ,
        ChannelPermission.CHANNEL_WRITE,
      ];
      if (!isOwnMessage) {
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
      if (!isOwnMessage) {
        // user wants to delete another user's message
        permissions.push(CallPermission.CALL_MODERATE);
      }
      await _checkAccessOrThrow(access, permissions, user.id);
    }
    else if ('articleId' in access) {
      if (!isOwnMessage) {
        // user wants to delete another user's message
        throw new Error(errors.server.NOT_ALLOWED);
      }

      await _checkAccessOrThrow(access, [
        ArticlePermission.ARTICLE_READ,
      ], user.id);
    }
    else {
      if (!isOwnMessage) {
        // user wants to delete another user's message
        throw new Error(errors.server.NOT_ALLOWED);
      }
      await _checkAccessOrThrow(access, user.id);
    }

    const result = await messageHelper.deleteMessage({
      messageId: data.messageId,
      channelId: access.channelId,
      creatorId: message.creatorId,
    });
    const events = deleteResultEvents(access.channelId, result);
    if (events.length > 0) {
      emitMessageEvents(events, data.access);
    }
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

    const events = deleteResultEvents(data.access.channelId, result);
    if (events.length > 0) {
      emitMessageEvents(events, access);
    }
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
          syncSeq: result.syncSeq,
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
          syncSeq: result.syncSeq,
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
    const { access } = data;
    await checkMessageReadAccess(access, user.id);
    // the stored value: newer than the posted one if another tab got further
    const { lastRead, unread, syncSeq } = await messageHelper.setChannelLastRead(user.id, data);

    const event: Events.Channel.LastRead = {
      type: 'cliChannelLastRead',
      channelId: access.channelId,
      lastRead,
      unread,
      syncSeq,
    };
    if ('communityId' in access) {
      event.communityId = access.communityId;
    }
    else if ('chatId' in access) {
      event.chatId = access.chatId;
    }
    eventHelper.emit(event, {
      userIds: [user.id],
    });

    return { lastRead, unread, syncSeq };
  }
);

/**
 * chat-sync catch-up of one channel (contract: API.Messages.getChanges).
 * Same read access as `loadMessages`; not on the bot allowlist.
 */
registerPostRoute<
  API.Messages.getChanges.Request,
  API.Messages.getChanges.Response
>(
  messagingRouter,
  '/getChanges',
  validators.API.Message.getChanges,
  async (request, response, data) => {
    const userId = request.session.user?.id;
    await checkMessageReadAccess(data.access, userId);

    return await messageHelper.getChanges(userId, data);
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
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const { url } = data;

    const cacheKey = `urlpreview:${createHash('sha256').update(url).digest('hex')}`;
    // the cache instance is optional: while it is unreachable, previews are
    // simply built uncached instead of waiting for it
    const cached = await redisManager.connectedClient('cache')?.get(cacheKey).catch(() => null);
    if (cached) {
      try {
        return JSON.parse(cached) as API.Messages.getUrlPreview.Response;
      } catch {
        // unreadable entry: rebuild it below
      }
    }

    await urlPreviewRateLimiter(request, response);

    // The page is fetched here rather than by open-graph-scraper, because v6
    // dropped v5's `downloadLimit` (1 MB by default) without a replacement: it
    // buffers the whole response body and runs cheerio over it *before* looking
    // at the content type. safeFetch caps the buffered body instead, and ogs
    // runs on the HTML string.
    let html: string;
    let finalUrl = url;
    try {
      const page = await safeFetch(url, {
        maxBytes: URL_PREVIEW_MAX_BYTES,
        headers: { Accept: 'text/html' },
        acceptContentType: (type) => type === '' || type.startsWith('text/') || type === 'application/xhtml+xml',
      });
      html = page.body.toString('utf-8');
      finalUrl = page.url;
    }
    catch (e) {
      throw new Error(errors.server.INVALID_REQUEST);
    }

    // ogs rejects `html` together with `url`, so relative URLs in the document
    // are resolved here instead of by the library.
    const metadataResult = await ogs({ html });
    if (metadataResult.error) {
      throw new Error(errors.server.INVALID_REQUEST);
    }

    // open-graph-scraper 6 normalises `ogImage` to an `ImageObject[]` — v5
    // could also hand back a bare string or a single object, which is what the
    // removed branches covered. The array can still be empty or absent.
    const rawImageUrl = metadataResult.result.ogImage?.[0]?.url || '';
    let imageUrl = '';
    if (rawImageUrl) {
      try {
        imageUrl = new URL(rawImageUrl, finalUrl).toString();
      }
      catch (e) {
        imageUrl = '';
      }
    }

    let imageId = '';
    if (imageUrl) {
      try {
        const image = await safeFetch(imageUrl, {
          maxBytes: URL_PREVIEW_MAX_IMAGE_BYTES,
          headers: { Accept: 'image/*' },
          acceptContentType: (type) => type.startsWith('image/') || type === 'application/octet-stream',
        });
        const stored = await fileHelper.saveImage(null, { type: 'urlPreviewImage' }, image.body, { width: 250, height: 167 }, { withoutEnlargement: true });
        imageId = stored.fileId;
      } catch (e) {
        console.error('Failed to fetch image preview');
      }
    }

    const result: API.Messages.getUrlPreview.Response = {
      title: (metadataResult.result.ogTitle || '').slice(0, URL_PREVIEW_MAX_TEXT),
      description: (metadataResult.result.ogDescription || metadataResult.result.twitterDescription || '').slice(0, URL_PREVIEW_MAX_TEXT),
      imageId,
      url: previewLink(metadataResult.result.ogUrl, url),
    };
    const serialized = JSON.stringify(result);
    if (Buffer.byteLength(serialized) <= URL_PREVIEW_MAX_CACHED_BYTES) {
      await redisManager.connectedClient('cache')
        ?.set(cacheKey, serialized, { EX: URL_PREVIEW_CACHE_SECONDS })
        .catch((e) => console.error('Could not cache url preview', e));
    }
    return result;
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
      const { articleId } = data.access;
      const sockets = requestSockets(request, user.deviceId);

      if (sockets.socketId !== null) {
        // only the requesting socket: another tab of the device keeps (or
        // never gets) its own article rooms
        const { socketId } = sockets;
        let rooms = (request.session.socketArticleRooms || [])
          .filter(r => r.articleId !== articleId || r.socketId !== socketId);
        const evict = (old: { articleId: string; socketId: string }) => {
          rooms = rooms.filter(r => r !== old);
          eventHelper.requestSocketsLeaveRooms({ deviceId: user.deviceId, socketId: old.socketId }, {
            articleIds: [old.articleId],
          });
        };
        // the limit per socket: the oldest room of this socket goes, other
        // tabs keep theirs
        const own = rooms.filter(r => r.socketId === socketId);
        while (own.length >= ARTICLE_ROOM_LIMIT) {
          evict(own.shift()!);
        }
        // the session's bound: the oldest entries (mostly closed tabs) go
        while (rooms.length >= SESSION_SOCKET_ARTICLE_ROOM_LIMIT) {
          evict(rooms[0]);
        }
        rooms.push({ articleId, socketId });
        request.session.socketArticleRooms = rooms;
        eventHelper.requestSocketsJoinRooms(sockets, {
          articleIds: [articleId],
        });
        return;
      }

      if (request.session.temporaryArticleIds && request.session.temporaryArticleIds.length >= ARTICLE_ROOM_LIMIT) {
        const oldArticleId = request.session.temporaryArticleIds.shift();
        if (oldArticleId) {
          // TODO: Emit leave event for the old article room
          eventHelper.requestSocketsLeaveRooms(sockets, {
            articleIds: [oldArticleId],
          });
        }
      }

      if (!request.session.temporaryArticleIds) {
        request.session.temporaryArticleIds = [];
      }
      request.session.temporaryArticleIds.push(articleId);
      eventHelper.requestSocketsJoinRooms(sockets, {
        articleIds: [articleId],
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
      const sockets = requestSockets(request, user.deviceId);
      if (sockets.socketId !== null) {
        const { socketId } = sockets;
        request.session.socketArticleRooms = request.session.socketArticleRooms
          ?.filter(r => r.articleId !== articleId || r.socketId !== socketId);
      }
      else {
        request.session.temporaryArticleIds = request.session.temporaryArticleIds?.filter(id => id !== articleId);
      }
      eventHelper.requestSocketsLeaveRooms(sockets, {
        articleIds: [articleId],
      });
    }
  }
);

// TODO: Unread count

export default messagingRouter;
