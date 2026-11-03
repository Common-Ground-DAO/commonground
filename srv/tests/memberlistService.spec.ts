// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The memberlist service (`srv/memberlist.ts`): its community member list
 * window and preview, loaded from a mocked database, with presence changes
 * fed through the mocked LISTEN client.
 *
 * - `/getMemberListWindow` (no search, no role filter) walks the online
 *   members first, then the offline ones, each by display name.
 * - `/getMemberListPreview` answers the first members by display name (ties
 *   by id) whatever their presence: the selection and its order stay the same
 *   when members go online or offline.
 */

const handlers: Record<string, (request: any, response: any) => Promise<void>> = {};
const notificationListeners: ((msg: { payload?: string }) => void)[] = [];
const listenClient = {
  query: jest.fn(async () => ({ rows: [] })),
  on: jest.fn((event: string, listener: any) => {
    if (event === 'notification') {
      notificationListeners.push(listener);
    }
  }),
};
const poolQuery = jest.fn();

jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: {
    connect: async () => listenClient,
    query: (...args: any[]) => poolQuery(...args),
  },
}));
jest.mock('../healthcheck', () => ({ fakeHealthcheck: jest.fn() }));
jest.mock('../util/asyncHandler', () => ({ asyncRequestHandler: (handler: any) => handler }));
jest.mock('express', () => {
  const app = {
    post: (path: string, ...chain: any[]) => {
      handlers[path] = chain[chain.length - 1];
    },
    listen: jest.fn(),
  };
  const express = Object.assign(() => app, { json: () => () => undefined });
  return { __esModule: true, default: express };
});

import { convertBinaryToUuid, convertUuidToBinary } from '../util/memberListHelpers';

const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';
const MEMBER_ROLE = '00000000-0000-4000-8000-0000000000e1';
const ADMIN_ROLE = '00000000-0000-4000-8000-0000000000e2';
const PUBLIC_ROLE = '00000000-0000-4000-8000-0000000000e3';
// ALICE sorts first by name and starts offline
const ALICE = '00000000-0000-4000-8000-000000000001';
const BOB = '00000000-0000-4000-8000-000000000002';
const CARL = '00000000-0000-4000-8000-000000000003';
// two members with the same display name
const DORA_1 = '00000000-0000-4000-8000-000000000004';
const DORA_2 = '00000000-0000-4000-8000-000000000005';

const users: { id: string; name: string; onlineStatus: Models.User.OnlineStatus }[] = [
  { id: CARL, name: 'Carl', onlineStatus: 'online' },
  { id: DORA_2, name: 'Dora', onlineStatus: 'online' },
  { id: ALICE, name: 'Alice', onlineStatus: 'offline' },
  { id: BOB, name: 'Bob', onlineStatus: 'online' },
  { id: DORA_1, name: 'Dora', onlineStatus: 'offline' },
];

poolQuery.mockImplementation(async (sql: string) => {
  if (sql.includes('FROM users u')) {
    return {
      rows: users.map(u => ({
        userId: u.id,
        onlineStatus: u.onlineStatus,
        displayAccount: 'cg',
        accounts: [{ displayName: u.name, type: 'cg' }],
      })),
    };
  }
  if (sql.includes('FROM roles_users_users')) {
    return { rows: users.map(u => ({ userId: u.id, roleIds: [MEMBER_ROLE] })) };
  }
  if (sql.includes('type AS "roleType"')) {
    return {
      rows: [
        { roleId: MEMBER_ROLE, communityId: COMMUNITY, title: 'Member', roleType: 'PREDEFINED' },
        { roleId: ADMIN_ROLE, communityId: COMMUNITY, title: 'Admin', roleType: 'PREDEFINED' },
        { roleId: PUBLIC_ROLE, communityId: COMMUNITY, title: 'Public', roleType: 'PREDEFINED' },
      ],
    };
  }
  return { rows: [] };
});

const call = async (path: string, body: object) => {
  const res = { json: jest.fn(), status: jest.fn() };
  await handlers[path]({ body }, res);
  return res.json.mock.calls[0][0] as Models.Community.MemberList;
};
const ids = (items: [string, string[]][]) => items.map(([id]) => convertBinaryToUuid(id));
const preview = (limit: number) => call('/getMemberListPreview', { communityId: convertUuidToBinary(COMMUNITY), limit });
const memberWindow = () => call('/getMemberListWindow', { communityId: convertUuidToBinary(COMMUNITY), offset: 0, limit: 80 });

const setOnlineStatus = (userId: string, onlineStatus: Models.User.OnlineStatus) => {
  const user = users.find(u => u.id === userId)!;
  user.onlineStatus = onlineStatus;
  const payload = JSON.stringify({
    type: 'userdatachange',
    userId,
    onlineStatus,
    displayAccount: 'cg',
    accounts: [{ displayName: user.name, type: 'cg' }],
  });
  for (const listener of notificationListeners) {
    listener({ payload });
  }
};

// ties by id, in the service's (binary) id encoding
const doras = [DORA_1, DORA_2].sort((a, b) => {
  const x = convertUuidToBinary(a);
  const y = convertUuidToBinary(b);
  return x < y ? -1 : x > y ? 1 : 0;
});

beforeAll(() => {
  jest.useFakeTimers({ doNotFake: ['nextTick', 'queueMicrotask', 'setImmediate'] });
  jest.spyOn(console, 'log').mockImplementation(() => undefined);
  // the community has no channels, which the service traces on presence changes
  jest.spyOn(console, 'trace').mockImplementation(() => undefined);
  require('../memberlist');
});

afterAll(() => {
  jest.clearAllTimers();
  jest.useRealTimers();
});

describe('memberlist service', () => {
  it('answers the window with the online members first', async () => {
    const result = await memberWindow();
    expect(ids(result.online)).toEqual([BOB, CARL, DORA_2]);
    expect(ids(result.offline)).toEqual([ALICE, DORA_1]);
    expect(result.totalCount).toBe(5);
  });

  it('answers the preview by name, an offline member that sorts first coming first', async () => {
    const result = await preview(6);
    expect(ids(result.offline)).toEqual([ALICE, BOB, CARL, ...doras]);
    expect(result.online).toEqual([]);
    expect(result.roles).toEqual([]);
    expect(result.offline.every(([, roleIds]) => roleIds.length === 0)).toBe(true);
    expect(result.totalCount).toBe(5);
    expect(result.resultCount).toBe(5);
  });

  it('caps the preview at the limit', async () => {
    expect(ids((await preview(1)).offline)).toEqual([ALICE]);
    expect(ids((await preview(2)).offline)).toEqual([ALICE, BOB]);
  });

  it('keeps the preview selection and order when presence changes', async () => {
    const before = ids((await preview(6)).offline);
    setOnlineStatus(ALICE, 'online');
    setOnlineStatus(BOB, 'offline');
    setOnlineStatus(DORA_1, 'online');
    setOnlineStatus(DORA_2, 'offline');
    jest.advanceTimersByTime(1000);

    const windowAfter = await memberWindow();
    expect(ids(windowAfter.online)).toEqual([ALICE, CARL, DORA_1]);
    expect(ids(windowAfter.offline)).toEqual([BOB, DORA_2]);

    expect(ids((await preview(6)).offline)).toEqual(before);
    expect(ids((await preview(2)).offline)).toEqual([ALICE, BOB]);
  });
});
