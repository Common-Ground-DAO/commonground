// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * SQL-level contract of the membership lookup in
 * `repositories/permissions.ts`, with the pool mocked.
 */

const poolQuery = jest.fn();

jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => poolQuery(...args) },
}));

import permissionHelper from '../repositories/permissions';

const USER = '00000000-0000-4000-8000-000000000001';
const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ');

beforeEach(() => {
  poolQuery.mockReset();
});

describe('permissionHelper.isMemberOfActiveCommunity', () => {
  it('requires a claimed live role of the live community, other than Public', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(permissionHelper.isMemberOfActiveCommunity(USER, COMMUNITY)).resolves.toBe(true);
    const [sql, params] = poolQuery.mock.calls[0];
    const normalized = normalize(sql);
    expect(normalized).toContain('FROM roles_users_users ruu INNER JOIN roles r ON r."id" = ruu."roleId" INNER JOIN communities c ON c."id" = r."communityId"');
    expect(normalized).toContain('WHERE ruu."userId" = $1 AND r."communityId" = $2');
    expect(normalized).toContain('ruu.claimed = TRUE');
    expect(normalized).toContain(' r."deletedAt" IS NULL');
    expect(normalized).toContain(`AND NOT (r."type" = 'PREDEFINED' AND r."title" = 'Public')`);
    expect(normalized).toContain(' c."deletedAt" IS NULL');
    expect(params).toEqual([USER, COMMUNITY]);
  });

  it('is false without a matching row (no claimed role, deleted role or community)', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(permissionHelper.isMemberOfActiveCommunity(USER, COMMUNITY)).resolves.toBe(false);
  });
});

describe('permissionHelper.isActiveCommunity', () => {
  it('requires the community not to be deleted', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(permissionHelper.isActiveCommunity(COMMUNITY)).resolves.toBe(true);
    const [sql, params] = poolQuery.mock.calls[0];
    const normalized = normalize(sql);
    expect(normalized).toContain('FROM communities c WHERE c."id" = $1 AND c."deletedAt" IS NULL');
    expect(params).toEqual([COMMUNITY]);
  });

  it('is false for a deleted or unknown community', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(permissionHelper.isActiveCommunity(COMMUNITY)).resolves.toBe(false);
  });
});
