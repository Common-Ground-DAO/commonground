/**
 * Notifications + web-push registration.
 *
 * Contract: srv/api/notifications.ts (all login-gated). Push subscriptions
 * bind to the session's DEVICE; the subscription shape is today's browser
 * PushSubscription JSON. The future publisher-run push gateway (native
 * roadmap) will add a transport discriminator (`webpush|apns|fcm|
 * unifiedpush`) — `PushSubscriptionInput` is the seam where it lands, so
 * SDK consumers won't restructure.
 */

import type { HttpTransport } from "../transport/http.js";

export type NotificationType =
  | "Follower"
  | "Mention"
  | "Reply"
  | "BanState"
  | "DM"
  | "ChannelMessage"
  | "Call"
  | "Approval"
  | "General";

export interface ApiNotification {
  type: NotificationType;
  id: string;
  text: string;
  createdAt: string;
  updatedAt: string;
  read: boolean;
  subjectItemId: string | null;
  subjectCommunityId: string | null;
  subjectUserId: string | null;
  subjectArticleId: string | null;
  extraData: Record<string, unknown> | null;
}

/** Today: web-push only (transport implied). See module note for the
 * planned gateway extension. */
export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime?: number | null;
  keys: { auth: string; p256dh: string };
}

export class NotificationApi {
  constructor(private readonly transport: HttpTransport) {}

  async load(
    options: {
      order?: "ASC" | "DESC";
      createdBefore?: string;
      createdAfter?: string;
      unreadOnly?: boolean;
    } = {},
  ): Promise<ApiNotification[]> {
    return this.transport.call("Notification/loadNotifications", options);
  }

  async loadUpdates(window: {
    createdStart: string;
    createdEnd: string;
    updatedAfter: string;
  }): Promise<{ updated: ApiNotification[]; deleted: string[] }> {
    return this.transport.call("Notification/loadUpdates", window);
  }

  async getUnreadCount(): Promise<number> {
    // The server passes the SQL COUNT through as a string (FINDINGS F-08);
    // normalize so SDK consumers get the number the type promises.
    const count = await this.transport.call<number | string>("Notification/getUnreadCount");
    return Number(count);
  }

  async markAsRead(notificationId: string): Promise<void> {
    await this.transport.call("Notification/markAsRead", { notificationId });
  }

  async markAllAsRead(): Promise<void> {
    await this.transport.call("Notification/markAllAsRead");
  }

  /** The instance's VAPID public key (base64url). */
  async getPublicVapidKey(): Promise<string> {
    return this.transport.call("Notification/getPublicVapidKey");
  }

  /** Register a push subscription for the session's device. */
  async registerWebPushSubscription(subscription: PushSubscriptionInput): Promise<void> {
    await this.transport.call("Notification/registerWebPushSubscription", subscription);
  }

  /** Remove the session device's push subscription. */
  async unregisterWebPushSubscription(): Promise<void> {
    await this.transport.call("Notification/unregisterWebPushSubscription");
  }
}
