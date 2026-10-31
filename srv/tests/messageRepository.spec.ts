// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * SQL-level contract of message deletion and of the access-scope lookup in
 * `repositories/messages.ts`, with the pool mocked.
 */

const poolQuery = jest.fn();

jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => poolQuery(...args) },
}));
jest.mock('../repositories/files', () => ({ __esModule: true, default: {} }));

import messageHelper from '../repositories/messages';

const USER = '00000000-0000-4000-8000-000000000001';
const CHANNEL = '00000000-0000-4000-8000-0000000000a1';
const MESSAGE = '00000000-0000-4000-8000-0000000000d1';
const SCOPE = '00000000-0000-4000-8000-0000000000e1';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ');

beforeEach(() => {
  poolQuery.mockReset();
});

describe('messageHelper.deleteMessage', () => {
  it('filters by creator, channel and message id', async () => {
    poolQuery.mockResolvedValue({ rows: [{ deleteData: { deletedIds: [MESSAGE], updatedParentIdToNull: [], dbNow: '' } }] });
    await messageHelper.deleteMessage({ messageId: MESSAGE, channelId: CHANNEL, creatorId: USER });
    const [sql, params] = poolQuery.mock.calls[0];
    expect(normalize(sql)).toContain('WHERE m."creatorId" = $1 AND m."channelId" = $2 AND m."deletedAt" IS NULL AND m."id" = $3');
    expect(params).toEqual([USER, CHANNEL, MESSAGE]);
  });

  it('refuses to run without a channel', async () => {
    await expect(messageHelper.deleteMessage({ messageId: MESSAGE, channelId: '', creatorId: USER }))
      .rejects.toThrow();
    expect(poolQuery).not.toHaveBeenCalled();
  });
});

describe('messageHelper.deleteAllUserMessages', () => {
  it('filters by creator and channel', async () => {
    poolQuery.mockResolvedValue({ rows: [{ deleteData: { deletedIds: [], updatedParentIdToNull: [], dbNow: '' } }] });
    await messageHelper.deleteAllUserMessages({
      access: { communityId: SCOPE, channelId: CHANNEL },
      creatorId: USER,
    });
    const [sql, params] = poolQuery.mock.calls[0];
    expect(normalize(sql)).toContain('WHERE m."creatorId" = $1 AND m."channelId" = $2 AND m."deletedAt" IS NULL RETURNING');
    expect(params).toEqual([USER, CHANNEL]);
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
