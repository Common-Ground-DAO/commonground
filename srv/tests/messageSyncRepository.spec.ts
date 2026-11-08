// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * chat-sync parts of `repositories/messages.ts` with the pool mocked:
 * `getChanges` (cursor handling, resets, paging, tombstones), the idempotent
 * `createMessage` and `syncSeq` on reads and writes. The trigger itself and
 * the commit order are covered by chatSyncSeqDb.spec.ts on PostgreSQL.
 */

const poolQuery = jest.fn();

jest.mock('../util/postgres', () => ({
  __esModule: true,
  // pool.query and the queries of a checked-out client both go to poolQuery
  default: {
    query: (...args: any[]) => poolQuery(...args),
    connect: async () => ({ query: (...args: any[]) => poolQuery(...args), release: () => undefined }),
  },
}));
jest.mock('../repositories/files', () => ({ __esModule: true, default: { getFileData: jest.fn().mockResolvedValue([]) } }));

import messageHelper from '../repositories/messages';

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER = '00000000-0000-4000-8000-000000000002';
const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';
const CHANNEL = '00000000-0000-4000-8000-0000000000a1';
const access = { communityId: COMMUNITY, channelId: CHANNEL };
const NOW = new Date('2026-11-02T12:00:00.000Z');

const normalize = (sql: string) => sql.replace(/\s+/g, ' ');

let idCounter = 0;
function row(syncSeq: string | null, extra: Record<string, unknown> = {}) {
  idCounter++;
  return {
    id: `00000000-0000-4000-8000-${String(idCounter).padStart(12, '0')}`,
    creatorId: OTHER,
    channelId: CHANNEL,
    body: { version: '1', content: [] },
    attachments: [],
    createdAt: new Date(NOW.getTime() - 1000 * idCounter),
    editedAt: null,
    updatedAt: NOW,
    parentMessageId: null,
    reactions: {},
    ownReaction: null,
    syncSeq,
    ...extra,
  };
}

/** a getChanges / reset statement result: every row carries the channel seq */
function stateRows(channelSeq: string, rows: Record<string, unknown>[]) {
  const nullRow = Object.fromEntries(Object.keys(row(null)).map(key => [key, null]));
  const base = { channelSeq, serverTime: NOW };
  return { rows: rows.length > 0 ? rows.map(r => ({ ...base, ...r })) : [{ ...base, ...nullRow }] };
}

beforeEach(() => {
  poolQuery.mockReset();
  idCounter = 0;
});

