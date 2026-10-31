// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * `/getUrlPreview`: session requirement, cache use, rate limit placement and
 * what gets stored. The handler is captured from `registerPostRoute`; fetching,
 * scraping, image storage and Redis are mocked.
 */

const handlers: Record<string, (request: any, response: any, data: any) => Promise<any>> = {};
const redisGet = jest.fn();
const redisSet = jest.fn();
const rateLimiter = jest.fn();
const safeFetchMock = jest.fn();
const ogsMock = jest.fn();
const saveImage = jest.fn();

jest.mock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, _validator: unknown, handler: any) => {
    handlers[path] = handler;
  },
}));
jest.mock('../redis', () => ({
  __esModule: true,
  default: {
    get: (...args: any[]) => redisGet(...args),
    getClient: () => ({ set: (...args: any[]) => redisSet(...args) }),
  },
}));
jest.mock('../util/rateLimit', () => ({ __esModule: true, default: () => rateLimiter }));
jest.mock('../util/safeFetch', () => ({ __esModule: true, default: (...args: any[]) => safeFetchMock(...args) }));
jest.mock('open-graph-scraper', () => (...args: any[]) => ogsMock(...args));
jest.mock('../repositories/files', () => ({ __esModule: true, default: { saveImage: (...args: any[]) => saveImage(...args) } }));
jest.mock('../repositories/messages', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/permissions', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/chats', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/communities', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/event', () => ({ __esModule: true, default: { emit: jest.fn() } }));
jest.mock('../repositories/notifications', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/articles', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/bots', () => ({ __esModule: true, default: {} }));
jest.mock('../util/botPrincipal', () => ({ allowBotRoute: jest.fn() }));
jest.mock('../util/botRateLimit', () => ({ enforceBotRateLimit: jest.fn() }));

import '../api/messages';

const URL = 'https://example.com/post';
const loggedIn = { session: { user: { id: '00000000-0000-4000-8000-000000000001' } } };
const preview = (request: any, url = URL) => handlers['/getUrlPreview'](request, {}, { url });

function scrapes(result: Record<string, unknown>) {
  safeFetchMock.mockResolvedValueOnce({ url: URL, status: 200, contentType: 'text/html', body: Buffer.from('<html></html>') });
  ogsMock.mockResolvedValueOnce({ error: false, result });
}

beforeEach(() => {
  jest.clearAllMocks();
  redisGet.mockResolvedValue(null);
  redisSet.mockResolvedValue('OK');
  rateLimiter.mockResolvedValue(undefined);
});

describe('/getUrlPreview', () => {
  it('requires a session', async () => {
    await expect(preview({ session: {} })).rejects.toThrow('LOGIN_REQUIRED');
    expect(redisGet).not.toHaveBeenCalled();
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('answers from the cache without counting against the limit', async () => {
    const cached = { title: 't', description: 'd', imageId: '', url: URL };
    redisGet.mockResolvedValue(JSON.stringify(cached));
    await expect(preview(loggedIn)).resolves.toEqual(cached);
    expect(redisGet).toHaveBeenCalledWith('data', expect.stringMatching(/^urlpreview:[0-9a-f]{64}$/));
    expect(rateLimiter).not.toHaveBeenCalled();
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('applies the rate limit before fetching', async () => {
    rateLimiter.mockRejectedValue(new Error('RATE_LIMIT_EXCEEDED'));
    await expect(preview(loggedIn)).rejects.toThrow('RATE_LIMIT_EXCEEDED');
    expect(safeFetchMock).not.toHaveBeenCalled();
  });

  it('builds, caps and caches a preview', async () => {
    scrapes({ ogTitle: 'x'.repeat(5000), ogDescription: 'desc', ogUrl: 'https://example.com/canonical' });
    const result = await preview(loggedIn);
    expect(result).toEqual({
      title: 'x'.repeat(2000),
      description: 'desc',
      imageId: '',
      url: 'https://example.com/canonical',
    });
    expect(redisSet).toHaveBeenCalledWith(
      expect.stringMatching(/^urlpreview:/),
      JSON.stringify(result),
      { EX: 3600 },
    );
  });

  it.each([
    ['a non-http og:url', 'javascript:alert(1)'],
    ['an overlong og:url', `https://example.com/${'a'.repeat(3000)}`],
    ['an unparsable og:url', 'not a url'],
  ])('links to the requested URL for %s', async (_label, ogUrl) => {
    scrapes({ ogTitle: 't', ogUrl });
    const result = await preview(loggedIn);
    expect(result.url).toBe(URL);
  });

  it('does not cache an oversized preview', async () => {
    // 2000 three-byte characters per field exceed the cache entry limit
    scrapes({ ogTitle: '€'.repeat(3000), ogDescription: '€'.repeat(3000) });
    const result = await preview(loggedIn);
    expect(result.title.length).toBe(2000);
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('rejects pages it cannot fetch', async () => {
    safeFetchMock.mockRejectedValueOnce(new Error('BLOCKED_ADDRESS'));
    await expect(preview(loggedIn)).rejects.toThrow('INVALID_REQUEST');
    expect(redisSet).not.toHaveBeenCalled();
  });
});
