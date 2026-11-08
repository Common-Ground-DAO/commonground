// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md


function includesLowercase(string?: string, included?: string) {
  if (!string) return false;
  if (!included) return true;
  return string.toLocaleLowerCase().includes(included.toLocaleLowerCase());
}

export function filterNotifications(notifications: Models.Notification.Notification[], search: string, data: {
  communities: Record<string, Models.Community.ListView>,
  channels: Models.Community.Channel[],
  userData: Record<string, Models.User.Data | undefined>,
}): Models.Notification.Notification[] {
  return notifications.filter(n => {
    // name
    if (n.subjectUserId) {
      const user = data.userData[n.subjectUserId];
      if (user?.accounts.some(acc => includesLowercase(acc.displayName, search))) return true;
    }

    // excerpt
    if (includesLowercase(n.text, search)) return true;

    // type
    if (includesLowercase(n.type, search)) return true;

    // community
    if (n.subjectCommunityId) {
      const community = data.communities[n.subjectCommunityId] as Models.Community.ListView | undefined;
      if (includesLowercase(community?.title, search)) return true;

    }

    // channel
    if (n.extraData?.channelId) {
      const channel = data.channels.find(c => c.channelId === n.extraData?.channelId)
      if (includesLowercase(channel?.title, search)) return true;
    }

    return false;
  });
};

/**
 * One markAsRead per interaction.
 * - `onClick`: marks the clicked notification unless it is read (a click
 *   after a failed call, which the store reverted to unread, retries).
 * - `onSelected`: the route selection effect; marks the selected one once
 *   per id. It runs after a click too (desktop: the click navigates to the
 *   notification URL) and again on every list change, so it skips the id
 *   marked last, by a click or by itself. That id stays remembered after a
 *   failure on purpose: the effect re-run must not turn it into a request loop.
 * A second call while one is in flight is dropped by the store.
 */
export function createNotificationReadMarking(markAsRead: (notificationId: string) => unknown) {
  let lastMarked: string | undefined;
  type Item = Pick<Models.Notification.Notification, 'id' | 'read'>;
  const send = (notification: Item) => {
    lastMarked = notification.id;
    markAsRead(notification.id);
  };
  return {
    onClick(notification: Item): void {
      if (!notification.read) send(notification);
    },
    onSelected(notification: Item): void {
      if (!notification.read && lastMarked !== notification.id) send(notification);
    },
  };
}
