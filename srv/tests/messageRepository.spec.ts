// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * SQL-level contract of message deletion and of the access-scope lookup in
 * `repositories/messages.ts`, with the pool mocked.
 */

const poolQuery = jest.fn();
const clientRelease = jest.fn();

// pool.query and the queries of a checked-out client both go to poolQuery
jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: {
    query: (...args: any[]) => poolQuery(...args),
    connect: async () => ({ query: (...args: any[]) => poolQuery(...args), release: clientRelease }),
  },
}));
jest.mock('../repositories/files', () => ({ __esModule: true, default: {} }));

import messageHelper from '../repositories/messages';

const USER = '00000000-0000-4000-8000-000000000001';
const CHANNEL = '00000000-0000-4000-8000-0000000000a1';
const MESSAGE = '00000000-0000-4000-8000-0000000000d1';
const SCOPE = '00000000-0000-4000-8000-0000000000e1';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ');
/** the soft-delete statement among the calls (it runs in a transaction) */
const deleteCall = () => poolQuery.mock.calls.find(([sql]) => sql.includes('WITH removed_messages'));
const targetCall = () => poolQuery.mock.calls.find(([sql]) => normalize(sql).includes('SELECT m.id FROM messages m'))!;
const REPLY = '00000000-0000-4000-8000-0000000000d2';
const OTHER_TARGET = '00000000-0000-4000-8000-0000000000d3';

/**
 * Answers the delete transaction's statements: `targets` for the target
 * select, `locked` for the message lock, `deleteData` for the soft delete.
 */
function mockDeleteTransaction(
  targets: string[],
  locked: { id: string, parentMessageId: string | null, deletedAt: Date | null }[],
  deleteData: unknown,
) {
  poolQuery.mockImplementation(async (sql: string) => {
    const text = normalize(sql);
    if (text.includes('WITH removed_messages')) return { rows: [{ deleteData }] };
    if (text.includes('FOR NO KEY UPDATE')) return { rows: locked };
    if (text.includes('FROM reactions')) return { rows: [] };
    if (text.includes('SELECT m.id FROM messages m')) return { rows: targets.map(id => ({ id })) };
    return { rows: [] };
  });
}

beforeEach(() => {
  poolQuery.mockReset();
  clientRelease.mockReset();
});

