// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import BaseApiConnector from "./baseConnector";

class NotificationsApiConnector extends BaseApiConnector {
  constructor() {
    super('Notification');
  }

  public async loadNotifications(
    data: API.Notification.loadNotifications.Request
  ): Promise<API.Notification.loadNotifications.Response> {
    return await this.ajax<API.Notification.loadNotifications.Response>(
      "POST",
      '/loadNotifications',
      data
    ); 
  }

  public async loadUpdates(
    data: API.Notification.loadUpdates.Request
  ): Promise<API.Notification.loadUpdates.Response> {
    return await this.ajax<API.Notification.loadUpdates.Response>(
      "POST",
      '/loadUpdates',
      data
    ); 
  }
  
  /**
   * `{ withTime: true }` (chat-sync) answers `{ unreadCount, unreadCountAt }`;
   * without a body, and from older servers, the plain count (possibly a
   * numeric string).
   */
  public async getUnreadCount(
    data?: API.Notification.getUnreadCount.Request
  ): Promise<API.Notification.getUnreadCount.Response> {
    return await this.ajax<API.Notification.getUnreadCount.Response>(
      "POST",
      '/getUnreadCount',
      data
    ); 
  }

  public async markAsRead(
    data: API.Notification.markAsRead.Request
  ): Promise<API.Notification.markAsRead.Response> {
    return await this.ajax<API.Notification.markAsRead.Response>(
      "POST",
      '/markAsRead',
      data
    ); 
  }

  public async markAllAsRead(
    data: API.Notification.markAllAsRead.Request
  ): Promise<API.Notification.markAllAsRead.Response> {
    return await this.ajax<API.Notification.markAllAsRead.Response>(
      "POST",
      '/markAllAsRead',
      data
    ); 
  }

  public async getPublicVapidKey(): Promise<API.Notification.getPublicVapidKey.Response> {
    return await this.ajax<API.Notification.getPublicVapidKey.Response>(
      "POST",
      '/getPublicVapidKey',
    ); 
  }

  public async registerWebPushSubscription(data: API.Notification.registerWebPushSubscription.Request) {
    return await this.ajax<API.Notification.registerWebPushSubscription.Response>(
      "POST",
      '/registerWebPushSubscription',
      data,
    ); 
  }

  public async unregisterWebPushSubscription() {
    return await this.ajax<API.Notification.unregisterWebPushSubscription.Response>(
      "POST",
      '/unregisterWebPushSubscription',
    ); 
  }

  public async channelPushNotificationClosed(data: API.Notification.channelPushNotificationClosed.Request) {
    return await this.ajax<API.Notification.channelPushNotificationClosed.Response>(
      "POST",
      '/channelPushNotificationClosed',
      data,
    ); 
  }
}

const notificationsApi = new NotificationsApiConnector();
export default notificationsApi;