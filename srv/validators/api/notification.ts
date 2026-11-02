// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Joi from "joi";
import common from "../common";

const base64UrlString = Joi.string().regex(/^[a-zA-Z0-9-_]+$/);

const notificationApi = {
  loadNotifications: Joi.object<API.Notification.loadNotifications.Request>({
    order: Joi.string().valid('ASC', 'DESC'),
    createdBefore: common.DateString,
    createdAfter: common.DateString,
    unreadOnly: Joi.boolean(),
  }).strict(true).required(),

  loadUpdates: Joi.object<API.Notification.loadUpdates.Request>({
    createdStart: common.DateString.required(),
    createdEnd: common.DateString.required(),
    updatedAfter: common.DateString.required(),
  }).strict(true).required(),

  /**
   * `{ withTime: true }` asks for `{ unreadCount, unreadCountAt }`; a call
   * without a body (older clients) arrives as `{}` and gets the plain count.
   */
  getUnreadCount: Joi.object<{ withTime: true }>({
    withTime: Joi.boolean(),
  }).strict(true).required(),

  markAsRead: Joi.object<API.Notification.markAsRead.Request>({
    notificationId: common.Uuid.required(),
  }).strict(true).required(),

  registerWebPushSubscription: Joi.object<API.Notification.registerWebPushSubscription.Request>({
    endpoint: Joi.string().required(),
    expirationTime: Joi.number().integer().allow(null),
    keys: Joi.object({
      auth: base64UrlString.required(),
      p256dh: base64UrlString.required(),
    }),
  }).strict(true).required(),

  channelPushNotificationClosed: Joi.object<API.Notification.channelPushNotificationClosed.Request>({
    channelId: common.Uuid.required(),
  }).strict(true).required(),
}

export default notificationApi;