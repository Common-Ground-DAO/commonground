// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Transfer links (User/createTransferLink, previewTransferLink,
 * redeemTransferLink), the account-security step (middleware, the "add a way
 * in" guard, User/getSecurityStatus), email codes bound to their address
 * (login code, email verification) and the login throttles — srv/api/user.ts
 * with the repositories mocked. Transfer tokens live in an in-memory table
 * with the same use-once semantics as the SQL (see transferTokenRepository
 * below for the statement itself).
 */

process.env.BASE_URL = 'https://cg.box';
process.env.DEPLOYMENT = 'prod';
delete process.env.CG_LEGACY_CGID;

import * as memoryRedis from './helpers/memoryRedis';

type Handler = (request: any, response: any, data: any) => Promise<any>;
const routes: Record<string, { handler: Handler; validator?: { validateAsync: (data: unknown) => Promise<any> } }> = {};
let currentDomain = '';

jest.doMock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, validator: any, handler: Handler) => {
    routes[`${currentDomain}${path}`] = { handler, validator };
  },
}));
jest.doMock('../redis', () => require('./helpers/memoryRedis'));
// the database function behind the realtime check (security_step_db_required,
// see the migration), answered from the facts below
jest.doMock('../util/postgres', () => ({
  __esModule: true,
  default: {
    query: jest.fn(async (sql: string, params: unknown[]) => {
      if (!sql.includes('security_step_db_required')) return { rows: [] };
      const f = facts[params[0] as string];
      const required = !f || f.passkeys + (f.hasPassword ? 1 : 0) + f.loginWallets === 0 || (f.hasPassword && f.passwordChangeRequired);
      return { rows: [{ required }] };
    }),
  },
}));

// rate limits: counted in memory, so budgets can be exhausted in a test
const limiterCalls: Record<string, number> = {};
const limiterBudgets: Record<string, number> = {};
function countingLimiter(bucket: string, limit: number) {
  return jest.fn(async () => {
    limiterCalls[bucket] = (limiterCalls[bucket] || 0) + 1;
    if (limiterCalls[bucket] > (limiterBudgets[bucket] ?? limit)) {
      throw new Error('RATE_LIMIT_EXCEEDED');
    }
  });
}
const failureState = { failures: 0, limit: 3 };
// failure budgets (failureBudget), counted per bucket:key — reserve() adds and
// checks in one synchronous step, like the MULTI it stands for
const failureCounts: Record<string, number> = {};
const NETWORK = 'v4:203.0.113';
jest.doMock('../util/rateLimit', () => ({
  __esModule: true,
  default: (options: { bucket?: string; limit_v4_v6_64: number }) => {
    const limiter = countingLimiter(`ip:${options.bucket ?? 'url'}`, options.limit_v4_v6_64);
    return Object.assign(limiter, { peek: async () => undefined, buckets: () => [{ run: limiter }] });
  },
  keyRateLimitHandler: (options: { bucket: string; limit: number }) => {
    const perKey: Record<string, jest.Mock> = {};
    const forKey = (key: string) => (perKey[key] ??= countingLimiter(`${options.bucket}:${key}`, options.limit));
    return Object.assign(async (key: string) => { await forKey(key)(); }, { buckets: (key: string) => [{ run: forKey(key) }] });
  },
  enforceLimits: async (buckets: { run: () => Promise<void> }[]) => {
    for (const bucket of buckets) await bucket.run();
  },
  peekLimits: async () => undefined,
  failureBudget: (options: { bucket: string; limit: number }) => ({
    reserve: jest.fn(async (key: string) => {
      const name = `${options.bucket}:${key}`;
      failureCounts[name] = (failureCounts[name] || 0) + 1;
      const release = async () => { failureCounts[name]--; };
      if (failureCounts[name] > (limiterBudgets[name] ?? options.limit)) {
        await release();
        throw new Error('RATE_LIMIT_EXCEEDED');
      }
      return { release };
    }),
  }),
  reserveFailures: async (list: { budget: { reserve: (key: string) => Promise<{ release: () => Promise<void> }> }; key: string }[]) => {
    const taken: { release: () => Promise<void> }[] = [];
    try {
      for (const { budget, key } of list) taken.push(await budget.reserve(key));
    }
    catch (e) {
      for (const t of taken) await t.release();
      throw e;
    }
    return { release: async () => { for (const t of taken) await t.release(); } };
  },
  clientPrefixKey: () => NETWORK,
  ipFailureLimiter: () => ({
    assertBelow: jest.fn(async () => {
      if (failureState.failures >= failureState.limit) throw new Error('RATE_LIMIT_EXCEEDED');
    }),
    recordFailure: jest.fn(async () => { failureState.failures++; }),
  }),
  extractIpFromRequest: () => ({ ipString: '203.0.113.1' }),
}));
jest.doMock('../util/captcha', () => ({ verifyCaptchaToken: jest.fn(async () => true) }));
jest.doMock('../util/safeFetch', () => ({ fetchRemoteImage: jest.fn() }));

let mailEnabled = true;
const emailUtils = {
  sendSignupCodeEmail: jest.fn(async () => undefined),
  sendSignupAddressTakenEmail: jest.fn(async () => undefined),
  sendNewSignInMethodEmail: jest.fn(async () => undefined),
  sendVerificationEmail: jest.fn(async () => undefined),
  sendOneTimePasswordEmail: jest.fn(async () => undefined),
  sendAddressInUseEmail: jest.fn(async () => undefined),
  sendEmailChangedEmail: jest.fn(async () => undefined),
  sendPasswordChangedEmail: jest.fn(async () => undefined),
};
jest.doMock('../api/emails', () => ({ __esModule: true, default: emailUtils, emailEnabled: () => mailEnabled }));

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';
const DEVICE_KEY = { crv: 'P-384', ext: true, key_ops: ['verify'], kty: 'EC', x: 'x', y: 'y' };

