// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * SQL contract of the extra delivery targets of a call's live events
 * (`repositories/calls.ts`): the users with an open membership who hold the
 * needed call permissions (claimed roles or Public), and the community when
 * the Public role may see the call. Pool mocked.
 */

const poolQuery = jest.fn();

jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => poolQuery(...args) },
}));

import callHelper from '../repositories/calls';

const CALL = '00000000-0000-4000-8000-0000000000c1';
const COMMUNITY = '00000000-0000-4000-8000-0000000000e1';
const normalize = (sql: string) => sql.replace(/\s+/g, ' ');

/** the permission filter on the open memberships */
function expectMemberPermissionFilter(text: string, callId: string, permissions: string) {
  expect(text).toContain(`FROM callmembers cm WHERE cm."callId" = ${callId} AND cm."leftAt" IS NULL`);
  expect(text).toContain('ON ruu."roleId" = r."id" AND ruu."claimed" = TRUE AND ruu."userId" = cm."userId"');
  // roles of the call's community only; Public is the predefined role
  expect(text).toContain('INNER JOIN calls cl ON cl."id" = cp."callId" INNER JOIN roles r ON r."id" = cp."roleId" AND r."deletedAt" IS NULL AND r."communityId" = cl."communityId"');
  expect(text).toContain(`AND (ruu."userId" IS NOT NULL OR (r."type" = 'PREDEFINED' AND r."title" = $2))`);
  expect(text).toContain(`) @> ${permissions}::"public"."callpermissions_permissions_enum"[]`);
}

beforeEach(() => {
  poolQuery.mockReset();
});

describe('getActiveMemberUserIds', () => {
  it('reads the users of the open memberships who hold the permissions', async () => {
    poolQuery.mockResolvedValue({ rows: [{ userId: 'u1' }, { userId: 'u2' }] });
    await expect(callHelper.getActiveMemberUserIds(CALL, ['CALL_EXISTS', 'CHANNEL_READ'] as any)).resolves.toEqual(['u1', 'u2']);
    const [sql, params] = poolQuery.mock.calls[0];
    expectMemberPermissionFilter(normalize(sql), '$1', '$3');
    expect(params).toEqual([CALL, 'Public', ['CALL_EXISTS', 'CHANNEL_READ']]);
  });
});

describe('getCallEventExtraTargets', () => {
  it('reads the members and the Public role with CALL_EXISTS in one statement', async () => {
    poolQuery.mockResolvedValue({ rows: [{ activeMemberUserIds: ['u1'], publicCommunityId: COMMUNITY }] });
    await expect(callHelper.getCallEventExtraTargets(CALL)).resolves.toEqual({ activeMemberUserIds: ['u1'], publicCommunityId: COMMUNITY });
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    const text = normalize(sql);
    expectMemberPermissionFilter(text, 'c."id"', 'ARRAY[$3]');
    expect(text).toContain(`r."deletedAt" IS NULL AND r."communityId" = c."communityId" AND r."type" = 'PREDEFINED' WHERE cp."callId" = c."id" AND r."title" = $2 AND cp."permissions" @> ARRAY[$3]`);
    expect(params).toEqual([CALL, 'Public', 'CALL_EXISTS']);
  });

  it('an unknown call has no extra targets', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await expect(callHelper.getCallEventExtraTargets(CALL)).resolves.toEqual({ activeMemberUserIds: [], publicCommunityId: null });
  });
});
