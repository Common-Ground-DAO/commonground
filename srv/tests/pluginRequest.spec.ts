// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * `/pluginRequest` order of checks: validation and signature verification
 * happen before anything is stored; the replay key is bounded and expires.
 */

import crypto from 'crypto';

const handlers: Record<string, (request: any, response: any, data: any) => Promise<any>> = {};
const redisSet = jest.fn();
const rateLimiter = jest.fn();

const pluginHelper = {
  getCommunityPlugin: jest.fn(),
  getPlugin: jest.fn(),
  getUserPluginPermissions: jest.fn(),
};
const communityHelper = {
  getCommunityDetailView: jest.fn(),
};

jest.mock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, _validator: unknown, handler: any) => {
    handlers[path] = handler;
  },
}));
jest.mock('../redis', () => ({
  __esModule: true,
  default: { getClient: () => ({ set: (...args: any[]) => redisSet(...args) }) },
}));
jest.mock('../util/rateLimit', () => ({ __esModule: true, default: () => rateLimiter }));
jest.mock('../repositories/plugins', () => ({ __esModule: true, default: pluginHelper }));
jest.mock('../repositories/communities', () => ({ __esModule: true, default: communityHelper }));
jest.mock('../repositories/users', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/event', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/files', () => ({
  __esModule: true,
  default: { getSignedUrls: jest.fn(async (ids: string[]) => ids.map(() => ({ url: '' }))) },
}));

import validators from '../validators';
import '../api/plugins';

const USER = '00000000-0000-4000-8000-000000000001';
const COMMUNITY_PLUGIN = '00000000-0000-4000-8000-0000000000a1';
const PLUGIN = '00000000-0000-4000-8000-0000000000b1';
const COMMUNITY = '00000000-0000-4000-8000-0000000000c1';

const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
});

function signed(inner: object, key = privateKey) {
  const request = JSON.stringify(inner);
  const sign = crypto.createSign('SHA256');
  sign.update(request);
  sign.end();
  return { request, signature: sign.sign(key, 'base64') };
}

const inner = (overrides: object = {}) => ({
  type: 'request',
  pluginId: COMMUNITY_PLUGIN,
  requestId: `requestId-${Date.now()}-${crypto.randomUUID()}`,
  iframeUid: 'abcdefghij',
  data: { type: 'communityInfo' },
  ...overrides,
});

const call = (data: any) => handlers['/pluginRequest']({ session: { user: { id: USER } } }, {}, data);

beforeEach(() => {
  jest.clearAllMocks();
  pluginHelper.getCommunityPlugin.mockResolvedValue({ id: COMMUNITY_PLUGIN, pluginId: PLUGIN, communityId: COMMUNITY });
  pluginHelper.getPlugin.mockResolvedValue({ id: PLUGIN, publicKey, privateKey, permissions: null });
  pluginHelper.getUserPluginPermissions.mockResolvedValue({ acceptedPermissions: [] });
  communityHelper.getCommunityDetailView.mockResolvedValue({
    id: COMMUNITY, title: 't', url: 'u', smallLogoId: null, largeLogoId: null, headerImageId: null,
    official: false, premium: null, roles: [],
  });
  redisSet.mockResolvedValue('OK');
});

describe('/pluginRequest', () => {
  it('stores nothing for a request with an invalid signature', async () => {
    const { request } = signed(inner());
    const { signature } = signed({ other: true });
    await expect(call({ request, signature })).rejects.toThrow('INVALID_SIGNATURE');
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('stores nothing for a malformed request', async () => {
    await expect(call({ request: 'not json', signature: 'x' })).rejects.toThrow('INVALID_REQUEST');
    await expect(call(signed(inner({ requestId: 'x'.repeat(100_000) })))).rejects.toThrow('INVALID_REQUEST');
    expect(pluginHelper.getCommunityPlugin).not.toHaveBeenCalled();
    expect(redisSet).not.toHaveBeenCalled();
  });

  it.each([
    ['without a timestamp', 'requestId-abc-0000'],
    ['from the past', `requestId-${Date.now() - 11 * 60 * 1000}-0000`],
    ['from the future', `requestId-${Date.now() + 60 * 60 * 1000}-0000`],
  ])('rejects a request %s', async (_label, requestId) => {
    await expect(call(signed(inner({ requestId })))).rejects.toThrow(/SIGNED_REQUEST_EXPIRED|INVALID_REQUEST/);
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('accepts the reference client\'s `<counter>-<ms>` request ids', async () => {
    await call(signed(inner({ requestId: `7-${Date.now()}` })));
    expect(redisSet).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^pluginRequest:${COMMUNITY_PLUGIN}:7-\\d+$`)),
      '1',
      expect.anything(),
    );
  });

  it('answers a well-formed but old request id with the expiry error', async () => {
    await expect(call(signed(inner({ requestId: `1-${Date.now() - 11 * 60 * 1000}` }))))
      .rejects.toThrow('SIGNED_REQUEST_EXPIRED');
    await expect(call(signed(inner({ requestId: `requestId-${Date.now() - 11 * 60 * 1000}-${crypto.randomUUID()}` }))))
      .rejects.toThrow('SIGNED_REQUEST_EXPIRED');
    expect(redisSet).not.toHaveBeenCalled();
  });

  it('records a valid request once, with an expiry', async () => {
    const data = signed(inner());
    await call(data);
    expect(rateLimiter).toHaveBeenCalled();
    expect(redisSet).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^pluginRequest:${COMMUNITY_PLUGIN}:requestId-\\d+-`)),
      '1',
      { expiration: { type: 'EX', value: 900 }, condition: 'NX' },
    );

    redisSet.mockResolvedValue(null);
    await expect(call(data)).rejects.toThrow('DUPLICATED_SIGNED_REQUEST');
  });
});

describe('pluginRequest validators', () => {
  it('bound the outer request', () => {
    expect(validators.API.Plugin.pluginRequest.validate({ request: 'x'.repeat(10_000), signature: 'x' }).error).toBeDefined();
    expect(validators.API.Plugin.pluginRequest.validate({ request: 'x', signature: 'x'.repeat(10_000) }).error).toBeDefined();
  });

  it('accept the request ids of the plugin library and the reference client', () => {
    expect(validators.API.Plugin.pluginRequestInner.validate(inner()).error).toBeUndefined();
    expect(validators.API.Plugin.pluginRequestInner.validate(inner({ requestId: `1-${Date.now()}` })).error).toBeUndefined();
    expect(validators.API.Plugin.pluginRequestInner.validate(inner({ requestId: `x-${'1'.repeat(200)}` })).error).toBeDefined();
  });
});