// --- the account's security facts (srv/repositories/loginMethods.ts)
type Facts = {
  email: string | null; emailVerified: boolean; hasPassword: boolean;
  passwordChangeRequired: boolean; passkeys: number; loginWallets: number;
};
const COMPLETE: Facts = { email: 'someone@example.org', emailVerified: true, hasPassword: true, passwordChangeRequired: false, passkeys: 0, loginWallets: 0 };
const facts: Record<string, Facts> = {};
jest.doMock('../repositories/loginMethods', () => ({
  ...jest.requireActual('../repositories/loginMethods'),
  getSecurityFacts: jest.fn(async (_db: unknown, userId: string) => facts[userId] ? { ...facts[userId] } : null),
}));

// --- transfer tokens: a table with the semantics of the SQL statements
type TokenRow = { hash: string; userId: string; nextPath: string | null; expiresAt: number; usedAt: number | null };
const tokenRows: TokenRow[] = [];
const transferTokens = {
  create: jest.fn(async (userId: string, nextPath: string | null, ttlMs: number) => {
    const { newTransferToken, hashTransferToken } = require('../util/transferLink');
    const token = newTransferToken();
    const expiresAt = Date.now() + ttlMs;
    tokenRows.push({ hash: hashTransferToken(token), userId, nextPath, expiresAt, usedAt: null });
    return { token, expiresAt: new Date(expiresAt) };
  }),
  peek: jest.fn(async (token: string) => {
    const { hashTransferToken } = require('../util/transferLink');
    const row = tokenRows.find(r => r.hash === hashTransferToken(token) && r.usedAt === null && r.expiresAt > Date.now());
    return row ? { userId: row.userId, expiresAt: new Date(row.expiresAt) } : null;
  }),
  consume: jest.fn(async (token: string) => {
    const { hashTransferToken } = require('../util/transferLink');
    // one atomic step, like UPDATE … WHERE "usedAt" IS NULL … RETURNING
    const row = tokenRows.find(r => r.hash === hashTransferToken(token) && r.usedAt === null && r.expiresAt > Date.now());
    if (!row) return null;
    row.usedAt = Date.now();
    return { userId: row.userId, nextPath: row.nextPath };
  }),
};

function ownData(id: string): any {
  const f = facts[id] ?? COMPLETE;
  return {
    id,
    email: f.email,
    emailVerified: f.emailVerified,
    displayAccount: 'cg',
    accounts: [{ type: 'cg', displayName: id === USER ? 'someone' : 'other' }],
  };
}
const users = {
  getOwnDataById: jest.fn(async (id: string) => ownData(id)),
  findPasswordLoginUserId: jest.fn(async (identifier: string) => identifier.startsWith('someone') ? USER : null),
  checkPasswordLogin: jest.fn(async (userId: string | null, password: string) => {
    if (userId !== USER || password !== 'correct horse') throw new Error('NOT_ALLOWED');
    return ownData(USER);
  }),
  getVerifiedUserIdByEmail: jest.fn(async (email: string) => {
    const match = Object.entries(facts).find(([, f]) => f.emailVerified && f.email?.toLowerCase() === email.toLowerCase());
    return match ? match[0] : null;
  }),
  setVerifiedEmail: jest.fn(async (userId: string, email: string) => {
    const previous = { previousEmail: facts[userId].email, previousVerified: facts[userId].emailVerified };
    const clearedFrom: string[] = [];
    for (const [id, f] of Object.entries(facts)) {
      if (id !== userId && !f.emailVerified && f.email?.toLowerCase() === email.toLowerCase()) {
        facts[id] = { ...f, email: null };
        clearedFrom.push(id);
      }
    }
    facts[userId] = { ...facts[userId], email, emailVerified: true };
    return { ...previous, clearedFrom };
  }),
  isPasswordCorrect: jest.fn(async () => true),
  setPassword: jest.fn(async (userId: string) => {
    facts[userId] = { ...facts[userId], hasPassword: true, passwordChangeRequired: false };
  }),
  updateUser: jest.fn(async () => undefined),
  setUserExtraDataField: jest.fn(async () => undefined),
  isEmailAvailable: jest.fn(async () => true),
};
const devices = {
  createDevice: jest.fn(async () => ({ deviceId: 'device-new' })),
  updateDeviceInfo: jest.fn(async () => undefined),
  deleteDevice: jest.fn(async () => undefined),
};
const mocks: Record<string, object> = {
  users,
  device: devices,
  transferTokens,
  wallets: { getOwnWalletLoginEnabled: jest.fn(async () => false), updateWallet: jest.fn(), deleteWallet: jest.fn(), createWallet: jest.fn(async () => ({})) },
  event: { emit: jest.fn() },
  communities: { getOwnCommunities: jest.fn(async () => []) },
  chats: { getChats: jest.fn(async () => []) },
  notifications: { getUnreadCount: jest.fn(async () => 0) },
  files: {},
  emails: {},
  suggestedUsers: {},
  articles: {},
  onchain: {},
  permissions: {},
  passkeys: {},
};
for (const [name, mock] of Object.entries(mocks)) {
  jest.doMock(`../repositories/${name}`, () => ({ __esModule: true, default: mock }));
}

// --- sessions with regenerate()/save() like express-session
const sessionStore = new Map<string, Record<string, unknown>>();
let sessionCounter = 0;
function makeRequest(data: Record<string, unknown> = {}): any {
  const request: any = { headers: { 'user-agent': 'Mozilla/5.0 (X11; Linux x86_64) Firefox/140.0' }, method: 'POST' };
  const attach = (fields: Record<string, unknown>) => {
    const id = `sid-${++sessionCounter}`;
    const session: any = {
      ...fields,
      regenerate(cb: (e?: unknown) => void) {
        sessionStore.delete(id);
        attach({});
        cb();
      },
      destroy(cb: (e?: unknown) => void) {
        sessionStore.delete(id);
        delete request.session;
        cb();
      },
      save(cb?: (e?: unknown) => void) {
        const { regenerate, destroy, save, ...rest } = session;
        sessionStore.set(id, JSON.parse(JSON.stringify(rest)));
        cb?.();
      },
    };
    request.session = session;
    request.sessionID = id;
    sessionStore.set(id, { ...fields });
  };
  attach(data);
  return request;
}
const loggedIn = (userId = USER, extra: Record<string, unknown> = {}) => makeRequest({ user: { id: userId, deviceId: 'device-1' }, ...extra });
const fresh = (userId = USER, method = 'password') => loggedIn(userId, { authAt: Date.now(), authMethod: method });
/** signed in `minutes` ago with `method` */
const signedInAgo = (minutes: number, method = 'twitter', userId = USER) => loggedIn(userId, { authAt: Date.now() - minutes * 60 * 1000, authMethod: method });

