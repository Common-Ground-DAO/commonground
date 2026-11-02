// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The api talks to the onchain service over HTTP; every wrapper in
 * `repositories/onchain.ts` has to unwrap the service's JSON envelope into the
 * shape its signature promises. These tests pin the envelopes the service
 * (`srv/onchain.ts`) actually sends.
 */

const axiosPost = jest.fn();

jest.mock('../util/axios', () => ({
  __esModule: true,
  default: { post: (...args: any[]) => axiosPost(...args) },
}));
jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: jest.fn() },
}));

import onchainHelper from '../repositories/onchain';

const UP = '0x' + '1'.repeat(40);

function respondWith(data: unknown) {
  axiosPost.mockResolvedValueOnce({ status: 200, data });
}

describe('onchainHelper.luksoIsValidSignature', () => {
  beforeEach(() => axiosPost.mockReset());

  it('returns true for a valid signature', async () => {
    respondWith({ isValidSignature: true });
    await expect(onchainHelper.luksoIsValidSignature(UP, '0xsig', 'msg')).resolves.toBe(true);
    expect(axiosPost).toHaveBeenCalledWith(
      'http://onchain:4000/luksoIsValidSignature',
      { address: UP, signature: '0xsig', message: 'msg' },
      expect.anything(),
    );
  });

  it('rejects an invalid signature', async () => {
    respondWith({ isValidSignature: false });
    await expect(onchainHelper.luksoIsValidSignature(UP, '0xsig', 'msg')).resolves.toBe(false);
  });

  it('only accepts a literal true', async () => {
    for (const data of [{}, { isValidSignature: 'true' }, { isValidSignature: 1 }, true, null, '']) {
      respondWith(data);
      await expect(onchainHelper.luksoIsValidSignature(UP, '0xsig', 'msg')).resolves.toBe(false);
    }
  });

  it('propagates service errors instead of passing', async () => {
    axiosPost.mockRejectedValueOnce(new Error('Request failed with status code 500'));
    await expect(onchainHelper.luksoIsValidSignature(UP, '0xsig', 'msg')).rejects.toThrow();
  });
});

describe('onchainHelper response envelopes', () => {
  beforeEach(() => axiosPost.mockReset());

  it('unwraps { data } for the role-claimability checks', async () => {
    respondWith({ data: false });
    await expect(onchainHelper.checkRoleClaimability({} as any)).resolves.toBe(false);
    respondWith({ data: [{ roleId: 'r', claimable: true }] });
    await expect(onchainHelper.checkMultiRoleClaimability({} as any)).resolves.toEqual([{ roleId: 'r', claimable: true }]);
    respondWith({ data: [] });
    await expect(onchainHelper.checkCommunityRoleClaimability({} as any)).resolves.toEqual([]);
  });

  it('unwraps { balance } for getErc20Balance', async () => {
    respondWith({ balance: '42' });
    await expect(onchainHelper.getErc20Balance('eth', UP as any, UP as any)).resolves.toBe('42');
  });
});

describe('onchainHelper without the onchain service (CG_ENABLE_BLOCKCHAIN=false)', () => {
  let disabledHelper: typeof onchainHelper;
  const previous = process.env.CG_ENABLE_BLOCKCHAIN;

  beforeAll(() => {
    process.env.CG_ENABLE_BLOCKCHAIN = 'false';
    jest.isolateModules(() => {
      disabledHelper = require('../repositories/onchain').default;
    });
  });
  afterAll(() => {
    if (previous === undefined) delete process.env.CG_ENABLE_BLOCKCHAIN;
    else process.env.CG_ENABLE_BLOCKCHAIN = previous;
  });
  beforeEach(() => axiosPost.mockReset());

  it('answers "nothing claimable" for the community role check, without a request', async () => {
    await expect(disabledHelper.checkCommunityRoleClaimability({ userId: 'u', communityId: 'c' })).resolves.toEqual([]);
    expect(axiosPost).not.toHaveBeenCalled();
  });

  it('still fails the calls that cannot be answered without the service', async () => {
    await expect(disabledHelper.luksoIsValidSignature(UP, '0xsig', 'msg')).rejects.toThrow('SERVICE_UNAVAILABLE');
    await expect(disabledHelper.getErc20Balance('eth', UP as any, UP as any)).rejects.toThrow('SERVICE_UNAVAILABLE');
    expect(axiosPost).not.toHaveBeenCalled();
  });
});
