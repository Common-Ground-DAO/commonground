// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Predefined roles by type and title in the community repository:
 * `removeUserFromRoles` keeps only the predefined Member role out of reach
 * (a custom role titled "Member" can be unassigned), and the channel events
 * of `updateChannel` carry each role's stored title and type instead of the
 * request's. Pool and the other repositories are mocked.
 */

const poolQuery = jest.fn();
const clientQuery = jest.fn();
const clientRelease = jest.fn();

jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: {
    query: (...args: any[]) => poolQuery(...args),
    connect: async () => ({
      query: (...args: any[]) => clientQuery(...args),
      release: (...args: any[]) => clientRelease(...args),
    }),
  },
}));
const eventHelper = { emit: jest.fn(), userLeaveRooms: jest.fn(), userJoinRooms: jest.fn() };
const botHelper = { guardGenericRoleRemoval: jest.fn(), reconcileAllUserBotsInCommunity: jest.fn(), reconcileUserBotsForOwner: jest.fn() };
const permissionHelper = { getRolePermissions: jest.fn() };
jest.mock('../repositories/event', () => ({ __esModule: true, default: eventHelper }));
jest.mock('../repositories/bots', () => ({ __esModule: true, default: botHelper }));
jest.mock('../repositories/permissions', () => ({ __esModule: true, default: permissionHelper }));
jest.mock('../repositories/notifications', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/users', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/emails', () => ({ __esModule: true, default: {} }));

import communityHelper from '../repositories/communities';

const USER = '00000000-0000-4000-8000-000000000001';
const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';
const CHANNEL = '00000000-0000-4000-8000-0000000000d1';
const R_ADMIN = '00000000-0000-4000-8000-0000000000a1';
const R_PUBLIC = '00000000-0000-4000-8000-0000000000a2';
const R_CUSTOM_MEMBER = '00000000-0000-4000-8000-0000000000a3';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  jest.clearAllMocks();
});

describe('removeUserFromRoles', () => {
  it('spares the predefined Member role only: a custom role titled "Member" is unassigned', async () => {
    clientQuery.mockImplementation(async (sql: string) => (
      sql.includes('DELETE FROM roles_users_users') ? { rows: [{ roleId: R_CUSTOM_MEMBER }] } : { rows: [] }
    ));
    jest.spyOn(communityHelper, 'getCommunityDetailView').mockResolvedValue({ roles: [] } as any);
    await communityHelper.removeUserFromRoles({ userId: USER, communityId: COMMUNITY, roleIds: [R_CUSTOM_MEMBER] });
    const remove = normalize(clientQuery.mock.calls.find(([sql]) => String(sql).includes('DELETE FROM roles_users_users'))![0]);
    expect(remove).toContain(`AND NOT ("type" = 'PREDEFINED' AND "title" = 'Member')`);
    expect(remove).not.toContain(`"title" <> 'Member'`);
    expect(eventHelper.userLeaveRooms).toHaveBeenCalledWith(USER, { roleIds: [R_CUSTOM_MEMBER] });
  });
});

describe('updateChannel events', () => {
  const roles = [
    { id: R_ADMIN, type: 'PREDEFINED', title: 'Admin', assignmentRules: null, permissions: [] },
    { id: R_PUBLIC, type: 'PREDEFINED', title: 'Public', assignmentRules: null, permissions: [] },
    { id: R_CUSTOM_MEMBER, type: 'CUSTOM_MANUAL_ASSIGN', title: 'Member', assignmentRules: null, permissions: [] },
  ];

  it('carry each role\'s stored title and type, not what the request said', async () => {
    permissionHelper.getRolePermissions.mockResolvedValue([
      { id: R_PUBLIC, title: 'Public', type: 'PREDEFINED', permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ'] },
      { id: R_CUSTOM_MEMBER, title: 'Member', type: 'CUSTOM_MANUAL_ASSIGN', permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ'] },
    ]);
    poolQuery.mockImplementation(async (sql: string) => (
      normalize(sql).includes('FROM roles WHERE "communityId" = $1 AND "deletedAt" IS NULL')
        ? { rows: roles }
        // the channel's base data for the "new" event (the Admin role is new to it)
        : { rows: [{ data: { communityId: COMMUNITY, channelId: CHANNEL, title: 'channel' } }] }
    ));
    clientQuery.mockImplementation(async (sql: string) => (
      sql.includes('UPDATE communities_channels') ? { rowCount: 1, rows: [{ updatedAt: '2026-11-03T00:00:00.000Z' }] } : { rows: [] }
    ));
    await communityHelper.updateChannel({
      communityId: COMMUNITY,
      channelId: CHANNEL,
      rolePermissions: [
        // the request claims the custom role is the predefined Member role
        { roleId: R_CUSTOM_MEMBER, roleTitle: 'Member', roleType: 'PREDEFINED', permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ'] },
        { roleId: R_PUBLIC, roleTitle: 'Something', permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ'] },
      ],
    } as any);
    const update = eventHelper.emit.mock.calls.find(([event]) => event.type === 'cliChannelEvent' && event.action === 'update')!;
    expect(update[0].data.rolePermissions).toEqual([
      { roleId: R_CUSTOM_MEMBER, roleTitle: 'Member', roleType: 'CUSTOM_MANUAL_ASSIGN', permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ'] },
      { roleId: R_PUBLIC, roleTitle: 'Public', roleType: 'PREDEFINED', permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ'] },
      // the Admin entry the server adds
      { roleId: R_ADMIN, roleTitle: 'Admin', roleType: 'PREDEFINED', permissions: expect.any(Array) },
    ]);
    const created = eventHelper.emit.mock.calls.find(([event]) => event.type === 'cliChannelEvent' && event.action === 'new')!;
    expect(created[0].data.rolePermissions).toEqual(update[0].data.rolePermissions);
  });
});
