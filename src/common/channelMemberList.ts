// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The answer for a channel the memberlist service has no list for (yet): a
 * channel created a moment ago is only known after the service's next event
 * batch. An empty list keeps `getChannelMemberList` inside its contract
 * instead of answering with an empty body.
 */
export function emptyChannelMemberList(): Models.Community.ChannelMemberList {
  return {
    count: 0,
    adminCount: 0,
    moderatorCount: 0,
    writerCount: 0,
    readerCount: 0,
    offlineCount: 0,
    admin: [],
    moderator: [],
    writer: [],
    reader: [],
    offline: [],
  };
}

/** `list` if it is a member list object, an empty member list otherwise (`''`, `null`, `undefined`). */
export function channelMemberListOrEmpty(list: unknown): Models.Community.ChannelMemberList {
  if (typeof list === 'object' && list !== null) {
    return list as Models.Community.ChannelMemberList;
  }
  return emptyChannelMemberList();
}