async function call(name: string, request: any, data?: unknown) {
  const route = routes[name];
  if (!route) throw new Error(`no route ${name}`);
  const validated = route.validator ? await route.validator.validateAsync(data) : data;
  return route.handler(request, {}, validated);
}

let securityStep: typeof import('../util/securityStep');
let transferLink: typeof import('../util/transferLink');

beforeAll(() => {
  currentDomain = 'User';
  require('../api/user');
  currentDomain = 'Passkey';
  require('../api/passkeys');
  currentDomain = '';
  securityStep = require('../util/securityStep');
  transferLink = require('../util/transferLink');
});

let errorSpy: jest.SpyInstance;
let warnSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  memoryRedis.keys.clear();
  sessionStore.clear();
  tokenRows.splice(0);
  for (const key of Object.keys(limiterCalls)) delete limiterCalls[key];
  for (const key of Object.keys(limiterBudgets)) delete limiterBudgets[key];
  for (const key of Object.keys(failureCounts)) delete failureCounts[key];
  for (const key of Object.keys(facts)) delete facts[key];
  facts[USER] = { ...COMPLETE };
  facts[OTHER_USER] = { ...COMPLETE, email: 'other@example.org' };
  failureState.failures = 0;
  mailEnabled = true;
  delete process.env.CG_LEGACY_CGID;
  process.env.TRANSFER_TARGET_URL = 'https://cg.box';
  errorSpy = jest.spyOn(console, 'error').mockImplementation(() => undefined);
  warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  errorSpy.mockRestore();
  warnSpy.mockRestore();
  jest.useRealTimers();
});

const flush = () => new Promise(resolve => setImmediate(resolve));
const lastCode = (mock: jest.Mock) => (mock.mock.calls[mock.mock.calls.length - 1] as any[])[1] as string;