describe('messageHelper.deleteMessage', () => {
  it('selects by creator, channel and message id and writes only the locked rows', async () => {
    mockDeleteTransaction([MESSAGE], [
      { id: MESSAGE, parentMessageId: null, deletedAt: null },
      { id: REPLY, parentMessageId: MESSAGE, deletedAt: null },
    ], { deleted: [{ id: MESSAGE, syncSeq: 7 }], updatedParents: [{ id: REPLY, syncSeq: 8 }], dbNow: 'now' });
    await expect(messageHelper.deleteMessage({ messageId: MESSAGE, channelId: CHANNEL, creatorId: USER })).resolves.toEqual({
      deletedIds: [MESSAGE],
      deletedSyncSeqs: [7],
      updatedParentIdToNull: [REPLY],
      updatedParents: [{ id: REPLY, syncSeq: 8 }],
      dbNow: 'now',
    });
    expect(normalize(targetCall()[0])).toContain('WHERE m."creatorId" = $1 AND m."channelId" = $2 AND m."deletedAt" IS NULL AND m."id" = $3');
    expect(targetCall()[1]).toEqual([USER, CHANNEL, MESSAGE]);
    const [sql, params] = deleteCall()!;
    const text = normalize(sql);
    expect(text).toContain('WHERE m."creatorId" = $1 AND m."channelId" = $2 AND m."deletedAt" IS NULL AND m."id" = ANY($3::uuid[])');
    expect(text).toContain('WHERE "id" = ANY($4::uuid[]) AND "parentMessageId" = ANY(SELECT id FROM removed_messages)');
    expect(text).toContain('RETURNING m.id, m."syncSeq"');
    expect(params).toEqual([USER, CHANNEL, [MESSAGE], [REPLY]]);
  });

  it('locks reactions, then messages FOR NO KEY UPDATE, before the write, in one transaction', async () => {
    mockDeleteTransaction([MESSAGE], [{ id: MESSAGE, parentMessageId: null, deletedAt: null }], { deleted: [], updatedParents: [], dbNow: '' });
    await messageHelper.deleteMessage({ messageId: MESSAGE, channelId: CHANNEL, creatorId: USER });
    const statements = poolQuery.mock.calls.map(([sql]) => normalize(sql).trim());
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toMatch(/^SELECT m.id FROM messages m .* ORDER BY m.id$/);
    expect(statements[2]).toBe('SELECT 1 FROM reactions WHERE "itemId" = ANY($1::uuid[]) ORDER BY "userId", "itemId" FOR UPDATE');
    expect(poolQuery.mock.calls[2][1]).toEqual([[MESSAGE]]);
    expect(statements[3]).toBe('SELECT id, "parentMessageId", "deletedAt" FROM messages WHERE id = ANY($1::uuid[]) OR "parentMessageId" = ANY($1::uuid[]) ORDER BY id FOR NO KEY UPDATE');
    expect(poolQuery.mock.calls[3][1]).toEqual([[MESSAGE]]);
    expect(statements[4]).toContain('WITH removed_messages');
    expect(statements[5]).toBe('COMMIT');
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('writes nothing when the target is gone or was deleted meanwhile', async () => {
    mockDeleteTransaction([], [], null);
    await expect(messageHelper.deleteMessage({ messageId: MESSAGE, channelId: CHANNEL, creatorId: USER }))
      .resolves.toEqual(expect.objectContaining({ deletedIds: [], updatedParents: [] }));
    expect(deleteCall()).toBeUndefined();

    poolQuery.mockReset();
    mockDeleteTransaction([MESSAGE], [{ id: MESSAGE, parentMessageId: null, deletedAt: new Date() }], null);
    await expect(messageHelper.deleteMessage({ messageId: MESSAGE, channelId: CHANNEL, creatorId: USER }))
      .resolves.toEqual(expect.objectContaining({ deletedIds: [] }));
    expect(deleteCall()).toBeUndefined();
    expect(normalize(poolQuery.mock.calls[poolQuery.mock.calls.length - 1][0]).trim()).toBe('COMMIT');
  });

  it('rolls back and releases the connection on an error', async () => {
    poolQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockRejectedValueOnce(new Error('lock failed'))
      .mockResolvedValue({ rows: [] });
    await expect(messageHelper.deleteMessage({ messageId: MESSAGE, channelId: CHANNEL, creatorId: USER }))
      .rejects.toThrow('lock failed');
    expect(normalize(poolQuery.mock.calls[2][0]).trim()).toBe('ROLLBACK');
    expect(clientRelease).toHaveBeenCalledTimes(1);
  });

  it('refuses to run without a channel', async () => {
    await expect(messageHelper.deleteMessage({ messageId: MESSAGE, channelId: '', creatorId: USER }))
      .rejects.toThrow();
    expect(poolQuery).not.toHaveBeenCalled();
  });
});

describe('messageHelper.deleteAllUserMessages', () => {
  it('selects by creator and channel; a reply that is itself a target is deleted, not cleaned', async () => {
    mockDeleteTransaction([MESSAGE, OTHER_TARGET], [
      { id: MESSAGE, parentMessageId: null, deletedAt: null },
      { id: OTHER_TARGET, parentMessageId: MESSAGE, deletedAt: null },
    ], { deleted: [], updatedParents: [], dbNow: '' });
    await messageHelper.deleteAllUserMessages({
      access: { communityId: SCOPE, channelId: CHANNEL },
      creatorId: USER,
    });
    expect(normalize(targetCall()[0])).toContain('WHERE m."creatorId" = $1 AND m."channelId" = $2 AND m."deletedAt" IS NULL ORDER BY m.id');
    expect(targetCall()[1]).toEqual([USER, CHANNEL]);
    expect(deleteCall()![1]).toEqual([USER, CHANNEL, [MESSAGE, OTHER_TARGET], []]);
  });
});

describe('messageHelper.editMessage', () => {
  it('filters by creator, channel and message id', async () => {
    poolQuery.mockResolvedValue({ rows: [{ updatedAt: '', editedAt: '' }] });
    await messageHelper.editMessage(USER, {
      access: { communityId: SCOPE, channelId: CHANNEL },
      id: MESSAGE,
      body: { version: '1', content: [] },
    } as any);
    const [sql, params] = poolQuery.mock.calls[0];
    expect(normalize(sql)).toContain('WHERE id = $2 AND "creatorId" = $1 AND "channelId" = $3 AND "deletedAt" IS NULL');
    expect(params.slice(0, 3)).toEqual([USER, MESSAGE, CHANNEL]);
  });

  it('refuses a message outside the channel', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await expect(messageHelper.editMessage(USER, {
      access: { communityId: SCOPE, channelId: CHANNEL },
      id: MESSAGE,
      body: { version: '1', content: [] },
    } as any)).rejects.toThrow('NOT_ALLOWED');
  });
});

describe('messageHelper.unsetReaction', () => {
  it('only touches reactions and counters of a message in the channel', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await messageHelper.unsetReaction(USER, {
      access: { communityId: SCOPE, channelId: CHANNEL },
      messageId: MESSAGE,
    });
    const [sql, params] = poolQuery.mock.calls[0];
    const normalized = normalize(sql);
    // the reaction row is only marked deleted for a message in the channel ...
    expect(normalized).toMatch(/UPDATE reactions .* AND EXISTS \( SELECT 1 FROM messages m WHERE m."id" = \$2 AND m."channelId" = \$3 \) RETURNING "reaction"/);
    // ... and the counter update is restricted the same way
    expect(normalized).toContain('WHERE "id" = $2 AND "channelId" = $3 AND EXISTS (SELECT 1 FROM delete_reaction)');
    expect(params).toEqual([USER, MESSAGE, CHANNEL]);
  });
});

