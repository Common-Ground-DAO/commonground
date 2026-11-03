// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import errors from "../common/errors";
import validators from "../validators";
import { registerPostRoute } from "./util";
import notificationHelper from "../repositories/notifications";
import eventHelper from "../repositories/event";

const notificationRouter = express.Router();

registerPostRoute<
  API.Notification.loadNotifications.Request,
  API.Notification.loadNotifications.Response
>(
  notificationRouter,
  '/loadNotifications',
  validators.API.Notification.loadNotifications,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await notificationHelper.loadNotifications(user.id, data);
  }
);

registerPostRoute<
  API.Notification.loadUpdates.Request,
  API.Notification.loadUpdates.Response
>(
  notificationRouter,
  '/loadUpdates',
  validators.API.Notification.loadUpdates,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const result = await notificationHelper.loadUpdates(user.id, data);
    const deleted: string[] = [];
    const updated: Models.Notification.ApiNotification[] = [];

    result.forEach(preNotification => {
      const { deletedAt, ...notification } = preNotification;
      if (deletedAt === null) {
        updated.push(notification);
      }
      else {
        deleted.push(notification.id);
      }
    });
    return {
      updated,
      deleted,
    };
  }
);

registerPostRoute<
  API.Notification.getUnreadCount.Request,
  API.Notification.getUnreadCount.Response
>(
  notificationRouter,
  '/getUnreadCount',
  // a call without a body (older clients) is validated as `{}`
  validators.API.Notification.getUnreadCount,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    if (data?.withTime === true) {
      return await notificationHelper.getUnreadCountWithTime(user.id);
    }
    // older clients: the plain count
    return await notificationHelper.getUnreadCount(user.id);
  }
);

registerPostRoute<
  API.Notification.markAsRead.Request,
  API.Notification.markAsRead.Response
>(
  notificationRouter,
  '/markAsRead',
  validators.API.Notification.markAsRead,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const result = await notificationHelper.markAsRead(user.id, data);
    // already read: nothing changed, nothing to tell the other tabs
    if (!result.changed) {
      return;
    }

    const event: Events.Notification.Event = await notificationHelper.withUnreadCount(user.id, {
      type: "cliNotificationEvent",
      action: "update",
      data: {
        id: data.notificationId,
        updatedAt: result.updatedAt,
        read: true,
      },
    });
    await eventHelper.emit(event, {
      userIds: [user.id],
    });
  }
);

registerPostRoute<
  API.Notification.markAllAsRead.Request,
  API.Notification.markAllAsRead.Response
>(
  notificationRouter,
  '/markAllAsRead',
  undefined,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    const result = await notificationHelper.markAllAsRead(user.id);
    // nothing was unread: no event
    if (result.changed === 0 || result.updatedAt === null) {
      return;
    }

    const event: Events.Notification.Event = await notificationHelper.withUnreadCount(user.id, {
      type: "cliNotificationEvent",
      action: "allread",
      data: {
        updatedAt: result.updatedAt,
      },
    });
    await eventHelper.emit(event, {
      userIds: [user.id],
    });
  }
);

registerPostRoute<
  API.Notification.getPublicVapidKey.Request,
  API.Notification.getPublicVapidKey.Response
>(
  notificationRouter,
  '/getPublicVapidKey',
  undefined,
  async (request, response) => {
    return notificationHelper.getPublicVapidKey();
  }
);

registerPostRoute<
  API.Notification.registerWebPushSubscription.Request,
  API.Notification.registerWebPushSubscription.Response
>(
  notificationRouter,
  '/registerWebPushSubscription',
  validators.API.Notification.registerWebPushSubscription,
  async (request, response, data) => {
    const deviceId = request.session.user?.deviceId;
    if (!deviceId) {
      console.error("Currently, only logged in users with a deviceId can register a PushSubscription")
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await notificationHelper.registerWebPushSubscription(data, deviceId);
  }
);

registerPostRoute<
  API.Notification.unregisterWebPushSubscription.Request,
  API.Notification.unregisterWebPushSubscription.Response
>(
  notificationRouter,
  '/unregisterWebPushSubscription',
  undefined,
  async (request, response) => {
    const deviceId = request.session.user?.deviceId;
    if (!deviceId) {
      console.error("Only logged in users with a deviceId can unregister a PushSubscription")
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    return await notificationHelper.unregisterWebPushSubscription(deviceId);
  }
);

registerPostRoute<
  API.Notification.channelPushNotificationClosed.Request,
  API.Notification.channelPushNotificationClosed.Response
>(
  notificationRouter,
  '/channelPushNotificationClosed',
  validators.API.Notification.channelPushNotificationClosed,
  async (request, response, data) => {
    const { user } = request.session;
    if (!user) {
      console.error("Only logged in users with a deviceId can unregister a PushSubscription")
      throw new Error(errors.server.LOGIN_REQUIRED);
    }
    console.warn("/channelPushNotificationClosed is not supported right now since it would interfere with the no-silent-push directive (only notifications that are shown are allowed)")
    // await notificationHelper.sendWsOrWebPushNotificationEvent({
    //   userId: user.id,
    //   event: {
    //     type: 'cliNotificationEvent',
    //     action: 'webpush_channelread',
    //     channelId: data.channelId,
    //   },
    //   excludeDeviceId: user.deviceId,
    // });
  }
);

export default notificationRouter;