// ===========================================================================
describe('transfer links: minting', () => {
  it('only for the session\'s own user, as a fragment link to the target', async () => {
    await expect(call('User/createTransferLink', makeRequest(), {})).rejects.toThrow('LOGIN_REQUIRED');
    const { url, expiresAt } = await call('User/createTransferLink', loggedIn(), { nextPath: '/c/abc/?x=1' });
    expect(url).toMatch(/^https:\/\/cg\.box\/transfer#[A-Za-z0-9_-]{43}$/);
    expect(expiresAt).toBeGreaterThan(Date.now() + 9 * 60 * 1000);
    expect(expiresAt).toBeLessThanOrEqual(Date.now() + 10 * 60 * 1000);
    expect(transferTokens.create).toHaveBeenCalledWith(USER, '/c/abc/?x=1', 10 * 60 * 1000);
    // the stored value is the hash, never the token
    const token = url.split('#')[1];
    expect(tokenRows[0].hash).toBe(transferLink.hashTransferToken(token));
    expect(tokenRows[0].hash).not.toContain(token);
  });

  it('takes no user id, and no foreign or odd next path', async () => {
    await expect(call('User/createTransferLink', loggedIn(), { userId: OTHER_USER })).rejects.toThrow();
    for (const next of ['//evil.com', '/\\evil.com', 'https://evil.com/', 'javascript:alert(1)', '/\t/evil.com', '/transfer']) {
      await call('User/createTransferLink', loggedIn(), { nextPath: next });
      expect(transferTokens.create).toHaveBeenLastCalledWith(USER, null, expect.any(Number));
    }
  });

  it('is off without a target, and limited per user', async () => {
    delete process.env.TRANSFER_TARGET_URL;
    await expect(call('User/createTransferLink', loggedIn(), {})).rejects.toThrow('NOT_SUPPORTED');
    process.env.TRANSFER_TARGET_URL = 'https://cg.box';
    limiterBudgets[`user:transfer:create:user:${USER}`] = 2;
    await call('User/createTransferLink', loggedIn(), {});
    await call('User/createTransferLink', loggedIn(), {});
    await expect(call('User/createTransferLink', loggedIn(), {})).rejects.toThrow('RATE_LIMIT_EXCEEDED');
  });

  it('the target must be an https origin', () => {
    expect(transferLink.getTransferTargetOrigin({ TRANSFER_TARGET_URL: 'https://cg.box/' } as any)).toBe('https://cg.box');
    expect(transferLink.getTransferTargetOrigin({} as any)).toBeNull();
    expect(() => transferLink.getTransferTargetOrigin({ TRANSFER_TARGET_URL: 'http://cg.box' } as any)).toThrow();
    expect(() => transferLink.getTransferTargetOrigin({ TRANSFER_TARGET_URL: 'https://cg.box/x' } as any)).toThrow();
    expect(() => transferLink.getTransferTargetOrigin({ TRANSFER_TARGET_URL: 'cg.box' } as any)).toThrow();
  });
});

// ===========================================================================
describe('transfer links: redemption', () => {
  async function mint(nextPath?: string) {
    const { url } = await call('User/createTransferLink', loggedIn(), nextPath ? { nextPath } : {});
    return url.split('#')[1] as string;
  }

  it('preview names the account and leaves the link usable', async () => {
    const token = await mint();
    await expect(call('User/previewTransferLink', makeRequest(), { token })).resolves.toMatchObject({ userId: USER, displayName: 'someone' });
    await expect(call('User/previewTransferLink', makeRequest(), { token })).resolves.toMatchObject({ userId: USER });
    expect(tokenRows[0].usedAt).toBeNull();
  });

  it('signs in once: new session, a transfer authentication, the next path', async () => {
    const token = await mint('/c/abc/');
    const request = makeRequest({ signSecret: 'x'.repeat(20) });
    const oldSid = request.sessionID;
    const result = await call('User/redeemTransferLink', request, { token, device: { publicKey: DEVICE_KEY } });
    expect(result).toMatchObject({ ownData: { id: USER }, deviceId: 'device-new', nextPath: '/c/abc/', securityStepRequired: false });
    expect(sessionStore.has(oldSid)).toBe(false);
    expect(request.sessionID).not.toBe(oldSid);
    expect(sessionStore.get(request.sessionID)).toMatchObject({ user: { id: USER, deviceId: 'device-new' }, authMethod: 'transfer' });
    expect(request.session.signSecret).toBeUndefined();

    await expect(call('User/redeemTransferLink', makeRequest(), { token, device: { publicKey: DEVICE_KEY } })).rejects.toThrow('TRANSFER_LINK_INVALID');
    await expect(call('User/previewTransferLink', makeRequest(), { token })).rejects.toThrow('TRANSFER_LINK_INVALID');
  });

  it('two redemptions at once: exactly one succeeds', async () => {
    const token = await mint();
    const results = await Promise.allSettled([
      call('User/redeemTransferLink', makeRequest(), { token, device: { publicKey: DEVICE_KEY } }),
      call('User/redeemTransferLink', makeRequest(), { token, device: { publicKey: DEVICE_KEY } }),
    ]);
    expect(results.filter(r => r.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.message)).toEqual(['TRANSFER_LINK_INVALID']);
  });

  it('an expired link does not work', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
    const token = await mint();
    jest.setSystemTime(Date.now() + 10 * 60 * 1000 + 1);
    await expect(call('User/redeemTransferLink', makeRequest(), { token, device: { publicKey: DEVICE_KEY } })).rejects.toThrow('TRANSFER_LINK_INVALID');
  });

  it('never redeems into a logged-in session', async () => {
    const token = await mint();
    const request = loggedIn(OTHER_USER);
    await expect(call('User/redeemTransferLink', request, { token, device: { publicKey: DEVICE_KEY } })).rejects.toThrow('ALREADY_LOGGED_IN');
    expect(request.session.user.id).toBe(OTHER_USER);
    expect(tokenRows[0].usedAt).toBeNull();
  });

  it('failed attempts are limited per address', async () => {
    const token = await mint();
    const wrong = 'A'.repeat(43);
    for (let i = 0; i < failureState.limit; i++) {
      await expect(call('User/redeemTransferLink', makeRequest(), { token: wrong, device: { publicKey: DEVICE_KEY } })).rejects.toThrow('TRANSFER_LINK_INVALID');
    }
    // blocked before the lookup, even with the right token
    await expect(call('User/redeemTransferLink', makeRequest(), { token, device: { publicKey: DEVICE_KEY } })).rejects.toThrow('RATE_LIMIT_EXCEEDED');
    expect(tokenRows[0].usedAt).toBeNull();
  });

  it('a malformed token is refused by the validator', async () => {
    await expect(call('User/redeemTransferLink', makeRequest(), { token: 'short', device: { publicKey: DEVICE_KEY } })).rejects.toThrow();
  });

  it('a transfer session may add a sign-in method, not replace one', async () => {
    const token = await mint();
    const request = makeRequest();
    await call('User/redeemTransferLink', request, { token, device: { publicKey: DEVICE_KEY } });
    // the account has a password: replacing it needs a real re-authentication
    await expect(call('User/setPassword', request, { password: 'new password' })).rejects.toThrow('REAUTH_REQUIRED');
    // adding a sign-in wallet is fine
    request.session.preparedCredential = { type: 'wallet', result: { readyForCreation: true }, preWallet: { type: 'evm' } };
    await call('User/addPreparedWallet', request, { loginEnabled: true, visibility: 'private' });
    expect((mocks.wallets as any).createWallet).toHaveBeenCalled();
  });

  it('is off on a legacy CG ID (gateway) process', async () => {
    const token = await mint();
    process.env.CG_LEGACY_CGID = 'true';
    await expect(call('User/redeemTransferLink', makeRequest(), { token, device: { publicKey: DEVICE_KEY } })).rejects.toThrow('NOT_SUPPORTED');
    await expect(call('User/previewTransferLink', makeRequest(), { token })).rejects.toThrow('NOT_SUPPORTED');
  });
});

