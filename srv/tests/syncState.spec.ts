// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * `Message/getSyncState` with the pool mocked: the route (session users
 * only, validator), the SQL contract of the snapshot query (visibility by
 * CHANNEL_EXISTS + CHANNEL_READ, the `lastRead: null` semantics, the cap,
 * read-only) and the mapping of rows to the response. The query's results
 * on a real database are covered by syncStateDb.spec.ts.
 */

const handlers: Record<string, { validator: any; handler: (request: any, response: any, data: any) => Promise<any> }> = {};
const poolQuery = jest.fn();

jest.mock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, validator: unknown, handler: any) => {
    handlers[path] = { validator, handler };
  },
}));
jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => poolQuery(...args) },
}));
jest.mock('../repositories/event', () => ({ __esModule: true, default: { emit: jest.fn() } }));

import '../api/syncState';
import syncStateHelper, { buildSyncStateQuery } from '../repositories/syncState';
import { UNREAD_CAP } from '../repositories/messages';

const ME = '00000000-0000-4000-8000-000000000001';
const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';
const CHANNEL = '00000000-0000-4000-8000-0000000000a1';
const CHANNEL_2 = '00000000-0000-4000-8000-0000000000a2';
const CHAT = '00000000-0000-4000-8000-0000000000b1';
const CHAT_CHANNEL = '00000000-0000-4000-8000-0000000000b2';
const NOW = new Date('2026-11-02T12:00:00.000Z');

const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();
const isCountQuery = (sql: string) => normalize(sql).startsWith('SELECT COUNT(*)::int AS "unreadCount"');

function answer(channelRows: any[]) {
  poolQuery.mockImplementation(async (sql: string) => {
    if (isCountQuery(sql)) {
      return { rows: [{ unreadCount: '7', unreadCountAt: NOW }] };
    }
    return { rows: channelRows };
  });
}

const channelQueries = () => poolQuery.mock.calls.filter(([sql]) => !isCountQuery(sql));

async function call(body: unknown, request: any = { session: { user: { id: ME } } }) {
  const { validator, handler } = handlers['/getSyncState'];
  const data = await validator.validateAsync(body ?? {});
  return handler(request, {}, data);
}

beforeEach(() => {
  poolQuery.mockReset();
});

describe('Message/getSyncState route', () => {
  it('answers a session user', async () => {
    answer([]);
    await expect(call(undefined)).resolves.toEqual({
      serverTime: NOW.toISOString(),
      notificationUnreadCount: 7,
      channels: [],
    });
    expect(channelQueries()[0][1]).toEqual([ME]);
  });

  it('requires a login', async () => {
    await expect(call({}, { session: {} })).rejects.toThrow('LOGIN_REQUIRED');
    expect(poolQuery).not.toHaveBeenCalled();
  });

  it('refuses bot principals', async () => {
    await expect(call({}, { session: { user: { id: ME } }, botPrincipal: { user: { id: ME } } })).rejects.toThrow('NOT_ALLOWED');
    expect(poolQuery).not.toHaveBeenCalled();
  });

  describe('validator', () => {
    const validate = (body: unknown) => handlers['/getSyncState'].validator.validateAsync(body);
    const uuid = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

    it('accepts no filter and up to 500 unique channel ids', async () => {
      await expect(validate({})).resolves.toEqual({});
      await expect(validate({ channelIds: [] })).resolves.toEqual({ channelIds: [] });
      const ids = Array.from({ length: 500 }, (_, i) => uuid(i + 1));
      await expect(validate({ channelIds: ids })).resolves.toEqual({ channelIds: ids });
    });

    it('rejects more than 500, duplicates, non-uuids and unknown keys', async () => {
      await expect(validate({ channelIds: Array.from({ length: 501 }, (_, i) => uuid(i + 1)) })).rejects.toThrow();
      await expect(validate({ channelIds: [CHANNEL, CHANNEL] })).rejects.toThrow();
      await expect(validate({ channelIds: ['not-a-uuid'] })).rejects.toThrow();
      await expect(validate({ channelIds: [null] })).rejects.toThrow();
      await expect(validate({ channelIds: CHANNEL })).rejects.toThrow();
      await expect(validate({ other: true })).rejects.toThrow();
    });
  });
});

