// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Sign-In with Ethereum messages parsed by their structure
 * (srv/util/siweMessage.ts), and the Farcaster sign-in check
 * (Accounts/Farcaster/verifyLogin, srv/api/accounts.ts) with real signatures:
 * the claimed FID comes from the one `farcaster://fid/` resource wherever it
 * stands, and the message must name this instance (domain and URI) like a
 * wallet sign-in message.
 */

process.env.BASE_URL = 'https://app.cg';
process.env.DEPLOYMENT = 'prod';

import { ethers } from 'ethers';
import { farcasterIdOf, parseSiweMessage, assertSiweMessageCurrent } from '../util/siweMessage';

type Handler = (request: any, response: any, data: any) => Promise<any>;
const routes: Record<string, Handler> = {};
const farcasterApi = jest.fn();
jest.doMock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, _validator: unknown, handler: Handler) => {
    routes[path] = handler;
  },
  farcasterApi: (...args: unknown[]) => farcasterApi(...args),
}));
jest.doMock('../util/postgres', () => ({ __esModule: true, default: { query: jest.fn() } }));
jest.doMock('../redis', () => require('./helpers/memoryRedis'));
jest.doMock('../util/rateLimit', () => ({ __esModule: true, default: () => jest.fn(async () => undefined) }));
const getUserAccount = jest.fn();
jest.doMock('../repositories/users', () => ({ __esModule: true, default: { getUserAccount: (...args: unknown[]) => getUserAccount(...args) } }));
const saveImage = jest.fn();
jest.doMock('../repositories/files', () => ({ __esModule: true, default: { saveImage: (...args: unknown[]) => saveImage(...args) } }));
const fetchRemoteImage = jest.fn();
jest.doMock('../util/safeFetch', () => ({ fetchRemoteImage: (...args: unknown[]) => fetchRemoteImage(...args) }));

const wallet = new ethers.Wallet('0x' + '11'.repeat(32));
const NONCE = 'abcdefghij0123456789';

function message(options: {
  domain?: string;
  uri?: string;
  statement?: string | null;
  issuedAt?: string;
  extra?: string[];
  resources?: string[];
  address?: string;
} = {}) {
  const lines = [
    `${options.domain ?? 'app.cg'} wants you to sign in with your Ethereum account:`,
    options.address ?? wallet.address,
    '',
  ];
  if (options.statement !== null) {
    lines.push(options.statement ?? 'Farcaster Auth', '');
  }
  else {
    lines.push('');
  }
  lines.push(
    `URI: ${options.uri ?? 'https://app.cg/login'}`,
    'Version: 1',
    'Chain ID: 10',
    `Nonce: ${NONCE}`,
    `Issued At: ${options.issuedAt ?? new Date().toISOString()}`,
    ...(options.extra ?? []),
  );
  const resources = options.resources ?? ['farcaster://fid/1234'];
  if (resources.length > 0) {
    lines.push('Resources:', ...resources.map(resource => `- ${resource}`));
  }
  return lines.join('\n');
}

describe('parseSiweMessage', () => {
  it('reads every field by its label', () => {
    const parsed = parseSiweMessage(message({ extra: ['Expiration Time: 2999-01-01T00:00:00.000Z', 'Request ID: r1'] }));
    expect(parsed).toMatchObject({
      domain: 'app.cg',
      address: wallet.address.toLowerCase(),
      statement: 'Farcaster Auth',
      uri: 'https://app.cg/login',
      version: '1',
      chainId: '10',
      nonce: NONCE,
      expirationTime: '2999-01-01T00:00:00.000Z',
      notBefore: null,
      requestId: 'r1',
      resources: ['farcaster://fid/1234'],
    });
  });

  it('reads messages without a statement and without resources (the web app\'s wallet message)', () => {
    const parsed = parseSiweMessage(message({ statement: null, resources: [] }));
    expect(parsed.statement).toBeNull();
    expect(parsed.uri).toBe('https://app.cg/login');
    expect(parsed.resources).toEqual([]);
  });

  it('refuses malformed messages', () => {
    const good = message();
    const bad = [
      good.replace('wants you to sign in', 'would like you to sign in'),
      good.replace(wallet.address, '0x1234'),
      good.replace('\nVersion: 1', ''),
      good.replace('URI: ', 'Uri: '),
      good.replace('Chain ID: 10', 'Chain ID: ten'),
      good.replace(`Nonce: ${NONCE}`, 'Nonce: short'),
      good.replace(/Issued At: .*/, 'Issued At: yesterday'),
      // fields out of order, or a field twice
      good.replace('Version: 1\nChain ID: 10', 'Chain ID: 10\nVersion: 1'),
      good.replace('Version: 1', 'Version: 1\nVersion: 1'),
      // a scheme in the domain line (the domain is an authority)
      good.replace('app.cg wants you', 'https://app.cg wants you'),
      // trailing garbage, CRLF
      `${good}\nsomething else`,
      good.replace(/\n/g, '\r\n'),
    ];
    for (const text of bad) {
      expect(() => parseSiweMessage(text)).toThrow('INVALID_REQUEST');
    }
  });

  it('checks expiry and not-before', () => {
    expect(() => assertSiweMessageCurrent(parseSiweMessage(message({ extra: ['Expiration Time: 2000-01-01T00:00:00.000Z'] })))).toThrow('INVALID_SIGNATURE');
    expect(() => assertSiweMessageCurrent(parseSiweMessage(message({ extra: ['Not Before: 2999-01-01T00:00:00.000Z'] })))).toThrow('INVALID_SIGNATURE');
    expect(() => assertSiweMessageCurrent(parseSiweMessage(message()))).not.toThrow();
  });
});

