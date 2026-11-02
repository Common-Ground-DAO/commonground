// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Presence writes in `repositories/users.ts` (pool and emitter mocked): only a
 * real status change produces events, a login never overwrites a status other
 * than offline, and own data goes only to the user whose status changed.
 */

process.env.BASE_URL = 'https://cg.box';
process.env.DEPLOYMENT = 'prod';

const poolQuery = jest.fn();
const emit = jest.fn();
jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => poolQuery(...args) },
}));
jest.mock('../redis', () => require('./helpers/memoryRedis'));
jest.mock('../repositories/event', () => ({
  __esModule: true,
  default: { emit: (...args: any[]) => emit(...args) },
}));
for (const name of ['notifications', 'files', 'onchain', 'staking']) {
  jest.mock(`../repositories/${name}`, () => ({ __esModule: true, default: {} }));
}
jest.mock('../onchain/scheduler', () => ({ OnchainPriority: {} }));
jest.mock('puppeteer', () => ({ __esModule: true, default: {} }));

import userHelper from '../repositories/users';

const USER = '00000000-0000-4000-8000-000000000001';
const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';
const UPDATED_AT = '2026-11-02T10:00:00.000Z';
const changedRow = { userId: USER, updatedAt: UPDATED_AT, communityIds: [COMMUNITY] };

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const emittedTypes = () => emit.mock.calls.map(([event]) => event.type);

beforeEach(() => {
  poolQuery.mockReset();
  emit.mockReset();
});

describe('userHelper.touchUserOnlineStatus (login and periodic touch)', () => {
  it('flips only offline users to online and refreshes everyone else', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await userHelper.touchUserOnlineStatus([USER], { emitOwnData: true });
    const sql = normalize(poolQuery.mock.calls[0][0]);
    expect(sql).toContain(`"onlineStatus" = 'online', "updatedAt" = now() WHERE id = ANY((SELECT id FROM all_ids)) AND "onlineStatus" = 'offline'`);
    expect(sql).toContain(`SET "onlineStatusUpdatedAt" = now() WHERE id = ANY((SELECT id FROM all_ids)) AND "onlineStatus" <> 'offline'`);
  });

  it('emits nothing when the status did not change', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await userHelper.touchUserOnlineStatus([USER], { emitOwnData: true });
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits own data and the community-wide user data on a real change', async () => {
    poolQuery.mockResolvedValue({ rows: [changedRow] });
    await userHelper.touchUserOnlineStatus([USER], { emitOwnData: true });
    expect(emit).toHaveBeenCalledWith(
      { type: 'cliUserOwnData', data: { onlineStatus: 'online' } },
      { userIds: [USER] },
    );
    expect(emit).toHaveBeenCalledWith(
      { type: 'cliUserData', data: { id: USER, onlineStatus: 'online', updatedAt: UPDATED_AT } },
      { communityIds: [COMMUNITY], userIds: [USER] },
    );
    expect(emit).toHaveBeenCalledTimes(2);
  });

  it('sends no own data unless asked (bot presence)', async () => {
    poolQuery.mockResolvedValue({ rows: [changedRow] });
    await userHelper.touchUserOnlineStatus([USER]);
    expect(emittedTypes()).toEqual(['cliUserData']);
  });

  it('runs no query for an empty list', async () => {
    await userHelper.touchUserOnlineStatus([], { emitOwnData: true });
    expect(poolQuery).not.toHaveBeenCalled();
  });
});

describe('userHelper.setUserOnlineStatus', () => {
  it('writes only when the status differs', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await userHelper.setUserOnlineStatus(USER, 'offline');
    expect(normalize(poolQuery.mock.calls[0][0])).toContain(`WHERE id = $1 AND "onlineStatus" <> $2`);
    expect(poolQuery.mock.calls[0][1]).toEqual([USER, 'offline']);
  });

  it('emits nothing when the status was already set', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await userHelper.setUserOnlineStatus(USER, 'offline');
    await userHelper.setUserOnlineStatus(USER, 'online');
    expect(emit).not.toHaveBeenCalled();
  });

  it('emits the community-wide offline, without own data, on a real change', async () => {
    poolQuery.mockResolvedValue({ rows: [changedRow] });
    await userHelper.setUserOnlineStatus(USER, 'offline');
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith(
      { type: 'cliUserData', data: { id: USER, onlineStatus: 'offline', updatedAt: UPDATED_AT } },
      { communityIds: [COMMUNITY], userIds: [USER] },
    );
  });

  it('emits own data for a non-offline status only on a real change', async () => {
    poolQuery.mockResolvedValue({ rows: [changedRow] });
    await userHelper.setUserOnlineStatus(USER, 'online');
    expect(emittedTypes().sort()).toEqual(['cliUserData', 'cliUserOwnData']);
  });
});