// ===========================================================================
describe('account-security step: state', () => {
  it('is derived from the account', () => {
    const status = (f: Partial<Facts>, emailRequired = true) => securityStep.securityStatusFromFacts({ ...COMPLETE, ...f }, { emailRequired });
    expect(status({}).required).toBe(false);
    expect(status({ hasPassword: false })).toMatchObject({ required: true, needsSignInMethod: true });
    expect(status({ hasPassword: false, passkeys: 1 }).required).toBe(false);
    expect(status({ hasPassword: false, loginWallets: 1 }).required).toBe(false);
    expect(status({ emailVerified: false })).toMatchObject({ required: true, needsVerifiedEmail: true });
    expect(status({ email: null, emailVerified: false }, false).required).toBe(false);
    expect(status({ passwordChangeRequired: true })).toMatchObject({ required: true, needsNewPassword: true });
    expect(status({ hasPassword: false, passwordChangeRequired: true, passkeys: 1 }).required).toBe(false);
  });

  it('User/getSecurityStatus, and the login response says whether the step is due', async () => {
    facts[USER] = { ...COMPLETE, hasPassword: false, emailVerified: false };
    await expect(call('User/getSecurityStatus', loggedIn(), {})).resolves.toMatchObject({
      required: true, needsSignInMethod: true, needsVerifiedEmail: true, needsNewPassword: false, pendingEmail: null,
      // a device-key session alone: sign in again
      recentSignIn: false,
    });
    await expect(call('User/getSecurityStatus', signedInAgo(59, 'transfer'), {})).resolves.toMatchObject({ recentSignIn: true });
    await expect(call('User/getSecurityStatus', signedInAgo(61, 'transfer'), {})).resolves.toMatchObject({ recentSignIn: false });
    const login = await call('User/login', makeRequest(), { type: 'password', aliasOrEmail: 'someone@example.org', password: 'correct horse', device: { publicKey: DEVICE_KEY } });
    expect(login.securityStepRequired).toBe(true);
    expect(memoryRedis.keys.get(`security-step:${USER}`)).toBe('1');
    facts[USER] = { ...COMPLETE };
    const request = makeRequest();
    const complete = await call('User/login', request, { type: 'password', aliasOrEmail: 'someone@example.org', password: 'correct horse', device: { publicKey: DEVICE_KEY } });
    expect(complete.securityStepRequired).toBe(false);
    expect(request.session.securityStepClearFor).toEqual({ userId: USER, version: null });
    expect(memoryRedis.keys.has(`security-step:${USER}`)).toBe(false);
  });

  it('is never due on a legacy CG ID (gateway) process', async () => {
    process.env.CG_LEGACY_CGID = 'true';
    facts[USER] = { ...COMPLETE, hasPassword: false };
    const login = await call('User/login', makeRequest(), { type: 'password', aliasOrEmail: 'someone@example.org', password: 'correct horse', device: { publicKey: DEVICE_KEY } });
    expect(login.securityStepRequired).toBe(false);
    await expect(securityStep.isSecurityStepRequiredForRealtime(USER)).resolves.toBe(false);
  });

  it('realtime logins: the database part, and the record the api keeps', async () => {
    await expect(securityStep.isSecurityStepRequiredForRealtime(USER)).resolves.toBe(false);
    facts[USER] = { ...COMPLETE, hasPassword: false };
    await expect(securityStep.isSecurityStepRequiredForRealtime(USER)).resolves.toBe(true);
    facts[USER] = { ...COMPLETE, emailVerified: false };
    // the email part needs the api's record
    await expect(securityStep.isSecurityStepRequiredForRealtime(USER)).resolves.toBe(false);
    await securityStep.computeSecurityStatus(USER, { emailRequired: true });
    await expect(securityStep.isSecurityStepRequiredForRealtime(USER)).resolves.toBe(true);
    await expect(securityStep.isSecurityStepRequiredForRealtime(USER, { useApiRecord: false })).resolves.toBe(false);
    // an unknown or deleted account never logs in
    await expect(securityStep.isSecurityStepRequiredForRealtime('00000000-0000-4000-8000-00000000dead')).resolves.toBe(true);
  });
});

// ===========================================================================
describe('account-security step: api middleware', () => {
  const middleware = () => securityStep.securityStepMiddleware(() => mailEnabled);
  async function run(request: any, path: string, method = 'POST') {
    // mounted per router in srv/api.ts: baseUrl + path is the full path
    const [, domain, ...rest] = path.split('/');
    request.method = method;
    request.baseUrl = `/${domain}`;
    request.path = `/${rest.join('/')}`;
    const response = { json: jest.fn() };
    const next = jest.fn();
    middleware()(request, response as any, next);
    await flush();
    await flush();
    return { next, response };
  }

  it('lets complete accounts through and remembers it for the session', async () => {
    const request = loggedIn();
    expect((await run(request, '/Message/createMessage')).next).toHaveBeenCalledWith();
    expect(request.session.securityStepClearFor).toEqual({ userId: USER, version: null });
    facts[USER] = { ...COMPLETE, passwordChangeRequired: true };
    // the session remembers while the account's change counter stays …
    expect((await run(request, '/Message/createMessage')).next).toHaveBeenCalledWith();
    // … and checks again once it moved (here: a weak password signed in elsewhere)
    await require('../util/securityStepVersion').bumpSecurityStepVersion([USER]);
    const { next, response } = await run(request, '/Message/createMessage');
    expect(next).not.toHaveBeenCalled();
    expect(response.json).toHaveBeenCalledWith({ status: 'ERROR', error: 'SECURITY_STEP_REQUIRED' });
    expect(request.session.securityStepClearFor).toBeUndefined();
  });

  it('an incomplete account reaches only the step\'s endpoints', async () => {
    facts[USER] = { ...COMPLETE, hasPassword: false };
    for (const path of ['/Message/createMessage', '/File/uploadImage', '/Community/joinCommunity', '/Bot/tokens/issue', '/User/updateOwnData', '/User/addUserAccount', '/gated-files/x.pdf', '/User/createTransferLink']) {
      const { next, response } = await run(loggedIn(), path);
      expect(next).not.toHaveBeenCalled();
      expect(response.json).toHaveBeenCalledWith({ status: 'ERROR', error: 'SECURITY_STEP_REQUIRED' });
    }
    for (const path of ['/User/getSecurityStatus', '/user/SETPASSWORD', '/User/verifyEmail/', '/Passkey/registrationOptions', '/User/logout']) {
      expect((await run(loggedIn(), path)).next).toHaveBeenCalledWith();
    }
    expect((await run(loggedIn(), '/Captcha/challenge', 'GET')).next).toHaveBeenCalledWith();
    // one-click unsubscribe links (token-authenticated) work during the step
    expect((await run(loggedIn(), '/User/emailUnsubscribe', 'GET')).next).toHaveBeenCalledWith();
    expect((await run(loggedIn(), '/User/emailUnsubscribe', 'POST')).next).toHaveBeenCalledWith();
    expect((await run(loggedIn(), '/User/getSecurityStatus', 'GET')).next).not.toHaveBeenCalled();
  });

  it('does not apply to logged-out requests, bots and the gateway', async () => {
    facts[USER] = { ...COMPLETE, hasPassword: false };
    expect((await run(makeRequest(), '/Message/createMessage')).next).toHaveBeenCalledWith();
    const bot = Object.assign(loggedIn(), { botPrincipal: { kind: 'bot-token' } });
    expect((await run(bot, '/Message/createMessage')).next).toHaveBeenCalledWith();
    process.env.CG_LEGACY_CGID = 'true';
    expect((await run(loggedIn(), '/Message/createMessage')).next).toHaveBeenCalledWith();
  });
});

