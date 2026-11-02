// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The memberlist service's event processing, driven through
 * `memberListForTests` (the module only starts the service when it is the
 * entry point). Ids are opaque strings here; the service never parses them
 * except for log lines.
 *
 * What is pinned: a channel new to the service gets a member list even if no
 * user's group changes, the list is seeded with the community's admins (as
 * the startup load does), and a community or channel the service does not
 * know yet answers an empty list instead of nothing.
 */

jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { connect: jest.fn(), query: jest.fn() },
}));
jest.mock('../healthcheck', () => ({ fakeHealthcheck: jest.fn() }));

import { memberListForTests as ml } from '../memberlist';
import { emptyChannelMemberList, emptyMemberList } from '../common/memberLists';
import { ChannelPermission, PredefinedRole, RoleType } from '../common/enums';

function role(communityId: string, roleId: string, title: string, roleType: Common.RoleType = RoleType.PREDEFINED) {
  ml.queueEvent({ type: 'rolechange', communityId, roleId, title, roleType, deleted: false });
}
function user(userId: string, displayName: string) {
  ml.queueEvent({
    type: 'userdatachange', userId, onlineStatus: 'online', displayAccount: 'cg', platformBan: null,
    accounts: [{ type: 'cg', displayName }],
  } as Events.PgNotify.UserDataChange);
}
function grant(userId: string, roleId: string) {
  ml.queueEvent({ type: 'userrolechange', userId, roleId, hasRole: true });
}
function channelPermission(communityId: string, channelId: string, roleId: string, permissions: Common.ChannelPermission[]) {
  ml.queueEvent({ type: 'channelrolepermissionchange', communityId, channelId, roleId, permissions });
}
function window(communityId: string, channelId: string) {
  return ml.getChannelMemberListWindow({ communityId, channelId, offset: 0, limit: 10 });
}

beforeAll(() => {
  jest.spyOn(console, 'log').mockImplementation(() => {});
  jest.spyOn(console, 'trace').mockImplementation(() => {});
});

describe('memberlist: a channel new to the service', () => {
  it('gets a member list even when no user changes (no admins, role without users)', () => {
    role('c1', 'c1-admin', PredefinedRole.Admin);
    role('c1', 'c1-empty', 'Empty', RoleType.CUSTOM_MANUAL_ASSIGN);
    channelPermission('c1', 'c1-ch', 'c1-empty', [ChannelPermission.CHANNEL_EXISTS, ChannelPermission.CHANNEL_READ]);
    ml.processChangeEvents();

    expect(ml.hasChannelMemberList('c1', 'c1-ch')).toBe(true);
    expect(window('c1', 'c1-ch')).toEqual(emptyChannelMemberList());
  });

  it('is seeded with the community admins', () => {
    // batch 1: a community with one channel and an admin
    user('alice', 'Alice');
    role('c2', 'c2-admin', PredefinedRole.Admin);
    role('c2', 'c2-member', PredefinedRole.Member);
    role('c2', 'c2-empty', 'Empty', RoleType.CUSTOM_MANUAL_ASSIGN);
    channelPermission('c2', 'c2-general', 'c2-member', [ChannelPermission.CHANNEL_EXISTS, ChannelPermission.CHANNEL_READ, ChannelPermission.CHANNEL_WRITE]);
    grant('alice', 'c2-admin');
    ml.processChangeEvents();
    expect(window('c2', 'c2-general').admin.map(([userId]) => userId)).toEqual(['alice']);

    // batch 2: a new channel only a role without users can see — the admin
    // is listed although no event of this channel touches her
    channelPermission('c2', 'c2-new', 'c2-empty', [ChannelPermission.CHANNEL_EXISTS, ChannelPermission.CHANNEL_READ]);
    ml.processChangeEvents();
    const list = window('c2', 'c2-new');
    expect(list.count).toBe(1);
    expect(list.adminCount).toBe(1);
    expect(list.admin).toEqual([['alice', ['c2-admin']]]);
  });
});

describe('memberlist: unknown community or channel', () => {
  it('answers an empty channel member list', () => {
    expect(window('nope', 'nope-ch')).toEqual(emptyChannelMemberList());
  });

  it('answers an empty community member list', () => {
    expect(ml.getMemberListWindow({ communityId: 'nope', offset: 0, limit: 10 })).toEqual(emptyMemberList());
  });
});