describe('snapshot query', () => {
  const sql = normalize(buildSyncStateQuery(false));

  it('is a single read-only statement', () => {
    expect(sql.startsWith('WITH my_roles AS')).toBe(true);
    expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE|UPSERT|MERGE)\b/i);
  });

  it('takes communities from claimed, not deleted roles and skips deleted communities', () => {
    expect(sql).toContain('WHERE ruu."userId" = $1 AND ruu."claimed" = TRUE');
    expect(sql).toContain('ON r."id" = ruu."roleId" AND r."deletedAt" IS NULL');
    expect(sql).toContain('ON c."id" = mr."communityId" AND c."deletedAt" IS NULL');
  });

  it('adds the predefined Public role of those communities', () => {
    expect(sql).toContain(`WHERE r."title" = 'Public' AND r."type" = 'PREDEFINED' AND r."deletedAt" IS NULL`);
  });

  it('requires CHANNEL_EXISTS and CHANNEL_READ over the reading roles', () => {
    expect(sql).toContain(`HAVING bool_or('CHANNEL_EXISTS' = ANY(ccrp."permissions")) AND bool_or('CHANNEL_READ' = ANY(ccrp."permissions"))`);
    expect(sql).toContain('WHERE ch."deletedAt" IS NULL');
  });

  it('lists chats the user is a member of that are not deleted', () => {
    expect(sql).toContain('WHERE c."userIds" @> ARRAY[$1::uuid] AND c."deletedAt" IS NULL');
  });

  it('counts unread messages of others, capped, with today\'s lastRead-null semantics', () => {
    // with lastRead: after lastRead
    expect(sql).toContain(`WHEN chrs."lastRead" IS NOT NULL THEN ( SELECT COUNT(*)::int FROM ( SELECT 1 FROM messages m WHERE m."channelId" = rd."channelId" AND m."createdAt" > chrs."lastRead" AND m."deletedAt" IS NULL AND m."creatorId" <> $1 LIMIT ${UNREAD_CAP} )`);
    // without lastRead: DMs count every message of others, community channels 0
    expect(sql).toContain(`WHEN rd."chatId" IS NOT NULL THEN ( SELECT COUNT(*)::int FROM ( SELECT 1 FROM messages m WHERE m."channelId" = rd."channelId" AND m."deletedAt" IS NULL AND m."creatorId" <> $1 LIMIT ${UNREAD_CAP} )`);
    expect(sql).toContain('ELSE 0 END AS "unread"');
  });

  it('reads the sequence from channel_sync_state, 0 without a row', () => {
    expect(sql).toContain('COALESCE(css."seq", 0)::text AS "syncSeq"');
    expect(sql).toContain('LEFT JOIN channel_sync_state css ON css."channelId" = rd."channelId"');
  });

  it('filters community channels and chats by the requested ids only when asked', () => {
    expect(sql).not.toContain('$2');
    const filtered = normalize(buildSyncStateQuery(true));
    expect(filtered).toContain('AND ch."channelId" = ANY($2::uuid[])');
    expect(filtered).toContain('AND c."channelId" = ANY($2::uuid[])');
  });
});

describe('syncStateHelper.getSyncState', () => {
  it('maps rows to channel states', async () => {
    answer([
      {
        channelId: CHANNEL, communityId: COMMUNITY, chatId: null, syncSeq: '42',
        lastRead: new Date('2026-11-01T10:00:00.000Z'), lastMessageDate: new Date('2026-11-01T11:00:00.000Z'), unread: 3,
      },
      {
        channelId: CHANNEL_2, communityId: COMMUNITY, chatId: null, syncSeq: '0',
        lastRead: null, lastMessageDate: null, unread: '0',
      },
      {
        channelId: CHAT_CHANNEL, communityId: null, chatId: CHAT, syncSeq: '9007199254740991',
        lastRead: null, lastMessageDate: new Date('2026-11-01T12:00:00.000Z'), unread: 5000,
      },
    ]);
    const response = await syncStateHelper.getSyncState(ME, {});
    expect(response).toEqual({
      serverTime: NOW.toISOString(),
      notificationUnreadCount: 7,
      channels: [
        {
          channelId: CHANNEL, communityId: COMMUNITY, syncSeq: 42,
          lastRead: '2026-11-01T10:00:00.000Z', lastMessageDate: '2026-11-01T11:00:00.000Z', unread: 3,
        },
        { channelId: CHANNEL_2, communityId: COMMUNITY, syncSeq: 0, lastRead: null, lastMessageDate: null, unread: 0 },
        {
          channelId: CHAT_CHANNEL, chatId: CHAT, syncSeq: 9007199254740991,
          lastRead: null, lastMessageDate: '2026-11-01T12:00:00.000Z', unread: UNREAD_CAP,
        },
      ],
    });
    expect('chatId' in response.channels[0]).toBe(false);
    expect('communityId' in response.channels[2]).toBe(false);
  });

  it('passes the channel filter as a parameter', async () => {
    answer([]);
    await syncStateHelper.getSyncState(ME, { channelIds: [CHANNEL, CHAT_CHANNEL] });
    const [sql, params] = channelQueries()[0];
    expect(normalize(sql)).toContain('= ANY($2::uuid[])');
    expect(params).toEqual([ME, [CHANNEL, CHAT_CHANNEL]]);
  });

  it('answers an empty filter without the channel query', async () => {
    answer([]);
    await expect(syncStateHelper.getSyncState(ME, { channelIds: [] })).resolves.toEqual({
      serverTime: NOW.toISOString(),
      notificationUnreadCount: 7,
      channels: [],
    });
    expect(channelQueries()).toHaveLength(0);
  });

  it('runs no writes', async () => {
    answer([]);
    await syncStateHelper.getSyncState(ME, {});
    await syncStateHelper.getSyncState(ME, { channelIds: [CHANNEL] });
    for (const [sql] of poolQuery.mock.calls) {
      expect(sql).not.toMatch(/\b(INSERT|UPDATE|DELETE)\b/i);
    }
  });
});