// ===========================================================================
describe('account-security step: adding what is missing', () => {
  it('a first sign-in method: a sign-in within the hour is enough; a device key alone is not', async () => {
    facts[USER] = { ...COMPLETE, hasPassword: false };
    // an account that signs in with X only: a device-key session days later
    await expect(call('User/setPassword', loggedIn(), { password: 'long enough' })).rejects.toThrow('REAUTH_REQUIRED');
    await expect(call('User/setPassword', signedInAgo(61), { password: 'long enough' })).rejects.toThrow('REAUTH_REQUIRED');
    expect(users.setPassword).not.toHaveBeenCalled();
    // the X sign-in (or a transfer link) 59 minutes ago
    await call('User/setPassword', signedInAgo(59), { password: 'long enough' });
    expect(users.setPassword).toHaveBeenCalledWith(USER, 'long enough');
    await flush();
    expect(emailUtils.sendPasswordChangedEmail).toHaveBeenCalledWith('someone@example.org');
    // now it has a password: replacing it needs a fresh authentication
    await expect(call('User/setPassword', loggedIn(), { password: 'another one' })).rejects.toThrow('REAUTH_REQUIRED');
    await call('User/setPassword', fresh(), { password: 'another one' });
  });

  it('a password below the policy: a new one, after confirming the old one', async () => {
    facts[USER] = { ...COMPLETE, passwordChangeRequired: true };
    await expect(call('User/setPassword', loggedIn(USER, { authAt: Date.now(), authMethod: 'transfer' }), { password: 'new password' })).rejects.toThrow('REAUTH_REQUIRED');
    await call('User/setPassword', fresh(), { password: 'new password' });
    expect(facts[USER].passwordChangeRequired).toBe(false);
  });

  it('the password policy: at least 8 characters for a new password; old ones still sign in', async () => {
    await expect(call('User/setPassword', fresh(), { password: 'short' })).rejects.toThrow('length must be at least 8');
    await expect(call('User/createUser', makeRequest(), {
      displayAccount: 'cg', device: { publicKey: DEVICE_KEY }, useEmailAndPassword: { email: 'new@example.org' },
    })).rejects.toThrow('"useEmailAndPassword.password" is required');
    await expect(routes['User/login'].validator!.validateAsync({ type: 'password', aliasOrEmail: 'someone', password: 'short', device: { publicKey: DEVICE_KEY } })).resolves.toBeDefined();
  });

  it('an email address for an account without a verified one', async () => {
    facts[USER] = { ...COMPLETE, email: null, emailVerified: false };
    const request = loggedIn();
    await expect(call('User/requestEmailVerification', request, { email: 'Mine@Example.org' })).rejects.toThrow('REAUTH_REQUIRED');
    request.session.authAt = Date.now();
    request.session.authMethod = 'transfer';
    await call('User/requestEmailVerification', request, { email: 'Mine@Example.org' });
    expect(emailUtils.sendVerificationEmail).toHaveBeenCalledWith('Mine@Example.org', expect.stringMatching(/^[0-9]{8}$/));
    const code = lastCode(emailUtils.sendVerificationEmail);
    await expect(call('User/getSecurityStatus', request, {})).resolves.toMatchObject({ pendingEmail: 'Mine@Example.org', needsVerifiedEmail: true });

    // bound to the address it was sent to and to this account
    await expect(call('User/verifyEmail', loggedIn(), { email: 'other@example.org', token: code })).rejects.toThrow('VERIFY_EMAIL_INVALID_TOKEN');
    await expect(call('User/verifyEmail', fresh(OTHER_USER), { email: 'mine@example.org', token: code })).rejects.toThrow('VERIFY_EMAIL_INVALID_TOKEN');
    await expect(call('User/verifyEmail', makeRequest(), { email: 'mine@example.org', token: code })).rejects.toThrow('LOGIN_REQUIRED');

    await call('User/verifyEmail', loggedIn(), { email: 'mine@example.org', token: code });
    expect(users.setVerifiedEmail).toHaveBeenCalledWith(USER, 'Mine@Example.org');
    // once
    await expect(call('User/verifyEmail', loggedIn(), { email: 'mine@example.org', token: code })).rejects.toThrow('VERIFY_EMAIL_INVALID_TOKEN');
  });

  it('a verification code allows a few wrong guesses only', async () => {
    facts[USER] = { ...COMPLETE, email: null, emailVerified: false };
    await call('User/requestEmailVerification', fresh(), { email: 'mine@example.org' });
    const code = lastCode(emailUtils.sendVerificationEmail);
    const wrong = code === '00000000' ? '11111111' : '00000000';
    for (let i = 0; i < 5; i++) {
      await expect(call('User/verifyEmail', loggedIn(), { email: 'mine@example.org', token: wrong })).rejects.toThrow('VERIFY_EMAIL_INVALID_TOKEN');
    }
    await expect(call('User/verifyEmail', loggedIn(), { email: 'mine@example.org', token: code })).rejects.toThrow('RATE_LIMIT_EXCEEDED');
  });

  it('replacing a verified address needs a step-up; the old address is told', async () => {
    await expect(call('User/requestEmailVerification', loggedIn(USER, { authAt: Date.now(), authMethod: 'transfer' }), { email: 'new@example.org' })).rejects.toThrow('REAUTH_REQUIRED');
    expect(emailUtils.sendVerificationEmail).not.toHaveBeenCalled();
    const request = fresh();
    await call('User/requestEmailVerification', request, { email: 'new@example.org' });
    const code = lastCode(emailUtils.sendVerificationEmail);
    // confirming it later in a session without a fresh sign-in: step-up again,
    // and the code is not used up by the refusal
    await expect(call('User/verifyEmail', loggedIn(), { email: 'new@example.org', token: code })).rejects.toThrow('REAUTH_REQUIRED');
    await call('User/verifyEmail', request, { email: 'new@example.org', token: code });
    await flush();
    expect(emailUtils.sendEmailChangedEmail).toHaveBeenCalledWith('someone@example.org');
  });

  it('an address held UNVERIFIED by another account does not block its owner', async () => {
    facts[USER] = { ...COMPLETE, email: null, emailVerified: false };
    facts[OTHER_USER] = { ...COMPLETE, email: 'mine@example.org', emailVerified: false };
    const request = fresh();
    await call('User/requestEmailVerification', request, { email: 'mine@example.org' });
    expect(emailUtils.sendAddressInUseEmail).not.toHaveBeenCalled();
    await call('User/verifyEmail', request, { email: 'mine@example.org', token: lastCode(emailUtils.sendVerificationEmail) });
    expect(facts[USER]).toMatchObject({ email: 'mine@example.org', emailVerified: true });
    expect(facts[OTHER_USER].email).toBeNull();
    expect((mocks.event as any).emit).toHaveBeenCalledWith(
      { type: 'cliUserOwnData', data: { email: null, emailVerified: false } }, { userIds: [OTHER_USER] });
  });

  it('an address of another account: same answer, no code, its owner hears about it', async () => {
    facts[USER] = { ...COMPLETE, email: null, emailVerified: false };
    const request = fresh();
    await expect(call('User/requestEmailVerification', request, { email: 'other@example.org' })).resolves.toBeUndefined();
    expect(emailUtils.sendVerificationEmail).not.toHaveBeenCalled();
    await flush();
    expect(emailUtils.sendAddressInUseEmail).toHaveBeenCalledWith('other@example.org');
    // the account's status looks the same as for a free address
    await expect(call('User/getSecurityStatus', request, {})).resolves.toMatchObject({ pendingEmail: 'other@example.org' });
  });

  it('the confirmation of the account\'s own unconfirmed address can be sent again, without a step-up', async () => {
    facts[USER] = { ...COMPLETE, emailVerified: false };
    await call('User/requestEmailVerification', loggedIn(), { email: 'someone@example.org' });
    await call('User/requestEmailVerification', loggedIn(), { email: 'Someone@Example.org' });
    expect(emailUtils.sendVerificationEmail).toHaveBeenCalledTimes(2);
    // the newest code counts
    await call('User/verifyEmail', loggedIn(), { email: 'someone@example.org', token: lastCode(emailUtils.sendVerificationEmail) });
    expect(facts[USER].emailVerified).toBe(true);
  });

  it('with mail, updateOwnData no longer sets an address', async () => {
    await expect(call('User/updateOwnData', fresh(), { email: 'new@example.org' })).rejects.toThrow('EMAIL_VERIFICATION_REQUIRED');
    expect(users.updateUser).not.toHaveBeenCalled();
    mailEnabled = false;
    await call('User/updateOwnData', fresh(), { email: 'new@example.org' });
    expect(users.updateUser).toHaveBeenCalledWith(USER, { email: 'new@example.org' });
  });

  it('isEmailAvailable answers only on an instance without mail', async () => {
    await expect(call('User/isEmailAvailable', makeRequest(), { email: 'someone@example.org' })).rejects.toThrow('NOT_SUPPORTED');
    mailEnabled = false;
    await expect(call('User/isEmailAvailable', makeRequest(), { email: 'someone@example.org' })).resolves.toBe(true);
    expect(limiterCalls['ip:user:isEmailAvailable:ip']).toBe(1);
  });
});

