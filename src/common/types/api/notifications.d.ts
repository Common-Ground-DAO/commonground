// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare global {
    namespace API {
        namespace Notification {
            namespace loadNotifications {
                type Request = {
                    order?: 'ASC' | 'DESC';
                    createdBefore?: string;
                    createdAfter?: string;
                    unreadOnly?: boolean;
                };
                type Response = Models.Notification.ApiNotification[];
            }

            namespace loadUpdates {
                type Request = {
                    createdStart: string;
                    createdEnd: string;
                    updatedAfter: string;
                };
                type Response = {
                    updated: Models.Notification.ApiNotification[];
                    deleted: string[];
                };
            }

            namespace getUnreadCount {
                /**
                 * chat-sync: `{ withTime: true }` asks for the object answer.
                 * Older servers ignore the body (the route has no validator)
                 * and answer with the plain count. A validator added on the
                 * new server must keep accepting a call with no body (old
                 * clients) and answer it with the plain count.
                 */
                type Request = undefined | { withTime: true };
                /**
                 * Plain count without `withTime` (and from older servers,
                 * which may send it as a numeric string; `Number()` it). With
                 * `withTime`: the count and the database `now()` (ISO) it was
                 * read at.
                 */
                type Response = number | {
                    unreadCount: number;
                    unreadCountAt: string;
                };
            }

            namespace markAsRead {
                type Request = {
                    notificationId: string;
                };
                type Response = void;
            }

            namespace markAllAsRead {
                type Request = undefined;
                type Response = void;
            }

            namespace getPublicVapidKey {
                type Request = undefined;
                type Response = string;
            }

            namespace registerWebPushSubscription {
                type Request = Models.Notification.PushSubscription;
                type Response = void;
            }

            namespace unregisterWebPushSubscription {
                type Request = undefined;
                type Response = void;
            }

            namespace channelPushNotificationClosed {
                type Request = {
                    channelId: string;
                };
                type Response = void;
            }
        }
    }
}

export { };