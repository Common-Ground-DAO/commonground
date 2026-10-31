// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * A user article without a publish date, or with one in the future, is only
 * visible to its author: in the detail view, in article search, and as the
 * scope of its comment channel. Query level, with the pool mocked.
 */

const poolQuery = jest.fn();
const handlers: Record<string, (request: any, response: any, data: any) => Promise<any>> = {};

jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => poolQuery(...args) },
}));
jest.mock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, _validator: unknown, handler: any) => {
    handlers[path] = handler;
  },
}));
jest.mock('../repositories/communities', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/emails', () => ({ __esModule: true, default: {} }));
jest.mock('../api/emails', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/files', () => ({ __esModule: true, default: {} }));

import articleHelper from '../repositories/articles';
import messageHelper from '../repositories/messages';
import '../api/search';

const AUTHOR = '00000000-0000-4000-8000-000000000001';
const READER = '00000000-0000-4000-8000-000000000002';
const ARTICLE = '00000000-0000-4000-8000-0000000000e1';
const CHANNEL = '00000000-0000-4000-8000-0000000000a1';

const normalize = (sql: string) => sql.replace(/\s+/g, ' ');
const VISIBILITY = 'AND (ua."published" < now() OR ua."userId" = $2::uuid)';

beforeEach(() => {
  poolQuery.mockReset();
});

describe('user article detail view', () => {
  const row = { userId: AUTHOR, articleId: ARTICLE, url: null, published: null, updatedAt: '', article: {} };

  it('passes the author and the requesting user separately', async () => {
    poolQuery.mockResolvedValue({ rows: [row] });
    await articleHelper.getUserArticleDetailView(READER, { userId: AUTHOR, articleId: ARTICLE });
    const [sql, params] = poolQuery.mock.calls[0];
    expect(normalize(sql)).toContain('AND ua."userId" = $1');
    expect(normalize(sql)).toContain(VISIBILITY);
    expect(params).toEqual([AUTHOR, READER]);
  });

  it('matches no unpublished article for anonymous readers', async () => {
    poolQuery.mockResolvedValue({ rows: [row] });
    await articleHelper.getUserArticleDetailView(undefined, { userId: AUTHOR, articleId: ARTICLE });
    expect(poolQuery.mock.calls[0][1]).toEqual([AUTHOR, null]);
  });

  it('reports a hidden article as not found', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await expect(articleHelper.getUserArticleDetailView(READER, { userId: AUTHOR, articleId: ARTICLE }))
      .rejects.toThrow('NOT_FOUND');
  });
});

describe('article search', () => {
  it('lists user articles only once they are published', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await handlers['/searchArticles']({ session: {} }, {}, { type: 'all', query: null, limit: 10 });
    const sql = normalize(poolQuery.mock.calls[0][0]);
    expect(sql).toContain('AND (ca."communityId" IS NOT NULL OR ua."published" < now())');
  });
});

describe('comment channel of a user article', () => {
  it('uses the same visibility rule as the detail view', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await messageHelper.isChannelInAccessScope(
      { articleId: ARTICLE, articleUserId: AUTHOR, channelId: CHANNEL } as any,
      READER,
    );
    const [sql, params] = poolQuery.mock.calls[0];
    expect(normalize(sql)).toContain('AND (ua."published" < now() OR ua."userId" = $4::uuid)');
    expect(params).toEqual([ARTICLE, CHANNEL, AUTHOR, READER]);
  });
});