describe('messageHelper.isChannelInAccessScope', () => {
  it.each([
    [{ communityId: SCOPE, channelId: CHANNEL }, 'FROM communities_channels', [SCOPE, CHANNEL]],
    [{ chatId: SCOPE, channelId: CHANNEL }, 'FROM chats', [SCOPE, CHANNEL]],
    [{ callId: SCOPE, channelId: CHANNEL }, 'FROM calls', [SCOPE, CHANNEL]],
    [{ articleId: SCOPE, articleCommunityId: USER, channelId: CHANNEL }, 'communities_articles', [SCOPE, CHANNEL, USER]],
    [{ articleId: SCOPE, articleUserId: USER, channelId: CHANNEL }, 'users_articles', [SCOPE, CHANNEL, USER, null]],
  ])('checks %o against its table', async (access, table, params) => {
    poolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(messageHelper.isChannelInAccessScope(access as any)).resolves.toBe(true);
    expect(poolQuery.mock.calls[0][0]).toContain(table);
    expect(poolQuery.mock.calls[0][1]).toEqual(params);

    poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(messageHelper.isChannelInAccessScope(access as any)).resolves.toBe(false);
  });

  it.each([
    ['communities_channels', { communityId: SCOPE, channelId: CHANNEL }, ['"deletedAt" IS NULL']],
    ['chats', { chatId: SCOPE, channelId: CHANNEL }, ['"deletedAt" IS NULL']],
    ['community articles', { articleId: SCOPE, articleCommunityId: USER, channelId: CHANNEL }, ['a."deletedAt" IS NULL', 'ca."deletedAt" IS NULL']],
    ['user articles', { articleId: SCOPE, articleUserId: USER, channelId: CHANNEL }, ['a."deletedAt" IS NULL', 'ua."deletedAt" IS NULL']],
  ])('ignores deleted rows (%s)', async (_label, access, conditions) => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await messageHelper.isChannelInAccessScope(access as any);
    for (const condition of conditions) {
      expect(normalize(poolQuery.mock.calls[0][0])).toContain(condition);
    }
  });

  it('requires the community of a community channel to be live', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(messageHelper.isChannelInAccessScope({ communityId: SCOPE, channelId: CHANNEL } as any)).resolves.toBe(false);
    const normalized = normalize(poolQuery.mock.calls[0][0]);
    expect(normalized).toContain('FROM communities_channels cc INNER JOIN communities c ON c."id" = cc."communityId"');
    expect(normalized).toContain('WHERE cc."communityId" = $1 AND cc."channelId" = $2');
    // a leading space, so that `cc."deletedAt"` does not count for `c."deletedAt"`
    expect(normalized).toContain(' cc."deletedAt" IS NULL');
    expect(normalized).toContain(' c."deletedAt" IS NULL');
  });

  it('counts an unpublished user article only for its author', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await messageHelper.isChannelInAccessScope({ articleId: SCOPE, articleUserId: USER, channelId: CHANNEL } as any, MESSAGE);
    expect(normalize(poolQuery.mock.calls[0][0])).toContain('AND (ua."published" < now() OR ua."userId" = $4::uuid)');
    expect(poolQuery.mock.calls[0][1]).toEqual([SCOPE, CHANNEL, USER, MESSAGE]);
  });

  it('rejects an article access without its owner', async () => {
    await expect(messageHelper.isChannelInAccessScope({ articleId: SCOPE, channelId: CHANNEL } as any))
      .resolves.toBe(false);
    expect(poolQuery).not.toHaveBeenCalled();
  });
});

