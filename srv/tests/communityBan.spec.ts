// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * `communityHelper.setUserBlockState` for a ban: the user's roles of the
 * community are removed and the ban is stored in one transaction. If either
 * fails, nothing is kept and the request fails; the events and room changes
 * of the removed membership follow after the commit, and their failure does
 * not undo the ban. The pool and the other repositories are mocked.
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
      release: () => clientRelease(),
    }),
  },
}));
const eventHelper = { emit: jest.fn(), userLeaveRooms: jest.fn() };
const botHelper = { reconcileUserBotsForOwner: jest.fn() };
jest.mock('../repositories/event', () => ({ __esModule: true, default: eventHelper }));
jest.mock('../repositories/bots', () => ({ __esModule: true, default: botHelper }));
jest.mock('../repositories/permissions', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/notifications', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/users', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/emails', () => ({ __esModule: true, default: {} }));

import communityHelper from '../repositories/communities';
import { UserBlockState } from '../common/enums';

const USER = '00000000-0000-4000-8000-000000000001';
const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';
const ROLE = '00000000-0000-4000-8000-0000000000a1';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const ban = () => communityHelper.setUserBlockState({
  userId: USER,
  communityId: COMMUNITY,
  blockState: UserBlockState.BANNED,
  until: null,
} as any);

const removedRow = { memberCount: 4, deletedRolesIds: [ROLE], communityOrder: [], updatedAt: '2026-11-03T00:00:00.000Z' };

beforeEach(() => {
  poolQuery.mockReset();
  clientQuery.mockReset();
  clientRelease.mockReset();
  eventHelper.emit.mockReset();
  eventHelper.userLeaveRooms.mockReset();
  botHelper.reconcileUserBotsForOwner.mockReset();
  // not an admin, not the creator
  poolQuery.mockResolvedValue({ rows: [] });
});

describe('a ban', () => {
  it('removes the roles and stores the ban in one transaction, then sends the membership updates', async () => {
    clientQuery.mockImplementation(async (sql: string) => (
      sql.includes('DELETE FROM roles_users_users') ? { rows: [removedRow] } : { rows: [] }
    ));
    const detailView = jest.spyOn(communityHelper, 'getCommunityDetailView').mockResolvedValue({ roles: [{ id: ROLE }] } as any);
    await ban();
    const statements = clientQuery.mock.calls.map(c => normalize(c[0]));
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toContain('DELETE FROM roles_users_users');
    expect(statements[2]).toContain('INSERT INTO user_community_state');
    expect(clientQuery.mock.calls[2][1]).toEqual([USER, COMMUNITY, UserBlockState.BANNED, null]);
    expect(statements[3]).toBe('COMMIT');
    expect(clientRelease).toHaveBeenCalled();
    // after the commit
    expect(eventHelper.userLeaveRooms).toHaveBeenCalledWith(USER, { roleIds: [ROLE], communityIds: [COMMUNITY] });
    expect(eventHelper.emit).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'cliMembershipEvent', action: 'leave' }),
      { communityIds: [COMMUNITY] },
    );
    expect(botHelper.reconcileUserBotsForOwner).toHaveBeenCalledWith(USER, COMMUNITY);
    detailView.mockRestore();
  });

  it('of a user without roles stores the ban alone, without membership updates', async () => {
    clientQuery.mockResolvedValue({ rows: [] });
    await ban();
    const statements = clientQuery.mock.calls.map(c => normalize(c[0]));
    expect(statements[0]).toBe('BEGIN');
    expect(statements.some(s => s.includes('INSERT INTO user_community_state'))).toBe(true);
    expect(statements[statements.length - 1]).toBe('COMMIT');
    expect(eventHelper.userLeaveRooms).not.toHaveBeenCalled();
    expect(botHelper.reconcileUserBotsForOwner).not.toHaveBeenCalled();
  });

  it('fails as a whole when the roles cannot be removed: rolled back, no ban stored', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('DELETE FROM roles_users_users')) {
        throw new Error('db down');
      }
      return { rows: [] };
    });
    await expect(ban()).rejects.toThrow('db down');
    const statements = clientQuery.mock.calls.map(c => normalize(c[0]));
    expect(statements).not.toContain('COMMIT');
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
    expect(statements.some(s => s.includes('INSERT INTO user_community_state'))).toBe(false);
    expect(clientRelease).toHaveBeenCalled();
    expect(eventHelper.userLeaveRooms).not.toHaveBeenCalled();
  });

  it('fails as a whole when the ban cannot be stored: the role removal is rolled back too', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('DELETE FROM roles_users_users')) {
        return { rows: [removedRow] };
      }
      if (sql.includes('INSERT INTO user_community_state')) {
        throw new Error('insert failed');
      }
      return { rows: [] };
    });
    await expect(ban()).rejects.toThrow('insert failed');
    const statements = clientQuery.mock.calls.map(c => normalize(c[0]));
    expect(statements).not.toContain('COMMIT');
    expect(statements[statements.length - 1]).toBe('ROLLBACK');
    expect(eventHelper.userLeaveRooms).not.toHaveBeenCalled();
  });

  it('stays in place when the membership updates after the commit fail', async () => {
    const errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    clientQuery.mockImplementation(async (sql: string) => (
      sql.includes('DELETE FROM roles_users_users') ? { rows: [removedRow] } : { rows: [] }
    ));
    const detailView = jest.spyOn(communityHelper, 'getCommunityDetailView').mockRejectedValue(new Error('read failed'));
    await expect(ban()).resolves.toBeUndefined();
    expect(clientQuery.mock.calls.map(c => normalize(c[0]))).toContain('COMMIT');
    expect(errorSpy).toHaveBeenCalled();
    detailView.mockRestore();
    errorSpy.mockRestore();
  });

  it('is refused for an admin of the community, before anything is written', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(ban()).rejects.toThrow('NOT_ALLOWED');
    expect(clientQuery).not.toHaveBeenCalled();
  });
});

describe('leaving a community', () => {
  it('is refused for a user without a role of it', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await expect(communityHelper.leaveCommunity(USER, COMMUNITY)).rejects.toThrow('NOT_ALLOWED');
    expect(eventHelper.userLeaveRooms).not.toHaveBeenCalled();
  });
});
