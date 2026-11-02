// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The answers for a community or channel the memberlist service has no list
 * for (yet): one created a moment ago is only known after the service's next
 * event batch (up to 1 s). An empty list keeps `getMemberList` and
 * `getChannelMemberList` inside their contract instead of answering with an
 * empty body.
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

export function emptyMemberList(): Models.Community.MemberList {
  return {
    totalCount: 0,
    resultCount: 0,
    roles: [],
    online: [],
    offline: [],
  };
}

/** `list` if it is a member list object, an empty channel member list otherwise (`''`, `null`, `undefined`). */
export function channelMemberListOrEmpty(list: unknown): Models.Community.ChannelMemberList {
  if (typeof list === 'object' && list !== null) {
    return list as Models.Community.ChannelMemberList;
  }
  return emptyChannelMemberList();
}

/** `list` if it is a member list object, an empty community member list otherwise (`''`, `null`, `undefined`). */
export function memberListOrEmpty(list: unknown): Models.Community.MemberList {
  if (typeof list === 'object' && list !== null) {
    return list as Models.Community.MemberList;
  }
  return emptyMemberList();
}