describe('messageHelper.setChannelLastRead', () => {
  it('never moves the stored read marker backwards and returns the stored value', async () => {
    const stored = new Date('2026-11-02T12:00:00.000Z');
    poolQuery.mockResolvedValue({ rows: [{ lastRead: stored, unread: 3, syncSeq: '41' }] });
    await expect(messageHelper.setChannelLastRead(USER, {
      access: { communityId: SCOPE, channelId: CHANNEL },
      lastRead: '2026-11-02T11:00:00.000Z',
    })).resolves.toEqual({ lastRead: stored.toISOString(), unread: 3, syncSeq: 41 });
    const [sql, params] = poolQuery.mock.calls[0];
    const normalized = normalize(sql);
    // clamped to now(); a message id in the channel takes precedence over the posted time
    expect(normalized).toContain('VALUES ($1, $2, LEAST( COALESCE( (SELECT m."createdAt" FROM messages m WHERE m."id" = $4::uuid AND m."channelId" = $2::uuid), $3::timestamptz ), now() ))');
    expect(normalized).toContain('ON CONFLICT ("userId", "channelId") DO UPDATE SET "lastRead" = GREATEST(channelreadstate."lastRead", EXCLUDED."lastRead") RETURNING "lastRead"');
    // unread: other users' messages after the stored value, capped
    expect(normalized).toContain('AND m."createdAt" > u."lastRead" AND m."creatorId" <> $1::uuid LIMIT 999');
    expect(normalized).toContain('COALESCE((SELECT s."seq" FROM channel_sync_state s WHERE s."channelId" = $2::uuid), 0) AS "syncSeq"');
    expect(params).toEqual([USER, CHANNEL, '2026-11-02T11:00:00.000Z', null]);
  });

  it('passes the message id the client has seen', async () => {
    const MESSAGE_SEEN = '00000000-0000-4000-8000-0000000000d2';
    poolQuery.mockResolvedValue({ rows: [{ lastRead: new Date('2026-11-02T12:00:00.000Z'), unread: 0, syncSeq: '0' }] });
    await expect(messageHelper.setChannelLastRead(USER, {
      access: { chatId: SCOPE, channelId: CHANNEL },
      lastRead: '2026-11-02T11:00:00.000Z',
      messageId: MESSAGE_SEEN,
    })).resolves.toEqual({ lastRead: '2026-11-02T12:00:00.000Z', unread: 0, syncSeq: 0 });
    expect(poolQuery.mock.calls[0][1]).toEqual([USER, CHANNEL, '2026-11-02T11:00:00.000Z', MESSAGE_SEEN]);
  });
});

describe('messageHelper.isChannelInActiveCommunity', () => {
  it('requires a live channel of a live community', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ '?column?': 1 }] });
    await expect(messageHelper.isChannelInActiveCommunity(SCOPE, CHANNEL)).resolves.toBe(true);
    const [sql, params] = poolQuery.mock.calls[0];
    const normalized = normalize(sql);
    expect(normalized).toContain('FROM communities_channels cc INNER JOIN communities c ON c."id" = cc."communityId"');
    expect(normalized).toContain('WHERE cc."communityId" = $1 AND cc."channelId" = $2');
    expect(normalized).toContain('cc."deletedAt" IS NULL');
    expect(normalized).toContain('c."deletedAt" IS NULL');
    expect(params).toEqual([SCOPE, CHANNEL]);
  });

  it('is false without a matching row (deleted channel or community, foreign pair)', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [] });
    await expect(messageHelper.isChannelInActiveCommunity(SCOPE, CHANNEL)).resolves.toBe(false);
  });
});