describe('farcasterIdOf', () => {
  it('takes the one farcaster://fid/ resource, wherever it stands', () => {
    expect(farcasterIdOf(parseSiweMessage(message({ resources: ['https://example.org/x', 'farcaster://fid/77'] })))).toBe(77);
    expect(farcasterIdOf(parseSiweMessage(message({ extra: ['Request ID: abc'], resources: ['farcaster://fid/5'] })))).toBe(5);
  });

  it('refuses none, two, or a malformed one', () => {
    for (const resources of [[], ['farcaster://fid/1', 'farcaster://fid/2'], ['farcaster://fid/12x'], ['farcaster://fid/'], ['farcaster://fid/0']]) {
      expect(() => farcasterIdOf(parseSiweMessage(message({ resources })))).toThrow('INVALID_REQUEST');
    }
  });
});

describe('Accounts/Farcaster/verifyLogin', () => {
  let verifyLogin: Handler;
  beforeAll(() => {
    jest.isolateModules(() => {
      require('../api/accounts');
    });
    verifyLogin = routes['/Farcaster/verifyLogin'];
  });

  beforeEach(() => {
    farcasterApi.mockReset();
    getUserAccount.mockReset();
    farcasterApi.mockImplementation(async (type: string) => (type === 'onChainIdRegistryEventByAddress' ? { fid: 1234 } : { messages: [] }));
    getUserAccount.mockResolvedValue({
      displayName: 'Someone',
      imageId: null,
      data: { type: 'farcaster', id: '1234' },
      extraData: { type: 'farcaster', username: 'someone' },
    });
  });

  async function attempt(text: string, signer = wallet) {
    const request: any = { session: { signSecret: NONCE } };
    return verifyLogin(request, {}, { message: text, signature: await signer.signMessage(text) });
  }

  it('signs in with a message for this instance', async () => {
    const result = await attempt(message());
    expect(result).toMatchObject({ fid: 1234, readyForLogin: true });
  });

  it('refuses a message made for another site (domain or URI)', async () => {
    await expect(attempt(message({ domain: 'evil.example', uri: 'https://evil.example/' }))).rejects.toThrow('INVALID_SIGNATURE');
    await expect(attempt(message({ domain: 'app.cg', uri: 'https://evil.example/' }))).rejects.toThrow('INVALID_SIGNATURE');
    await expect(attempt(message({ domain: 'evil.example', uri: 'https://app.cg/' }))).rejects.toThrow('INVALID_SIGNATURE');
    expect(farcasterApi).not.toHaveBeenCalled();
  });

  it('refuses a message signed by someone else, an old one, or one with another nonce', async () => {
    await expect(attempt(message(), new ethers.Wallet('0x' + '22'.repeat(32)))).rejects.toThrow('INVALID_SIGNATURE');
    await expect(attempt(message({ issuedAt: new Date(Date.now() - 5 * 60_000).toISOString() }))).rejects.toThrow();
    const request: any = { session: { signSecret: 'otherNonce0123456789' } };
    const text = message();
    await expect(verifyLogin(request, {}, { message: text, signature: await wallet.signMessage(text) })).rejects.toThrow('INVALID_SECRET');
  });

  it('on a gateway: an FID without an account is refused before any profile lookup or image fetch', async () => {
    getUserAccount.mockResolvedValue(null);
    process.env.CG_GATEWAY = 'true';
    try {
      await expect(attempt(message())).rejects.toThrow('ACCOUNT_DOES_NOT_EXIST');
    }
    finally {
      delete process.env.CG_GATEWAY;
    }
    // only the registry check ran: no userDataByFid, nothing fetched or stored
    expect(farcasterApi.mock.calls.map(call => call[0])).toEqual(['onChainIdRegistryEventByAddress']);
    expect(fetchRemoteImage).not.toHaveBeenCalled();
    expect(saveImage).not.toHaveBeenCalled();
    // the same on the main instance prepares the sign-up (profile lookup)
    farcasterApi.mockClear();
    await attempt(message()).catch(() => undefined);
    expect(farcasterApi.mock.calls.map(call => call[0])).toContain('userDataByFid');
  });

  it('takes the FID from the resource even when optional fields come before it, and checks it against the registry', async () => {
    await expect(attempt(message({ extra: ['Expiration Time: 2999-01-01T00:00:00.000Z', 'Request ID: x1'] }))).resolves.toMatchObject({ fid: 1234 });
    farcasterApi.mockImplementation(async () => ({ fid: 999 }));
    await expect(attempt(message())).rejects.toThrow('Farcaster ID mismatch');
  });
});
