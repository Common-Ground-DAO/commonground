// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The titles of the predefined roles (Admin, Member, Public) are reserved, in
 * any letter case and with surrounding spaces: `/Community/createRole`
 * refuses them (validator). `/Community/updateRole` lets a role keep the
 * reserved title it already carries (the web client resends the title on
 * every save) and refuses a change to one (`communityHelper.updateRole`,
 * which reads the stored role). Pool and other repositories mocked.
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
jest.mock('../repositories/event', () => ({ __esModule: true, default: { emit: jest.fn() } }));
jest.mock('../repositories/bots', () => ({ __esModule: true, default: { reconcileAllUserBotsInCommunity: jest.fn() } }));
jest.mock('../repositories/permissions', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/notifications', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/users', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/emails', () => ({ __esModule: true, default: {} }));

import validators from '../validators';
import communityHelper from '../repositories/communities';
import { isReservedRoleTitle } from '../util/roleTitles';

const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';
const ROLE = '00000000-0000-4000-8000-0000000000a1';

const createRole = (title: string) => ({
  communityId: COMMUNITY,
  title,
  type: 'CUSTOM_MANUAL_ASSIGN',
  assignmentRules: null,
  permissions: [],
  description: null,
  imageId: null,
});

const reserved = ['Admin', 'admin', 'Member', 'MEMBER', 'Public', 'public', ' Public ', 'pUbLiC'];
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  poolQuery.mockReset();
  clientQuery.mockReset();
  clientRelease.mockReset();
});

describe('isReservedRoleTitle', () => {
  it.each(reserved)('"%s" is reserved', (title) => {
    expect(isReservedRoleTitle(title)).toBe(true);
  });

  it.each(['Moderators', 'Publicists', 'Members+', 'Public Speakers'])('"%s" is not', (title) => {
    expect(isReservedRoleTitle(title)).toBe(false);
  });
});

describe('createRole validation', () => {
  it.each(reserved)('refuses "%s"', (title) => {
    expect(validators.API.Community.createRole.validate(createRole(title)).error).toBeDefined();
  });

  it.each(['Moderators', 'Publicists', 'Members+', 'Public Speakers'])('accepts "%s"', (title) => {
    expect(validators.API.Community.createRole.validate(createRole(title)).error).toBeUndefined();
  });
});

describe('updateRole', () => {
  const update = (title: string) => {
    const { value, error } = validators.API.Community.updateRole.validate({ id: ROLE, communityId: COMMUNITY, title, permissions: [] });
    expect(error).toBeUndefined();
    return communityHelper.updateRole(value as any);
  };
  const storedTitle = (title: string) => clientQuery.mockImplementation(async (sql: string) => {
    if (normalize(sql).startsWith('SELECT "title" FROM roles')) {
      return { rows: [{ title }] };
    }
    if (sql.includes('UPDATE roles')) {
      return { rowCount: 1, rows: [{ updatedAt: '2026-11-03T00:00:00.000Z' }] };
    }
    return { rows: [] };
  });
  const wroteRole = () => clientQuery.mock.calls.some(([sql]) => String(sql).includes('UPDATE roles'));

  it('lets a custom role keep the reserved title it carries (the client resends it)', async () => {
    storedTitle('Member');
    await update('Member');
    const lookup = clientQuery.mock.calls.find(([sql]) => normalize(sql).startsWith('SELECT "title" FROM roles'))!;
    expect(normalize(lookup[0])).toContain('WHERE "id" = $1 AND "communityId" = $2 AND "deletedAt" IS NULL');
    expect(lookup[1]).toEqual([ROLE, COMMUNITY]);
    expect(wroteRole()).toBe(true);
    expect(clientQuery.mock.calls.map(c => normalize(c[0]))).toContain('COMMIT');
  });

  it('also when the stored title has spaces around it', async () => {
    storedTitle(' Public ');
    await update('Public');
    expect(wroteRole()).toBe(true);
  });

  it.each([
    ['a custom title', 'Moderators', 'Public'],
    ['another reserved title', 'Member', 'Public'],
    ['another letter case', 'member', 'Member'],
  ])('refuses a change from %s to a reserved one', async (_name, stored, sent) => {
    storedTitle(stored);
    await expect(update(sent)).rejects.toThrow('INVALID_REQUEST');
    expect(wroteRole()).toBe(false);
    expect(clientQuery.mock.calls.map(c => normalize(c[0]))).toContain('ROLLBACK');
  });

  it('refuses a reserved title for an unknown role, or a role of another community', async () => {
    clientQuery.mockResolvedValue({ rows: [] });
    await expect(update('Public')).rejects.toThrow('INVALID_REQUEST');
    expect(wroteRole()).toBe(false);
  });

  it('a permission change spares only the predefined Admin role, not a custom role with its title', async () => {
    storedTitle('Admin');
    await update('Admin');
    const write = clientQuery.mock.calls.find(([sql]) => String(sql).includes('UPDATE roles'))!;
    expect(normalize(write[0])).toContain(`AND NOT ("type" = 'PREDEFINED' AND "title" = 'Admin')`);
  });

  it('does not read the stored role for an ordinary title', async () => {
    storedTitle('Moderators');
    await update('Speakers');
    expect(clientQuery.mock.calls.some(([sql]) => normalize(sql).startsWith('SELECT "title" FROM roles'))).toBe(false);
    expect(wroteRole()).toBe(true);
  });

  it('without a title (a predefined role\'s permissions) still passes the validator', () => {
    expect(validators.API.Community.updateRole.validate({ id: ROLE, communityId: COMMUNITY, permissions: [] }).error).toBeUndefined();
  });
});

describe('role permission lists', () => {
  const channel = (entry: Record<string, unknown>) => ({
    communityId: COMMUNITY,
    areaId: ROLE,
    title: 'channel',
    order: 1,
    description: null,
    emoji: '🙂',
    url: null,
    rolePermissions: [{ roleId: ROLE, roleTitle: 'Public', permissions: ['CHANNEL_EXISTS'], ...entry }],
  });

  it('accept the roleType the server sends with them (a client may send a list back as read)', () => {
    expect(validators.API.Community.createChannel.validate(channel({ roleType: 'PREDEFINED' })).error).toBeUndefined();
    expect(validators.API.Community.createChannel.validate(channel({})).error).toBeUndefined();
  });

  it('refuse an unknown roleType', () => {
    expect(validators.API.Community.createChannel.validate(channel({ roleType: 'SOMETHING' })).error).toBeDefined();
  });
});
