// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Events {
  namespace Notification {
    type Notification = {
      type: 'cliNotificationEvent';
      /**
       * chat-sync: the user's unread notification count after this change,
       * as a number. Absent on older servers; clients then refresh the count
       * with `Notification/getUnreadCount` instead of counting themselves.
       */
      unreadCount?: number;
      /**
       * chat-sync: database `now()` (ISO) at which `unreadCount` was read;
       * clients keep the count with the newest time
       */
      unreadCountAt?: string;
    } & ({
      action: 'new';
      data: Models.Notification.ApiNotification;
    } | {
      action: 'update';
      data: (
        Pick<Models.Notification.ApiNotification, "id" | "updatedAt"> &
        Partial<Omit<Models.Notification.ApiNotification, "createdAt" | "updatedAt">>
      );
    } | {
      action: 'allread';
      data: {
        updatedAt: string;
      };
    } | {
      action: 'delete';
      id: string | string[];
    });

    type Event = (
      Notification
    );
  }
}