// ===========================================================================
describe('email login code', () => {
  const device = { publicKey: DEVICE_KEY };

  it('a code only for the verified address of an account; the same answer for unverified and unknown ones', async () => {
    facts[OTHER_USER] = { ...COMPLETE, email: 'unconfirmed@example.org', emailVerified: false };
    const answers = [];
    for (const email of ['nobody@example.org', 'unconfirmed@example.org', 'someone@example.org']) {
      answers.push(await call('User/sendOneTimePasswordForLogin', makeRequest(), { email }));
    }
    expect(answers).toEqual([undefined, undefined, undefined]);
    await flush();
    expect(emailUtils.sendOneTimePasswordEmail).toHaveBeenCalledTimes(1);
    expect(emailUtils.sendOneTimePasswordEmail).toHaveBeenCalledWith('someone@example.org', expect.stringMatching(/^[0-9]{8}$/));
    // and no login with a code for the unverified address
    await expect(call('User/login', makeRequest(), { type: 'verificationCode', email: 'unconfirmed@example.org', code: '12345678', device })).rejects.toThrow('VERIFY_EMAIL_INVALID_TOKEN');
  });

  it('signs in once with the code of that address', async () => {
    await call('User/sendOneTimePasswordForLogin', makeRequest(), { email: 'someone@example.org' });
    await flush();
    const code = lastCode(emailUtils.sendOneTimePasswordEmail);
    await expect(call('User/login', makeRequest(), { type: 'verificationCode', email: 'nobody@example.org', code, device })).rejects.toThrow('VERIFY_EMAIL_INVALID_TOKEN');
    const result = await call('User/login', makeRequest(), { type: 'verificationCode', email: 'SOMEONE@example.org', code, device });
    expect(result.ownData.id).toBe(USER);
    await expect(call('User/login', makeRequest(), { type: 'verificationCode', email: 'someone@example.org', code, device })).rejects.toThrow('VERIFY_EMAIL_INVALID_TOKEN');
  });

  it('a verification code is no login code', async () => {
    facts[USER] = { ...COMPLETE, emailVerified: false };
    await call('User/requestEmailVerification', loggedIn(), { email: 'someone@example.org' });
    const code = lastCode(emailUtils.sendVerificationEmail);
    await expect(call('User/login', makeRequest(), { type: 'verificationCode', email: 'someone@example.org', code, device })).rejects.toThrow('VERIFY_EMAIL_INVALID_TOKEN');
  });

  it('a code with its guesses used up answers like no code at all (and is gone)', async () => {
    await call('User/sendOneTimePasswordForLogin', makeRequest(), { email: 'someone@example.org' });
    await flush();
    const code = lastCode(emailUtils.sendOneTimePasswordEmail);
    const wrong = code === '00000000' ? '11111111' : '00000000';
    for (let i = 0; i < 5; i++) {
      await expect(call('User/login', makeRequest(), { type: 'verificationCode', email: 'someone@example.org', code: wrong, device })).rejects.toThrow('VERIFY_EMAIL_INVALID_TOKEN');
    }
    // the sixth try — even with the right code — looks exactly like a guess
    // at an address that never got a code
    await expect(call('User/login', makeRequest(), { type: 'verificationCode', email: 'someone@example.org', code, device })).rejects.toThrow('VERIFY_EMAIL_INVALID_TOKEN');
    await expect(call('User/login', makeRequest(), { type: 'verificationCode', email: 'nobody@example.org', code, device })).rejects.toThrow('VERIFY_EMAIL_INVALID_TOKEN');
    expect(memoryRedis.keys.has(`email-code:login:${USER}`)).toBe(false);
    // all six count as failures of the address
    expect(failureCounts[`user:login:code:identifier-network:someone@example.org|${NETWORK}`]).toBe(6);
    expect(failureCounts['user:login:code:identifier:someone@example.org']).toBe(6);
    expect(limiterCalls['ip:user:login:code:ip']).toBe(7);
  });

  it('failure budgets per address and network, and overall; a success gives its slot back', async () => {
    await expect(call('User/login', makeRequest(), { type: 'verificationCode', email: 'Nobody@example.org', code: '12345678', device })).rejects.toThrow('VERIFY_EMAIL_INVALID_TOKEN');
    expect(failureCounts[`user:login:code:identifier-network:nobody@example.org|${NETWORK}`]).toBe(1);
    await call('User/sendOneTimePasswordForLogin', makeRequest(), { email: 'someone@example.org' });
    await flush();
    await call('User/login', makeRequest(), { type: 'verificationCode', email: 'someone@example.org', code: lastCode(emailUtils.sendOneTimePasswordEmail), device });
    expect(failureCounts['user:login:code:identifier:someone@example.org']).toBe(0);
    // 30 failures from this network today: refused before the code is looked at
    failureCounts[`user:login:code:identifier-network:someone@example.org|${NETWORK}`] = 30;
    await expect(call('User/login', makeRequest(), { type: 'verificationCode', email: 'someone@example.org', code: '12345678', device })).rejects.toThrow('RATE_LIMIT_EXCEEDED');
    // the overall cap (all networks)
    failureCounts[`user:login:code:identifier-network:someone@example.org|${NETWORK}`] = 0;
    failureCounts['user:login:code:identifier:someone@example.org'] = 200;
    await expect(call('User/login', makeRequest(), { type: 'verificationCode', email: 'someone@example.org', code: '12345678', device })).rejects.toThrow('RATE_LIMIT_EXCEEDED');
    // the refused attempt did not keep the network slot
    expect(failureCounts[`user:login:code:identifier-network:someone@example.org|${NETWORK}`]).toBe(0);
  });
});

