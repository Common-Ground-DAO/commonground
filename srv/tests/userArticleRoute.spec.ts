// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * `/User/getArticleDetailView` hands the session user to the repository as
 * the requesting user, separate from the article's author in the request.
 * The handler is captured from `registerPostRoute`; everything else is mocked.
 */

const handlers: Record<string, (request: any, response: any, data: any) => Promise<any>> = {};
const getUserArticleDetailView = jest.fn();

jest.mock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, _validator: unknown, handler: any) => {
    handlers[path] = handler;
  },
}));
jest.mock('../repositories/articles', () => ({
  __esModule: true,
  default: { getUserArticleDetailView: (...args: any[]) => getUserArticleDetailView(...args) },
}));
jest.mock('../redis', () => ({ __esModule: true, default: { get: jest.fn(), getClient: jest.fn(() => ({})) } }));
jest.mock('../util/rateLimit', () => ({
  __esModule: true,
  default: () => jest.fn(),
  keyRateLimitHandler: () => jest.fn(),
  failureBudget: () => ({ reserve: jest.fn() }),
  reserveFailures: jest.fn(),
  clientPrefixKey: jest.fn(),
  ipFailureLimiter: () => ({ assertBelow: jest.fn(), recordFailure: jest.fn() }),
}));
jest.mock('../util/captcha', () => ({ verifyCaptchaToken: jest.fn() }));
jest.mock('../util/safeFetch', () => ({ fetchRemoteImage: jest.fn() }));
jest.mock('../api/emails', () => ({ __esModule: true, default: {}, emailEnabled: () => false }));
for (const repository of [
  'users', 'suggestedUsers', 'wallets', 'device', 'communities', 'files', 'chats',
  'event', 'notifications', 'onchain', 'permissions', 'emails',
]) {
  jest.doMock(`../repositories/${repository}`, () => ({ __esModule: true, default: {} }));
}

const AUTHOR = '00000000-0000-4000-8000-000000000001';
const READER = '00000000-0000-4000-8000-000000000002';
const ARTICLE = '00000000-0000-4000-8000-0000000000e1';

beforeAll(() => {
  // loaded after the doMock calls above
  require('../api/user');
});

beforeEach(() => {
  getUserArticleDetailView.mockReset();
  getUserArticleDetailView.mockResolvedValue({ userId: AUTHOR, articleId: ARTICLE, article: { title: 't' } });
});

describe('/getArticleDetailView (user articles)', () => {
  const data = { userId: AUTHOR, articleId: ARTICLE };

  it('passes the logged-in user as the requesting user', async () => {
    const result = await handlers['/getArticleDetailView']({ session: { user: { id: READER } } }, {}, data);
    expect(getUserArticleDetailView).toHaveBeenCalledWith(READER, data);
    expect(result).toEqual({ userArticle: { userId: AUTHOR, articleId: ARTICLE }, article: { title: 't' } });
  });

  it('passes no requesting user for anonymous readers', async () => {
    await handlers['/getArticleDetailView']({ session: {} }, {}, data);
    expect(getUserArticleDetailView).toHaveBeenCalledWith(undefined, data);
  });

  it('passes on a hidden article as not found', async () => {
    getUserArticleDetailView.mockRejectedValue(new Error('NOT_FOUND'));
    await expect(handlers['/getArticleDetailView']({ session: {} }, {}, data)).rejects.toThrow('NOT_FOUND');
  });
});
