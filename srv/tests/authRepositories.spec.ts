// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Repository- and helper-level contracts behind sign-in (pool mocked):
 * password check with rehash and the policy flag, the transfer-token
 * statements, the wallet sign-in message's domain, and what unexpected errors
 * may put into the log.
 */

process.env.BASE_URL = 'https://cg.box';
process.env.DEPLOYMENT = 'prod';

import * as bcrypt from 'bcrypt';

const poolQuery = jest.fn();
const clientQuery = jest.fn();
const clientRelease = jest.fn();
jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: {
    query: (...args: any[]) => poolQuery(...args),
    connect: async () => ({ query: (...args: any[]) => clientQuery(...args), release: clientRelease }),
  },
}));
jest.mock('../redis', () => require('./helpers/memoryRedis'));
for (const name of ['event', 'notifications', 'files', 'onchain', 'staking']) {
  jest.mock(`../repositories/${name}`, () => ({ __esModule: true, default: {} }));
}
jest.mock('../onchain/scheduler', () => ({ OnchainPriority: {} }));
jest.mock('puppeteer', () => ({ __esModule: true, default: {} }));

import userHelper, { BCRYPT_COST } from '../repositories/users';
import transferTokenHelper from '../repositories/transferTokens';
import { assertSiweForThisInstance } from '../repositories/wallets';
import { hashTransferToken } from '../util/transferLink';
import { describeErrorForLog } from '../api/util';

const USER = '00000000-0000-4000-8000-000000000001';
const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim();

beforeEach(() => {
  poolQuery.mockReset();
  clientQuery.mockReset();
  clientRelease.mockReset();
});

describe('password login check', () => {
  let ownDataSpy: jest.SpyInstance;
  beforeEach(() => {
    ownDataSpy = jest.spyOn(userHelper, 'getOwnDataById').mockResolvedValue({ id: USER } as any);
  });
  afterEach(() => ownDataSpy.mockRestore());

  it('new hashes use cost 12', () => {
    expect(BCRYPT_COST).toBe(12);
  });

  it('a correct password with an old, cheaper hash: rehashed with cost 12', async () => {
    const oldHash = await bcrypt.hash('correct horse', 4);
    poolQuery.mockResolvedValueOnce({ rows: [{ password: oldHash }] }).mockResolvedValue({ rows: [], rowCount: 1 });
    await expect(userHelper.checkPasswordLogin(USER, 'correct horse')).resolves.toEqual({ id: USER });
    const rehash = poolQuery.mock.calls.find(([sql]) => normalize(sql).startsWith('UPDATE users SET "password" = $3'));
    expect(rehash).toBeDefined();
    const [, params] = rehash!;
    expect(params[0]).toBe(USER);
    expect(params[1]).toBe(oldHash);
    expect(bcrypt.getRounds(params[2])).toBe(12);
    await expect(bcrypt.compare('correct horse', params[2])).resolves.toBe(true);
    // meets the policy: no change required
    expect(poolQuery.mock.calls.some(([sql]) => sql.includes('"passwordChangeRequired" = TRUE'))).toBe(false);
  });

  it('a password below the policy signs in, and the account must choose a new one', async () => {
    const hash = await bcrypt.hash('short', 12);
    poolQuery.mockResolvedValueOnce({ rows: [{ password: hash }] }).mockResolvedValue({ rows: [], rowCount: 1 });
    await userHelper.checkPasswordLogin(USER, 'short');
    expect(poolQuery.mock.calls.some(([sql, params]) => sql.includes('"passwordChangeRequired" = TRUE') && params[0] === USER)).toBe(true);
    // already cost 12: no rehash
    expect(poolQuery.mock.calls.some(([sql]) => normalize(sql).startsWith('UPDATE users SET "password" = $3'))).toBe(false);
  });

  it('wrong password, unknown account and an account without password: NOT_ALLOWED', async () => {
    poolQuery.mockResolvedValueOnce({ rows: [{ password: await bcrypt.hash('correct horse', 4) }] });
    await expect(userHelper.checkPasswordLogin(USER, 'wrong')).rejects.toThrow('NOT_ALLOWED');
    await expect(userHelper.checkPasswordLogin(null, 'whatever')).rejects.toThrow('NOT_ALLOWED');
    poolQuery.mockResolvedValueOnce({ rows: [{ password: null }] });
    await expect(userHelper.checkPasswordLogin(USER, 'whatever')).rejects.toThrow('NOT_ALLOWED');
    expect(ownDataSpy).not.toHaveBeenCalled();
  }, 20000);

  it('setting a password ends a pending password change', async () => {
    poolQuery.mockResolvedValue({ rows: [], rowCount: 1 });
    await userHelper.setPassword(USER, 'a new password');
    const [sql, params] = poolQuery.mock.calls[0];
    expect(normalize(sql)).toContain('SET "password" = $2, "passwordChangeRequired" = FALSE');
    expect(bcrypt.getRounds(params[1])).toBe(12);
  });

  it('confirming an address: an unverified holder loses it in the same transaction', async () => {
    const OTHER = '00000000-0000-4000-8000-000000000002';
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('"email" = NULL')) return { rows: [{ id: OTHER }] };
      if (sql.includes('WITH previous')) return { rows: [{ previousEmail: null, previousVerified: false }] };
      return { rows: [] };
    });
    await expect(userHelper.setVerifiedEmail(USER, 'mine@example.org')).resolves.toEqual({ previousEmail: null, previousVerified: false, clearedFrom: [OTHER] });
    const statements = clientQuery.mock.calls.map(([sql]) => normalize(sql));
    expect(statements[0]).toBe('BEGIN');
    expect(statements[1]).toContain('WHERE LOWER("email") = LOWER($2) AND "id" <> $1 AND "emailVerified" = FALSE');
    expect(statements[2]).toContain('SET "email" = $2, "emailVerified" = TRUE');
    expect(statements[3]).toBe('COMMIT');
    expect(clientRelease).toHaveBeenCalled();
  });

  it('a verified address of another account is EXISTS_ALREADY (rolled back)', async () => {
    clientQuery.mockImplementation(async (sql: string) => {
      if (sql.includes('WITH previous')) throw Object.assign(new Error('duplicate key'), { code: '23505' });
      return { rows: [] };
    });
    await expect(userHelper.setVerifiedEmail(USER, 'taken@example.org')).rejects.toThrow('EXISTS_ALREADY');
    expect(clientQuery.mock.calls.map(([sql]) => normalize(sql))).toContain('ROLLBACK');
  });

  it('a failed check against an older, cheaper hash takes as long as one against cost 12', async () => {
    const oldHash = await bcrypt.hash('correct horse', 4);
    const fullHash = await bcrypt.hash('correct horse', 12);
    // warm up the throwaway hash (created once per process)
    await expect(userHelper.checkPasswordLogin(null, 'x')).rejects.toThrow('NOT_ALLOWED');
    let started = Date.now();
    await bcrypt.compare('wrong', fullHash);
    const fullCheckMs = Date.now() - started;
    poolQuery.mockResolvedValueOnce({ rows: [{ password: oldHash }] });
    started = Date.now();
    await expect(userHelper.checkPasswordLogin(USER, 'wrong')).rejects.toThrow('NOT_ALLOWED');
    // the cheap check plus one against the cost-12 throwaway hash
    expect(Date.now() - started).toBeGreaterThanOrEqual(fullCheckMs * 0.5);
  }, 20000);

  it('a password below the policy is flagged once, and other sessions are told', async () => {
    const memoryRedis = require('./helpers/memoryRedis');
    memoryRedis.keys.clear();
    poolQuery.mockResolvedValueOnce({ rows: [{ password: await bcrypt.hash('short', 12) }] }).mockResolvedValue({ rows: [], rowCount: 1 });
    await userHelper.checkPasswordLogin(USER, 'short');
    expect(memoryRedis.keys.get(`security-step-version:${USER}`)).toBe('1');
  }, 20000);
});