describe('messageHelper.getChanges', () => {
  it('answers a null cursor with a reset: the latest page and the seq of the same statement', async () => {
    const newest = row('12');
    const unwritten = row(null);
    poolQuery.mockResolvedValueOnce(stateRows('12', [newest, unwritten]));
    const result = await messageHelper.getChanges(USER, { access, cursor: null });
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    const normalized = normalize(sql);
    expect(normalized).toContain('SELECT COALESCE((SELECT s."seq" FROM channel_sync_state s WHERE s."channelId" = $1::uuid), 0) AS "seq"');
    expect(normalized).toContain('AND m."deletedAt" IS NULL ORDER BY m."createdAt" DESC LIMIT $2');
    expect(params).toEqual([CHANNEL, 30]);
    expect(result).toEqual({
      cursor: '1:12',
      syncSeq: 12,
      reset: true,
      hasMore: false,
      serverTime: NOW.toISOString(),
      // a row not written since the migration counts as seq 0
      messages: [
        expect.objectContaining({ id: newest.id, syncSeq: 12 }),
        expect.objectContaining({ id: unwritten.id, syncSeq: 0 }),
      ],
      deletedIds: [],
    });
    expect(result.messages[0]).not.toHaveProperty('channelSeq');
    expect(result.messages[0]).not.toHaveProperty('serverTime');
  });

  it('answers an empty channel without a sequence row with a reset at seq 0', async () => {
    poolQuery.mockResolvedValueOnce(stateRows('0', []));
    await expect(messageHelper.getChanges(undefined, { access, cursor: null })).resolves.toEqual(expect.objectContaining({
      cursor: '1:0', syncSeq: 0, reset: true, hasMore: false, messages: [], deletedIds: [],
    }));
  });

  it.each([
    ['another format version', '2:5'],
    ['a malformed cursor', 'abc'],
    ['an over-long number', '1:1234567890123456789'],
  ])('answers %s with a reset without reading changes', async (_label, cursor) => {
    poolQuery.mockResolvedValueOnce(stateRows('3', [row('3')]));
    const result = await messageHelper.getChanges(USER, { access, cursor: cursor as any });
    expect(poolQuery).toHaveBeenCalledTimes(1);
    expect(normalize(poolQuery.mock.calls[0][0])).toContain('ORDER BY m."createdAt" DESC');
    expect(result.reset).toBe(true);
  });

  it('returns changes after the cursor, ascending, with tombstones as deletedIds', async () => {
    const edited = row('6');
    const deleted = row('7', { deletedAt: NOW });
    const created = row('8');
    poolQuery.mockResolvedValueOnce(stateRows('8', [
      { ...edited, deletedAt: null },
      deleted,
      { ...created, deletedAt: null },
    ]));
    const result = await messageHelper.getChanges(USER, { access, cursor: '1:5' });
    expect(poolQuery).toHaveBeenCalledTimes(1);
    const [sql, params] = poolQuery.mock.calls[0];
    const normalized = normalize(sql);
    expect(normalized).toContain('AND m."syncSeq" > $2::bigint AND $2::bigint <= st."seq" AND st."seq" - $2::bigint <= $4::bigint ORDER BY m."syncSeq" ASC LIMIT $3');
    // deleted rows are part of the change list
    expect(normalized).not.toContain('AND m."deletedAt" IS NULL');
    expect(params).toEqual([CHANNEL, '5', 201, 500]);
    expect(result).toEqual({
      cursor: '1:8',
      syncSeq: 8,
      reset: false,
      hasMore: false,
      serverTime: NOW.toISOString(),
      messages: [
        expect.objectContaining({ id: edited.id, syncSeq: 6 }),
        expect.objectContaining({ id: created.id, syncSeq: 8 }),
      ],
      deletedIds: [deleted.id],
    });
    expect(result.messages[0]).not.toHaveProperty('deletedAt');
  });

  it('reports the channel seq when nothing changed after the cursor', async () => {
    poolQuery.mockResolvedValueOnce(stateRows('9', []));
    await expect(messageHelper.getChanges(USER, { access, cursor: '1:9' })).resolves.toEqual(expect.objectContaining({
      cursor: '1:9', syncSeq: 9, reset: false, hasMore: false, messages: [], deletedIds: [],
    }));
  });

  it('pages with hasMore: the cursor is the last returned seq', async () => {
    const rows = [row('11'), row('12'), row('14')].map(r => ({ ...r, deletedAt: null }));
    poolQuery.mockResolvedValueOnce(stateRows('20', rows));
    const result = await messageHelper.getChanges(USER, { access, cursor: '1:10', limit: 2 });
    expect(poolQuery.mock.calls[0][1]).toEqual([CHANNEL, '10', 3, 500]);
    expect(result).toEqual(expect.objectContaining({
      cursor: '1:12', syncSeq: 12, reset: false, hasMore: true,
    }));
    expect(result.messages.map(m => m.syncSeq)).toEqual([11, 12]);
  });

  it('a page of exactly `limit` changes has no more', async () => {
    const rows = [row('11'), row('12')].map(r => ({ ...r, deletedAt: null }));
    poolQuery.mockResolvedValueOnce(stateRows('12', rows));
    const result = await messageHelper.getChanges(USER, { access, cursor: '1:10', limit: 2 });
    expect(result).toEqual(expect.objectContaining({ cursor: '1:12', hasMore: false }));
  });

  it.each([
    ['more than 500 changes behind', '1:99', '600'],
    ['ahead of the channel (restored database)', '1:50', '40'],
  ])('resets a cursor %s', async (_label, cursor, channelSeq) => {
    poolQuery
      .mockResolvedValueOnce(stateRows(channelSeq, []))
      .mockResolvedValueOnce(stateRows(channelSeq, [row(channelSeq)]));
    const result = await messageHelper.getChanges(USER, { access, cursor: cursor as any });
    expect(poolQuery).toHaveBeenCalledTimes(2);
    expect(normalize(poolQuery.mock.calls[1][0])).toContain('ORDER BY m."createdAt" DESC LIMIT $2');
    expect(result).toEqual(expect.objectContaining({
      cursor: `1:${channelSeq}`, syncSeq: Number(channelSeq), reset: true, hasMore: false, deletedIds: [],
    }));
    expect(result.messages).toHaveLength(1);
  });

  it('exactly 500 behind is still a change list', async () => {
    poolQuery.mockResolvedValueOnce(stateRows('600', []));
    const result = await messageHelper.getChanges(USER, { access, cursor: '1:100' });
    expect(poolQuery).toHaveBeenCalledTimes(1);
    expect(result.reset).toBe(false);
  });

  it('joins the requesting user\'s own reaction', async () => {
    poolQuery.mockResolvedValueOnce(stateRows('1', []));
    await messageHelper.getChanges(USER, { access, cursor: '1:1' });
    expect(normalize(poolQuery.mock.calls[0][0])).toContain(`AND rea."userId" = '${USER}'::UUID`);
  });
});