// ===========================================================================
describe('password login throttling', () => {
  const device = { publicKey: DEVICE_KEY };
  it('failed attempts per identifier and network, checked before the password; successes do not count', async () => {
    for (let i = 0; i < 12; i++) {
      await call('User/login', makeRequest(), { type: 'password', aliasOrEmail: 'someone', password: 'correct horse', device });
    }
    expect(failureCounts[`user:login:password:identifier-network:someone|${NETWORK}`]).toBe(0);
    for (let i = 0; i < 10; i++) {
      await expect(call('User/login', makeRequest(), { type: 'password', aliasOrEmail: 'Someone', password: 'wrong', device })).rejects.toThrow('NOT_ALLOWED');
    }
    await expect(call('User/login', makeRequest(), { type: 'password', aliasOrEmail: 'someone', password: 'correct horse', device })).rejects.toThrow('RATE_LIMIT_EXCEEDED');
    expect(users.checkPasswordLogin).toHaveBeenCalledTimes(22);
    // the address of the same account has a budget of its own: reaching a
    // limit never shows that a username and an address belong together
    await call('User/login', makeRequest(), { type: 'password', aliasOrEmail: 'someone@example.org', password: 'correct horse', device });
    // unknown names are counted under the name
    await expect(call('User/login', makeRequest(), { type: 'password', aliasOrEmail: 'Nobody', password: 'x', device })).rejects.toThrow('NOT_ALLOWED');
    expect(failureCounts[`user:login:password:identifier-network:nobody|${NETWORK}`]).toBe(1);
    expect(failureCounts['user:login:password:identifier:nobody']).toBe(1);
    expect(limiterCalls['ip:user:login:password:ip']).toBe(25);
  });

  it('parallel wrong passwords cannot overrun the budget', async () => {
    users.checkPasswordLogin.mockImplementation(async () => {
      await new Promise(resolve => setTimeout(resolve, 30));
      throw new Error('NOT_ALLOWED');
    });
    try {
      const results = await Promise.allSettled(Array.from({ length: 25 }, () =>
        call('User/login', makeRequest(), { type: 'password', aliasOrEmail: 'someone', password: 'wrong', device })));
      const messages = results.map(r => (r as PromiseRejectedResult).reason.message);
      expect(messages.filter(m => m === 'NOT_ALLOWED')).toHaveLength(10);
      expect(messages.filter(m => m === 'RATE_LIMIT_EXCEEDED')).toHaveLength(15);
      expect(users.checkPasswordLogin).toHaveBeenCalledTimes(10);
    }
    finally {
      users.checkPasswordLogin.mockImplementation(async (userId: string | null, password: string) => {
        if (userId !== USER || password !== 'correct horse') throw new Error('NOT_ALLOWED');
        return ownData(USER);
      });
    }
  });

  it('a third party elsewhere does not lock the user out; the overall cap stops distributed guessing', async () => {
    // 10 failures from another network
    failureCounts['user:login:password:identifier-network:someone|v4:198.51.100'] = 10;
    failureCounts['user:login:password:identifier:someone'] = 10;
    await call('User/login', makeRequest(), { type: 'password', aliasOrEmail: 'someone', password: 'correct horse', device });
    failureCounts['user:login:password:identifier:someone'] = 100;
    await expect(call('User/login', makeRequest(), { type: 'password', aliasOrEmail: 'someone', password: 'correct horse', device })).rejects.toThrow('RATE_LIMIT_EXCEEDED');
  });
});

// ===========================================================================
describe('logout', () => {
  it('ends the session: destroyed, no new one', async () => {
    const request = fresh(USER);
    request.session.webauthnChallenges = { c: {} };
    const oldSid = request.sessionID;
    await call('User/logout', request, undefined);
    expect(sessionStore.has(oldSid)).toBe(false);
    expect(request.session).toBeUndefined();
    expect(devices.deleteDevice).toHaveBeenCalledWith('device-1');
  });
});
