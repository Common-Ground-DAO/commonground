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
 * One markAsRead per interaction. A click marks the clicked notification; the
 * route selection marks the selected one; both go through `mark`, so the
 * selection effect that follows a click (desktop: the click navigates to the
 * notification URL) and its re-runs on every list change do not mark again.
 * The last marked id stays remembered on purpose: if the call fails, the
 * store reverts `read`, and the re-run of the selection effect must not turn
 * that into a request loop.
 */
export function createNotificationReadMarking(markAsRead: (notificationId: string) => unknown) {
  let lastMarked: string | undefined;
  return {
    mark(notification: Pick<Models.Notification.Notification, 'id' | 'read'>): void {
      if (notification.read || lastMarked === notification.id) return;
      lastMarked = notification.id;
      markAsRead(notification.id);
    },
  };
}