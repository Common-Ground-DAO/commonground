// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The memberlist service's community member list window and preview, driven
 * through `memberListForTests` (events queued and processed as the service
 * does every second). Ids are opaque strings here.
 *
 * - `getMemberListWindow` (no search, no role filter) lists the online
 *   members first, then the offline ones, each by display name.
 * - `getMemberListPreview` answers the first members by display name (ties
 *   by id) whatever their presence: the selection and its order stay the same
 *   when members go online or offline, and follow a rename on its own. A
 *   community the service does not know yet answers an empty list.
 */

jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { connect: jest.fn(), query: jest.fn() },
}));
jest.mock('../healthcheck', () => ({ fakeHealthcheck: jest.fn() }));

import { memberListForTests as ml } from '../memberlist';
import { emptyMemberList } from '../common/memberLists';
import { ChannelPermission, PredefinedRole, RoleType } from '../common/enums';

const COMMUNITY = 'p1';
const MEMBER_ROLE = 'p1-member';
const CHANNEL = 'p1-general';
// alice sorts first by name and starts offline; dora-1 and dora-2 share a name
const names: Record<string, string> = {
  alice: 'Alice',
  bob: 'Bob',
  carl: 'Carl',
  'dora-1': 'Dora',
  'dora-2': 'Dora',
};

function userData(userId: string, onlineStatus: Models.User.OnlineStatus) {
  ml.queueEvent({
    type: 'userdatachange', userId, onlineStatus, displayAccount: 'cg', platformBan: null,
    accounts: [{ type: 'cg', displayName: names[userId] }],
  } as Events.PgNotify.UserDataChange);
}
const status: Record<string, Models.User.OnlineStatus> = {
  carl: 'online',
  'dora-2': 'online',
  alice: 'offline',
  bob: 'online',
  'dora-1': 'offline',
};
function setStatus(userId: string, onlineStatus: Models.User.OnlineStatus) {
  status[userId] = onlineStatus;
  userData(userId, onlineStatus);
}
function rename(userId: string, displayName: string) {
  names[userId] = displayName;
  userData(userId, status[userId]);
}

const ids = (items: [string, string[]][]) => items.map(([id]) => id);
const preview = (limit: number) => ml.getMemberListPreview({ communityId: COMMUNITY, limit });
const memberWindow = () => ml.getMemberListWindow({ communityId: COMMUNITY, offset: 0, limit: 80 });
const channelWindow = () => ml.getChannelMemberListWindow({ communityId: COMMUNITY, channelId: CHANNEL, offset: 0, limit: 80 });

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'trace').mockImplementation(() => {});

  for (const userId of Object.keys(status)) {
    userData(userId, status[userId]);
  }
  ml.queueEvent({ type: 'rolechange', communityId: COMMUNITY, roleId: 'p1-admin', title: PredefinedRole.Admin, roleType: RoleType.PREDEFINED, deleted: false });
  ml.queueEvent({ type: 'rolechange', communityId: COMMUNITY, roleId: MEMBER_ROLE, title: PredefinedRole.Member, roleType: RoleType.PREDEFINED, deleted: false });
  ml.queueEvent({
    type: 'channelrolepermissionchange', communityId: COMMUNITY, channelId: CHANNEL, roleId: MEMBER_ROLE,
    permissions: [ChannelPermission.CHANNEL_EXISTS, ChannelPermission.CHANNEL_READ, ChannelPermission.CHANNEL_WRITE],
  });
  for (const userId of Object.keys(status)) {
    ml.queueEvent({ type: 'userrolechange', userId, roleId: MEMBER_ROLE, hasRole: true });
  }
  ml.processChangeEvents();
});

describe('memberlist service: community member list', () => {
  it('answers the window with the online members first', () => {
    const result = memberWindow();
    expect(ids(result.online)).toEqual(['bob', 'carl', 'dora-2']);
    expect(ids(result.offline)).toEqual(['alice', 'dora-1']);
    expect(result.totalCount).toBe(5);
  });

  it('answers the preview by name, an offline member that sorts first coming first', () => {
    const result = preview(6);
    expect(ids(result.offline)).toEqual(['alice', 'bob', 'carl', 'dora-1', 'dora-2']);
    expect(result.online).toEqual([]);
    expect(result.roles).toEqual([]);
    expect(result.offline.every(([, roleIds]) => roleIds.length === 0)).toBe(true);
    expect(result.totalCount).toBe(5);
    expect(result.resultCount).toBe(5);
  });

  it('caps the preview at the limit', () => {
    expect(ids(preview(1).offline)).toEqual(['alice']);
    expect(ids(preview(2).offline)).toEqual(['alice', 'bob']);
  });

  it('keeps the preview selection and order when presence changes', () => {
    const before = ids(preview(6).offline);
    setStatus('alice', 'online');
    setStatus('bob', 'offline');
    setStatus('dora-1', 'online');
    setStatus('dora-2', 'offline');
    ml.processChangeEvents();

    const after = memberWindow();
    expect(ids(after.online)).toEqual(['alice', 'carl', 'dora-1']);
    expect(ids(after.offline)).toEqual(['bob', 'dora-2']);

    expect(ids(preview(6).offline)).toEqual(before);
    expect(ids(preview(2).offline)).toEqual(['alice', 'bob']);
  });

  it('re-sorts the preview, the window and the channel list after a rename alone', () => {
    expect(ids(channelWindow().writer)).toEqual(['alice', 'carl', 'dora-1']);
    rename('carl', 'Aaron');
    ml.processChangeEvents();

    expect(ids(preview(6).offline)).toEqual(['carl', 'alice', 'bob', 'dora-1', 'dora-2']);
    expect(ids(memberWindow().online)).toEqual(['carl', 'alice', 'dora-1']);
    expect(ids(channelWindow().writer)).toEqual(['carl', 'alice', 'dora-1']);
  });

  it('answers an empty preview for a community it does not know yet', () => {
    expect(ml.getMemberListPreview({ communityId: 'nope', limit: 6 })).toEqual(emptyMemberList());
  });
});