describe('transfer token statements', () => {
  it('stores only the hash, with the user and an expiry', async () => {
    poolQuery.mockResolvedValue({ rows: [{ expiresAt: new Date() }] });
    const { token } = await transferTokenHelper.create(USER, '/c/x/', 600000);
    const insert = poolQuery.mock.calls.find(([sql]) => sql.includes('INSERT INTO transfer_tokens'))!;
    expect(insert[1]).toEqual([USER, hashTransferToken(token), '/c/x/', 600000]);
    expect(JSON.stringify(poolQuery.mock.calls)).not.toContain(token);
    expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it('redemption is one conditional UPDATE: unused, unexpired, live account', async () => {
    poolQuery.mockResolvedValue({ rows: [] });
    await expect(transferTokenHelper.consume('t'.repeat(43))).resolves.toBeNull();
    const [sql, params] = poolQuery.mock.calls[0];
    const statement = normalize(sql);
    expect(statement).toMatch(/^UPDATE transfer_tokens t SET "usedAt" = now\(\) WHERE t\."tokenHash" = \$1 AND t\."usedAt" IS NULL AND t\."expiresAt" > now\(\)/);
    expect(statement).toContain('u."deletedAt" IS NULL AND u.is_bot = FALSE');
    expect(statement).toContain('RETURNING t."userId", t."nextPath"');
    expect(params).toEqual([hashTransferToken('t'.repeat(43))]);
    expect(poolQuery).toHaveBeenCalledTimes(1);
  });
});

describe('wallet sign-in message domain', () => {
  const line = (host: string) => `${host} wants you to sign in with your Ethereum account:`;
  it('accepts a message made for this instance', () => {
    expect(() => assertSiweForThisInstance(line('cg.box'), 'https://cg.box', ['https://cg.box'])).not.toThrow();
    expect(() => assertSiweForThisInstance(line('localhost:3000'), 'http://localhost:3000', ['https://cg.box', 'http://localhost:3000'])).not.toThrow();
  });

  it.each([
    [line('evil.com'), 'https://evil.com'],
    [line('cg.box'), 'https://evil.com'],
    [line('evil.com'), 'https://cg.box'],
    [line('cg.box'), 'https://cg.box.evil.com'],
    [line('cg.box'), 'http://cg.box'],
    [line('sub.cg.box'), 'https://sub.cg.box'],
    ['cg.box wants you to sign in', 'https://cg.box'],
    [undefined, 'https://cg.box'],
    [line('cg.box'), 'not a url'],
  ])('refuses %j / %s', (domainLine, uri) => {
    expect(() => assertSiweForThisInstance(domainLine, uri, ['https://cg.box'])).toThrow('INVALID_SIGNATURE');
  });
});

describe('logging of unexpected errors', () => {
  it('never the error object (it can hold the request it sent)', () => {
    const httpError = Object.assign(new Error('Request failed with status code 500'), {
      config: { data: '{"secret":"recaptcha-secret","password":"hunter2hunter2"}' },
    });
    const logged = describeErrorForLog(httpError);
    expect(logged).toContain('Request failed with status code 500');
    expect(logged).not.toContain('hunter2');
    expect(logged).not.toContain('recaptcha-secret');
    expect(describeErrorForLog({ password: 'hunter2' })).not.toContain('hunter2');
  });
});