describe('syncSeq on reads and writes', () => {
  it('loadMessages sends syncSeq as a number and leaves it out for unwritten rows', async () => {
    const written = row('5');
    const unwritten = row(null);
    poolQuery.mockResolvedValueOnce({ rows: [written, unwritten] });
    const result = await messageHelper.loadMessages(USER, { access });
    expect(normalize(poolQuery.mock.calls[0][0])).toContain('m."syncSeq"');
    expect(result[0].syncSeq).toBe(5);
    expect(result[1]).not.toHaveProperty('syncSeq');
  });

  it('editMessage returns updatedAt, editedAt and syncSeq', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ updatedAt: NOW, editedAt: NOW, syncSeq: '9' }] });
    await expect(messageHelper.editMessage(USER, {
      access, id: OTHER, body: { version: '1', content: [] },
    } as any)).resolves.toEqual({ updatedAt: NOW, editedAt: NOW, syncSeq: 9 });
    expect(normalize(poolQuery.mock.calls[0][0])).toContain('RETURNING "updatedAt", "editedAt", "syncSeq"');
  });

  it('setReaction and unsetReaction return the syncSeq', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ updatedAt: NOW, reactions: { a: 1 }, syncSeq: '3' }] });
    await expect(messageHelper.setReaction(USER, { access, messageId: OTHER, reaction: 'a' }))
      .resolves.toEqual({ updatedAt: NOW, reactions: { a: 1 }, syncSeq: 3 });
    poolQuery.mockResolvedValueOnce({ rows: [{ channelId: CHANNEL, updatedAt: NOW, reactions: {}, syncSeq: '4' }] });
    await expect(messageHelper.unsetReaction(USER, { access, messageId: OTHER }))
      .resolves.toEqual({ channelId: CHANNEL, updatedAt: NOW, reactions: {}, syncSeq: 4 });
  });
});

