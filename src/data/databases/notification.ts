// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * `data.notification`: a thin façade over the tab's NotificationStore
 * (`chat.notifications`, contract in data/chat/types.ts). Memory + server
 * only: no Dexie cache, no setup timeout. The unread count comes from the
 * server only (login value, `unreadCount` of events, `getUnreadCount`); the
 * store never counts up or down by itself.
 */

import { chat } from 'data/chat/runtime';
import type { ItemWindow, NotificationStore, Unsubscribe } from 'data/chat/types';

export type NotificationFacade = {
  /** always a number (the login value may arrive as a numeric string) */
  readonly unreadCount: number;
  /** multi-subscriber; called on every change of the count */
  subscribeUnreadCount(listener: (count: number) => void): Unsubscribe;
  /** one window on the shared list; call `init({ type: 'recent' })`, `loadOlder()` for more, `destroy()` on unmount */
  openList(): ItemWindow<Models.Notification.Notification>;
  /** no-op when already read or in flight; optimistic; never rejects */
  markAsRead(notificationId: string): Promise<void>;
  /** optimistic; never rejects */
  markAllAsRead(): Promise<void>;
  /** synchronous: takes the login count (number or numeric string) */
  setupAfterLogin(unreadCount: number | string): void;
  /** logout: drops the list and resets the count to 0; open windows get an empty reset */
  clear(): void;
};

/** the façade over a store; `getStore` is called per access so the runtime stays lazy */
export function createNotificationFacade(getStore: () => NotificationStore): NotificationFacade {
  return {
    get unreadCount() {
      return getStore().unreadCount;
    },
    subscribeUnreadCount: listener => getStore().subscribeUnreadCount(listener),
    openList: () => getStore().openList(),
    markAsRead: notificationId => getStore().markAsRead(notificationId),
    markAllAsRead: () => getStore().markAllAsRead(),
    setupAfterLogin: unreadCount => getStore().setupAfterLogin(unreadCount),
    clear: () => getStore().clear(),
  };
}

const notificationDatabase = createNotificationFacade(() => chat.notifications);
export default notificationDatabase;