describe('messageHelper.createMessage', () => {
  const MESSAGE = '00000000-0000-4000-8000-0000000000d1';
  const request = {
    id: MESSAGE,
    access,
    body: { version: '1', content: [] },
    parentMessageId: null,
    attachments: [],
  } as API.Messages.createMessage.Request;
  const inserted = {
    createdAt: NOW, updatedAt: NOW, id: MESSAGE, syncSeq: '17',
    userAccounts: [{ type: 'cg', displayName: 'Me', imageId: null }], userDisplayAccount: 'cg',
  };

  const statements = () => poolQuery.mock.calls.map(([sql]) => normalize(sql).trim());
  const insertCalls = () => poolQuery.mock.calls.filter(([sql]) => sql.includes('INSERT INTO messages'));
  const collision = () => Object.assign(new Error('duplicate key'), { code: '23505', table: 'messages', constraint: 'UQ_6df0905b0802e8402e6570c6505' });

  /**
   * Answers the create's statements. `idChecks` are the answers of the id
   * lookups in order (before the lock, under the lock), `inserts` those of
   * the INSERTs (an Error is thrown), `stored` the stored-message lookup.
   */
  function mockCreate(options: { idChecks: boolean[], inserts?: (object | Error)[], stored?: object[] }) {
    const idChecks = [...options.idChecks];
    const inserts = [...(options.inserts ?? [])];
    poolQuery.mockImplementation(async (sql: string) => {
      const text = normalize(sql).trim();
      if (text === 'SELECT 1 FROM messages WHERE "id" = $1::uuid') return { rows: idChecks.shift() ? [{ '?column?': 1 }] : [] };
      if (text.includes('INSERT INTO messages')) {
        const next = inserts.shift();
        if (next instanceof Error) throw next;
        return next;
      }
      if (text.includes('FROM messages m')) return { rows: options.stored ?? [] };
      return { rows: [] };
    });
  }

  it('inserts under the channel lock with ON CONFLICT (id) DO NOTHING, createdAt after the lock', async () => {
    mockCreate({ idChecks: [false, false], inserts: [{ rows: [inserted] }] });
    const result = await messageHelper.createMessage(USER, request);
    expect(result).toEqual({
      message: expect.objectContaining({ id: MESSAGE, creatorId: USER, channelId: CHANNEL, syncSeq: 17 }),
      userAlias: 'Me',
      created: true,
    });
    const sql = statements();
    expect(sql[0]).toBe('SELECT 1 FROM messages WHERE "id" = $1::uuid');
    expect(sql[1]).toBe('BEGIN');
    expect(sql[2]).toBe('INSERT INTO channel_sync_state AS s ("channelId", "seq") VALUES ($1::uuid, 0) ON CONFLICT ("channelId") DO UPDATE SET "seq" = s."seq" WHERE false');
    expect(poolQuery.mock.calls[2][1]).toEqual([CHANNEL]);
    expect(sql[3]).toBe('SELECT 1 FROM messages WHERE "id" = $1::uuid');
    // the +1 ms chain only while it stays within 5 s of the clock
    expect(sql[4]).toContain('SELECT CASE WHEN n."next" <= c."clock" + interval \'5 seconds\' THEN GREATEST(c."clock", n."next") ELSE c."clock" END AS "at"');
    expect(sql[4]).toContain('FROM (SELECT clock_timestamp() AS "clock") c, (SELECT max(m."createdAt") + interval \'1 millisecond\' AS "next" FROM messages m WHERE m."channelId" = $3::uuid) n');
    expect(sql[4]).toContain('ON CONFLICT ("id") DO NOTHING RETURNING "createdAt", "updatedAt", "id", "syncSeq"');
    // the creator's read marker is the message's own createdAt
    expect(sql[4]).toContain('SELECT $2::uuid, $3::uuid, i."createdAt" FROM inserted i ON CONFLICT ("userId", "channelId")');
    expect(sql[5]).toBe('COMMIT');
  });

  it('answers a known id from the stored message without the lock or an INSERT', async () => {
    const stored = row('17', { id: MESSAGE, creatorId: USER });
    mockCreate({ idChecks: [true], stored: [stored] });
    const result = await messageHelper.createMessage(USER, request);
    expect(result).toEqual({
      message: expect.objectContaining({ id: MESSAGE, creatorId: USER, syncSeq: 17 }),
      userAlias: '',
      created: false,
    });
    expect(insertCalls()).toHaveLength(0);
    expect(statements()).not.toContain('BEGIN');
    const lookup = normalize(poolQuery.mock.calls[1][0]);
    expect(lookup).toContain(`m."channelId" = '${CHANNEL}'::UUID AND m."deletedAt" IS NULL`);
    expect(lookup).toContain(`m."id" = '${MESSAGE}'::UUID AND m."creatorId" = '${USER}'::UUID`);
  });

  it('refuses an id taken by another user, another channel or a deleted message, without an INSERT', async () => {
    mockCreate({ idChecks: [true], stored: [] });
    await expect(messageHelper.createMessage(USER, request)).rejects.toThrow('NOT_ALLOWED');
    expect(insertCalls()).toHaveLength(0);
  });

  it('a same-id create that committed while waiting for the lock: no INSERT, the stored message', async () => {
    mockCreate({ idChecks: [false, true], stored: [row('17', { id: MESSAGE, creatorId: USER })] });
    await expect(messageHelper.createMessage(USER, request)).resolves.toEqual(expect.objectContaining({ created: false }));
    expect(insertCalls()).toHaveLength(0);
    expect(statements()).toContain('COMMIT');
  });

  it('a same-id create in another channel that wins the race: ON CONFLICT, then the lookup', async () => {
    mockCreate({ idChecks: [false, false], inserts: [{ rows: [] }], stored: [] });
    await expect(messageHelper.createMessage(USER, request)).rejects.toThrow('NOT_ALLOWED');
    expect(insertCalls()).toHaveLength(1);
  });

  it('retries a (channelId, createdAt) collision in a new transaction', async () => {
    mockCreate({ idChecks: [false, false, false], inserts: [collision(), { rows: [inserted] }] });
    await expect(messageHelper.createMessage(USER, request)).resolves.toEqual(expect.objectContaining({ created: true }));
    expect(insertCalls()).toHaveLength(2);
    expect(insertCalls()[1][0]).toBe(insertCalls()[0][0]);
    expect(statements().filter(sql => sql === 'ROLLBACK')).toHaveLength(1);
    expect(statements().filter(sql => sql === 'BEGIN')).toHaveLength(2);
  });

  it('gives up after three attempts', async () => {
    mockCreate({ idChecks: [false, false, false, false], inserts: [collision(), collision(), collision()] });
    await expect(messageHelper.createMessage(USER, request)).rejects.toThrow('duplicate key');
    expect(insertCalls()).toHaveLength(3);
  });

  it('does not retry other errors', async () => {
    mockCreate({ idChecks: [false, false], inserts: [Object.assign(new Error('fk'), { code: '23503', table: 'messages' })] });
    await expect(messageHelper.createMessage(USER, request)).rejects.toThrow('fk');
    expect(insertCalls()).toHaveLength(1);
    expect(statements()).toContain('ROLLBACK');
  });
});
