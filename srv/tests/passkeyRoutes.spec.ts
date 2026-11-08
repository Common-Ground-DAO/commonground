// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Passkey, login, sign-up and step-up routes (srv/api/passkeys.ts,
 * srv/api/user.ts, srv/api/bots.ts, srv/api/cgid.ts) with a software
 * authenticator against the real WebAuthn core. Handlers are captured from
 * registerPostRoute; repositories are mocked (passkeys in memory).
 */

process.env.BASE_URL = 'https://cg.box';
process.env.DEPLOYMENT = 'prod';
delete process.env.CG_LEGACY_CGID;

import { SoftAuthenticator } from './helpers/softAuthenticator';
import * as memoryPasskeys from './helpers/memoryPasskeys';
import * as memoryRedis from './helpers/memoryRedis';
import { SIGNUP_CODE_TTL_MS } from '../util/signupEmail';

type Handler = (request: any, response: any, data: any) => Promise<any>;
const routes: Record<string, { handler: Handler; validator?: { validateAsync: (data: unknown) => Promise<any> } }> = {};
let currentDomain = '';

jest.doMock('../api/util', () => ({
  registerPostRoute: (_router: unknown, path: string, validator: any, handler: Handler) => {
    routes[`${currentDomain}${path}`] = { handler, validator };
  },
}));
jest.doMock('../redis', () => require('./helpers/memoryRedis'));
jest.doMock('../repositories/passkeys', () => require('./helpers/memoryPasskeys'));
jest.doMock('../util/rateLimit', () => {
  const actual = jest.requireActual('../util/rateLimit');
  return {
  __esModule: true,
  default: () => Object.assign(jest.fn(async () => undefined), { peek: jest.fn(async () => undefined), buckets: () => [] }),
  // the guess budget per sign-up code is the real one (on the in-memory
  // Valkey): taken and free addresses must answer alike through it
  keyRateLimitHandler: (options: { bucket: string }) => options.bucket === 'user:signup-code:attempts'
    ? actual.keyRateLimitHandler(options)
    : Object.assign(jest.fn(async () => undefined), { buckets: () => [] }),
  enforceLimits: actual.enforceLimits,
  peekLimits: actual.peekLimits,
  failureBudget: () => ({ reserve: jest.fn(async () => ({ release: jest.fn(async () => undefined) })) }),
  reserveFailures: jest.fn(async () => ({ release: jest.fn(async () => undefined) })),
  clientPrefixKey: () => 'v4:203.0.113',
  ipFailureLimiter: () => ({ assertBelow: jest.fn(async () => undefined), recordFailure: jest.fn(async () => undefined) }),
  extractIpFromRequest: () => ({ ipString: '203.0.113.1' }),
  };
});
// signing out the other devices (srv/util/signOutOtherDevices.ts, tested in
// userSessions.spec.ts): here only which changes do it
// counts every sign-out: the explicit action, and the changes through changeAndSignOut
const signOutOtherDevices = jest.fn(async (_request?: unknown) => ({ devices: 3, delayed: false }));
const changeAndSignOut = jest.fn(async (request: unknown, change: (beforeCommit: () => Promise<void>) => Promise<unknown>) => {
  const result = await change(async () => undefined);
  return { result, ...await signOutOtherDevices(request) };
});
jest.doMock('../util/signOutOtherDevices', () => ({ signOutOtherDevices, changeAndSignOut }));
const verifyCaptchaToken = jest.fn(async (token: string) => token === 'captcha');
jest.doMock('../util/captcha', () => ({ verifyCaptchaToken }));
jest.doMock('../util/safeFetch', () => ({ fetchRemoteImage: jest.fn() }));
// the account-security step reads these facts (srv/util/securityStep.ts);
// by default the account is complete: a password and a verified address
const securityFacts = {
  email: 'someone@example.org' as string | null,
  emailVerified: true,
  hasPassword: true,
  passwordChangeRequired: false,
  passkeys: 0,
  loginWallets: 0,
};
const defaultSecurityFacts = { ...securityFacts };
jest.doMock('../repositories/loginMethods', () => ({
  ...jest.requireActual('../repositories/loginMethods'),
  getSecurityFacts: jest.fn(async () => ({ ...securityFacts })),
}));
jest.doMock('../util/postgres', () => ({ __esModule: true, default: { query: jest.fn() } }));

let mailEnabled = false;
const emailUtils = {
  sendSignupCodeEmail: jest.fn(async () => undefined),
  sendSignupAddressTakenEmail: jest.fn(async () => undefined),
  sendNewSignInMethodEmail: jest.fn(async () => undefined),
  sendVerificationEmail: jest.fn(async () => undefined),
  sendOneTimePasswordEmail: jest.fn(async () => undefined),
};
jest.doMock('../api/emails', () => ({ __esModule: true, default: emailUtils, emailEnabled: () => mailEnabled }));

const USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';
const NEW_USER = '00000000-0000-4000-8000-0000000000aa';
const WALLET = '00000000-0000-4000-8000-0000000000bb';
const ORIGIN = 'https://cg.box';
const DEVICE_KEY = { crv: 'P-384', ext: true, key_ops: ['verify'], kty: 'EC', x: 'x', y: 'y' };

function ownData(id: string): any {
  return {
    id,
    email: 'someone@example.org',
    emailVerified: true,
    displayAccount: 'cg',
    accounts: [{ type: 'cg', displayName: 'someone' }],
  };
}

const users = {
  getOwnDataById: jest.fn(async (id: string) => ownData(id)),
  findPasswordLoginUserId: jest.fn(async () => USER),
  checkPasswordLogin: jest.fn(async () => ownData(USER)),
  createUser: jest.fn(async (data: any) => ({
    userId: NEW_USER,
    deviceId: 'device-new',
    updatedAt: '2026-10-31T12:00:00.000Z',
    passkeyData: data.passkey ? { credentialID: data.passkey.credentialID } : null,
  })),
  isPasswordCorrect: jest.fn(async (_id: string, password: string) => password === 'correct horse'),
  setPassword: jest.fn(async () => undefined),
  setFirstPassword: jest.fn(async () => true),
  updateUser: jest.fn(async () => undefined),
  removeUserAccount: jest.fn(async () => undefined),
  addUserAccount: jest.fn(async () => undefined),
  getLinkedAccountId: jest.fn(async (): Promise<string | null> => null),
  nextSessionGeneration: jest.fn(async () => 1),
  setUserExtraDataField: jest.fn(async () => undefined),
  isEmailAvailable: jest.fn(async () => true),
};
const devices = {
  createDevice: jest.fn(async () => ({ deviceId: 'device-1' })),
  updateDeviceInfo: jest.fn(async () => undefined),
  verifyDeviceAndGetUserId: jest.fn(async () => ({ userId: USER, webPushSubscription: null })),
  deviceLoggedIn: jest.fn(async () => undefined),
  deleteDevice: jest.fn(async () => undefined),
};
const wallets = {
  getOwnWalletLoginEnabled: jest.fn(async () => true),
  isSignInWallet: jest.fn(async () => true),
  updateWallet: jest.fn(async () => undefined),
  deleteWallet: jest.fn(async () => undefined),
  createWallet: jest.fn(async () => ({})),
  prepareWalletAction: jest.fn(async () => ({ type: 'wallet', ownerId: USER, result: { readyForLogin: true } })),
};
const bots = { removeBot: jest.fn(async () => undefined), disableBot: jest.fn(async () => undefined) };
const botTokens = { issueToken: jest.fn(async () => ({ token: 'cgb_x' })) };
const event = { emit: jest.fn() };
const mocks: Record<string, object> = {
  users,
  device: devices,
  wallets,
  bots,
  botTokens,
  event,
  communities: { getOwnCommunities: jest.fn(async () => []) },
  chats: { getChats: jest.fn(async () => []) },
  notifications: { getUnreadCount: jest.fn(async () => 0) },
  files: { scheduleUserPreviewUpdate: jest.fn() },
  emails: {},
  transferTokens: {},
  suggestedUsers: {},
  articles: {},
  onchain: {},
  permissions: {},
  newsletter: {},
};
for (const [name, mock] of Object.entries(mocks)) {
  jest.doMock(`../repositories/${name}`, () => ({ __esModule: true, default: mock }));
}

/** sessions the "store" knows, by id — regenerate() destroys the old id */
const sessionStore = new Map<string, Record<string, unknown>>();
let sessionCounter = 0;

function makeRequest(data: Record<string, unknown> = {}, cookieSid?: string): any {
  const request: any = { headers: { 'user-agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15' } };
  const attach = (fields: Record<string, unknown>, sid?: string) => {
    const id = sid ?? `sid-${++sessionCounter}`;
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
    Object.defineProperty(session, 'id', { value: id, enumerable: false });
    request.session = session;
    request.sessionID = id;
    sessionStore.set(id, { ...fields });
  };
  attach(data, cookieSid);
  return request;
}

/**
 * A request that arrives with the cookie of session `sid`, loaded from the
 * store as express-session would — an unknown id becomes a new, empty
 * (anonymous) session.
 */
function requestWithCookie(sid: string): any {
  const stored = sessionStore.get(sid);
  return stored ? makeRequest(JSON.parse(JSON.stringify(stored)), sid) : makeRequest();
}

function freshlyAuthenticated(userId = USER, extra: Record<string, unknown> = {}) {
  return makeRequest({ user: { id: userId, deviceId: 'device-1' }, authAt: Date.now(), authMethod: 'password', ...extra });
}

function silentlyLoggedIn(userId = USER) {
  // a device-key login: no authAt
  return makeRequest({ user: { id: userId, deviceId: 'device-1' } });
}

async function call(name: string, request: any, data?: unknown) {
  const route = routes[name];
  if (!route) throw new Error(`no route ${name}`);
  const validated = route.validator ? await route.validator.validateAsync(data) : data;
  return route.handler(request, {}, validated);
}

let passkeyConfig: typeof import('../util/passkeyConfig');

beforeAll(() => {
  currentDomain = 'User';
  require('../api/user');
  currentDomain = 'Passkey';
  require('../api/passkeys');
  currentDomain = 'Bot';
  require('../api/bots');
  currentDomain = 'CgId';
  require('../api/cgid');
  currentDomain = '';
  passkeyConfig = require('../util/passkeyConfig');
});

let warn: jest.SpyInstance;
let error: jest.SpyInstance;
beforeEach(() => {
  memoryPasskeys.reset();
  memoryRedis.keys.clear();
  sessionStore.clear();
  mailEnabled = false;
  Object.assign(securityFacts, defaultSecurityFacts);
  delete process.env.CG_LEGACY_CGID;
  delete process.env.CGID_URL;
  passkeyConfig._resetPasskeyConfigCache();
  jest.clearAllMocks();
  jest.useRealTimers();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
  error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
  error.mockRestore();
});

/** registers a passkey for `userId` straight into the store */
async function seedPasskey(authenticator: SoftAuthenticator, userId: string, rpId = 'cg.box') {
  const { createRegistrationOptions, verifyRegistration, newUserHandle } = require('../util/passkeys');
  const relyingParty = rpId === 'cg.box'
    ? passkeyConfig.getMainRp()
    : passkeyConfig.buildLegacyCgidRp({ cgidUrl: `https://${rpId}`, deployment: 'prod' });
  const session: any = {};
  const options = await createRegistrationOptions(relyingParty, session, {
    userId, userHandle: newUserHandle(), userName: 'x', userDisplayName: 'x', excludeCredentials: [],
  });
  const response = authenticator.createCredential(options, relyingParty.origins[0]);
  const passkey = await verifyRegistration(relyingParty, session, response, { userId, name: null });
  return memoryPasskeys.insert(userId, passkey);
}

describe('Passkey/authenticationOptions', () => {
  it('login: never hands out credential ids, and takes no user id from the client', async () => {
    await seedPasskey(new SoftAuthenticator(), USER);
    const options = await call('Passkey/authenticationOptions', makeRequest(), { purpose: 'login' });
    expect(options.allowCredentials).toEqual([]);
    expect(options.rpId).toBe('cg.box');
    await expect(call('Passkey/authenticationOptions', makeRequest(), { purpose: 'login', userId: USER })).rejects.toThrow();
  });

  it('stepup: only the session user\'s credentials of this RP', async () => {
    const own = await seedPasskey(new SoftAuthenticator(), USER);
    await seedPasskey(new SoftAuthenticator(), USER, 'id.app.cg');
    await seedPasskey(new SoftAuthenticator(), OTHER_USER);
    const options = await call('Passkey/authenticationOptions', silentlyLoggedIn(), { purpose: 'stepup' });
    expect(options.allowCredentials.map((c: any) => c.id)).toEqual([own.data.credentialID]);
  });

  it('stepup needs a session user', async () => {
    await expect(call('Passkey/authenticationOptions', makeRequest(), { purpose: 'stepup' })).rejects.toThrow('LOGIN_REQUIRED');
  });
});

describe('passkey registration', () => {
  it('sign-up: the verified passkey waits in the session, nothing is stored', async () => {
    const request = makeRequest();
    const options = await call('Passkey/registrationOptions', request, { displayName: 'newbie' });
    expect(options.user.displayName).toBe('newbie');
    expect(options.excludeCredentials).toEqual([]);
    const response = new SoftAuthenticator().createCredential(options, ORIGIN);
    await expect(call('Passkey/verifyRegistration', request, { registrationResponse: response })).resolves.toEqual({ status: 'pending' });
    expect(request.session.pendingPasskey).toMatchObject({ rpId: 'cg.box', origin: ORIGIN, credentialID: response.id, name: 'Safari on macOS' });
    expect(memoryPasskeys.rows).toHaveLength(0);
  });

  it('adding to an account needs a recent authentication', async () => {
    const request = silentlyLoggedIn();
    await expect(call('Passkey/registrationOptions', request, {})).rejects.toThrow('REAUTH_REQUIRED');
    expect(memoryPasskeys.rows).toHaveLength(0);
  });

  it('a transfer session adds one while the account has no sign-in method here; afterwards only after a step-up', async () => {
    const transfer = () => makeRequest({ user: { id: USER, deviceId: 'd' }, authAt: Date.now(), authMethod: 'transfer' });
    const addPasskey = async (request: any) => {
      const options = await call('Passkey/registrationOptions', request, {});
      return call('Passkey/verifyRegistration', request, { registrationResponse: new SoftAuthenticator().createCredential(options, ORIGIN) });
    };
    // in the account-security step: nothing to confirm "it's you" with
    Object.assign(securityFacts, { hasPassword: false, passkeys: 0, loginWallets: 0 });
    const inStep = transfer();
    await expect(addPasskey(inStep)).resolves.toMatchObject({ status: 'attached' });
    expect(memoryPasskeys.rows).toHaveLength(1);

    // the step is done (the account has a passkey here now): the same kind of
    // session is an ordinary sign-in, and a second passkey takes the step-up
    securityFacts.passkeys = 1;
    await expect(addPasskey(transfer())).rejects.toThrow('REAUTH_REQUIRED');

    // a complete account: the same
    Object.assign(securityFacts, defaultSecurityFacts);
    const request = transfer();
    await expect(addPasskey(request)).rejects.toThrow('REAUTH_REQUIRED');
    expect(memoryPasskeys.rows).toHaveLength(1);
    // confirming with the password lets it through
    await call('User/reauthenticate', request, { type: 'password', password: 'correct horse' });
    await expect(addPasskey(request)).resolves.toMatchObject({ status: 'attached' });
    expect(memoryPasskeys.rows).toHaveLength(2);
  });

  it('adding keeps one user handle per account and excludes known credentials; the owner is notified', async () => {
    mailEnabled = true;
    const authenticator = new SoftAuthenticator();
    const request = freshlyAuthenticated();
    const first = await call('Passkey/registrationOptions', request, {});
    await call('Passkey/verifyRegistration', request, { registrationResponse: authenticator.createCredential(first, ORIGIN), name: 'Laptop' });
    const second = await call('Passkey/registrationOptions', request, {});
    expect(second.user.id).toBe(first.user.id);
    expect(second.user.name).toBe('someone@example.org');
    expect(second.excludeCredentials.map((c: any) => c.id)).toEqual([memoryPasskeys.rows[0].data.credentialID]);
    const result = await call('Passkey/verifyRegistration', request, { registrationResponse: new SoftAuthenticator().createCredential(second, ORIGIN) });
    expect(result.status).toBe('attached');
    expect(result.passkeys.map((p: any) => p.name)).toEqual(['Laptop', 'Safari on macOS']);
    await new Promise(resolve => setImmediate(resolve));
    expect(emailUtils.sendNewSignInMethodEmail).toHaveBeenCalledWith('someone@example.org', expect.stringContaining('Laptop'));
  });
});

describe('Passkey/remove', () => {
  it('refuses to remove the last sign-in method', async () => {
    const row = await seedPasskey(new SoftAuthenticator(), USER);
    await expect(call('Passkey/remove', freshlyAuthenticated(), { id: row.id })).rejects.toThrow('LAST_LOGIN_METHOD');
    expect(signOutOtherDevices).not.toHaveBeenCalled();
    memoryPasskeys.otherMethods.password = true;
    const request = freshlyAuthenticated();
    await call('Passkey/remove', request, { id: row.id });
    expect(memoryPasskeys.rows[0].deletedAt).not.toBeNull();
    // a way in is gone: the other devices are signed out
    expect(signOutOtherDevices).toHaveBeenCalledWith(request);
  });

  it('another passkey counts as a remaining method; someone else\'s passkey is not found', async () => {
    const a = await seedPasskey(new SoftAuthenticator(), USER);
    await seedPasskey(new SoftAuthenticator(), USER);
    const foreign = await seedPasskey(new SoftAuthenticator(), OTHER_USER);
    await expect(call('Passkey/remove', freshlyAuthenticated(), { id: foreign.id })).rejects.toThrow('NOT_FOUND');
    await call('Passkey/remove', freshlyAuthenticated(), { id: a.id });
  });
});

describe('User/login {type: passkey}', () => {
  it('logs in with a new session id and records the authentication', async () => {
    const authenticator = new SoftAuthenticator();
    await seedPasskey(authenticator, USER);
    const request = makeRequest({ signSecret: 'x'.repeat(20) });
    const oldSid = request.sessionID;
    const options = await call('Passkey/authenticationOptions', request, { purpose: 'login' });
    const result = await call('User/login', request, {
      type: 'passkey',
      authenticationResponse: authenticator.getAssertion(options, ORIGIN),
      device: { publicKey: DEVICE_KEY },
    });
    expect(result.ownData.id).toBe(USER);
    expect(request.sessionID).not.toBe(oldSid);
    expect(sessionStore.has(oldSid)).toBe(false);
    expect(sessionStore.get(request.sessionID)).toMatchObject({ user: { id: USER, deviceId: 'device-1' }, authMethod: 'passkey' });
    expect(request.session.signSecret).toBeUndefined();
    expect(typeof request.session.authAt).toBe('number');
  });

  it('an unknown credential is NOT_FOUND', async () => {
    const authenticator = new SoftAuthenticator();
    await seedPasskey(authenticator, USER);
    memoryPasskeys.reset();
    const request = makeRequest();
    const options = await call('Passkey/authenticationOptions', request, { purpose: 'login' });
    await expect(call('User/login', request, {
      type: 'passkey', authenticationResponse: authenticator.getAssertion(options, ORIGIN), device: { publicKey: DEVICE_KEY },
    })).rejects.toThrow('NOT_FOUND');
  });

  it('a device-key login does not count as a fresh authentication', async () => {
    const request = makeRequest({ signSecret: 's'.repeat(20) });
    const result = await call('User/login', request, { type: 'device', deviceId: USER, secret: 's'.repeat(20), base64Signature: 'sig' });
    expect(request.session.user).toEqual({ id: USER, deviceId: USER });
    expect(request.session.authAt).toBeUndefined();
    expect(result.stepUpValidUntil).toBeNull();
    await expect(call('User/setPassword', request, { password: 'new password' })).rejects.toThrow('REAUTH_REQUIRED');
  });

  it('a device-key re-login of the same user keeps the session (id, linking and step-up state)', async () => {
    const passport = { user: { username: 'someone', _json: { id_str: '42' } } };
    const authAt = Date.now() - 60 * 1000;
    const same = makeRequest({ user: { id: USER, deviceId: 'old' }, passport, authAt, authMethod: 'passkey', signSecret: 's'.repeat(20) });
    const oldSid = same.sessionID;
    const result = await call('User/login', same, { type: 'device', deviceId: USER, secret: 's'.repeat(20), base64Signature: 'sig' });
    expect(same.sessionID).toBe(oldSid);
    // the web app learns until when that earlier sign-in still counts
    expect(result.stepUpValidUntil).toBe(authAt + 5 * 60 * 1000);
    expect(sessionStore.get(oldSid)).toMatchObject({ user: { id: USER, deviceId: USER }, passport, authAt, authMethod: 'passkey' });
    // the step-up time is not refreshed by the silent login, and its
    // challenge is used up
    expect(same.session.authAt).toBe(authAt);
    expect(same.session.signSecret).toBeUndefined();

    // another user's (or an anonymous) session carries nothing over
    const other = makeRequest({ user: { id: OTHER_USER, deviceId: 'old' }, passport, authAt, authMethod: 'passkey', signSecret: 's'.repeat(20) });
    await call('User/login', other, { type: 'device', deviceId: USER, secret: 's'.repeat(20), base64Signature: 'sig' });
    expect(other.session.passport).toBeUndefined();
    expect(other.session.authAt).toBeUndefined();
  });

  it('the page\'s other requests keep their session while the automatic re-login runs', async () => {
    // a logged-in session; after a reload the app sends its device login and,
    // at the same time, other requests with the same cookie
    const page = makeRequest({ user: { id: USER, deviceId: 'device-1' }, signSecret: 's'.repeat(20) });
    const sid = page.sessionID;
    const [, concurrent] = await Promise.all([
      call('User/login', requestWithCookie(sid), { type: 'device', deviceId: USER, secret: 's'.repeat(20), base64Signature: 'sig' }),
      Promise.resolve().then(() => requestWithCookie(sid)),
    ]);
    // a request that is loaded after the re-login (it was still in flight)
    const late = requestWithCookie(sid);
    expect(concurrent.session.user).toEqual({ id: USER, deviceId: 'device-1' });
    expect(late.session.user).toEqual({ id: USER, deviceId: USER });
    await expect(call('User/checkLoginStatus', late)).resolves.toEqual({ userId: USER });
  });

  it('every login that gains something still gets a new session id (no fixation)', async () => {
    // anonymous → user (device key)
    const anonymous = makeRequest({ signSecret: 's'.repeat(20) });
    const anonymousSid = anonymous.sessionID;
    await call('User/login', anonymous, { type: 'device', deviceId: USER, secret: 's'.repeat(20), base64Signature: 'sig' });
    expect(anonymous.sessionID).not.toBe(anonymousSid);
    expect(sessionStore.has(anonymousSid)).toBe(false);
    // user A → user B (device key of B)
    const other = makeRequest({ user: { id: OTHER_USER, deviceId: 'd' }, signSecret: 's'.repeat(20) });
    const otherSid = other.sessionID;
    await call('User/login', other, { type: 'device', deviceId: USER, secret: 's'.repeat(20), base64Signature: 'sig' });
    expect(other.sessionID).not.toBe(otherSid);
    // the same user, interactively (refreshes the step-up time)
    const interactive = makeRequest({ user: { id: USER, deviceId: 'device-1' } });
    const interactiveSid = interactive.sessionID;
    await call('User/login', interactive, { type: 'password', aliasOrEmail: 'someone@example.org', password: 'correct horse', device: { publicKey: DEVICE_KEY } });
    expect(interactive.sessionID).not.toBe(interactiveSid);
    expect(sessionStore.has(interactiveSid)).toBe(false);
    expect(interactive.session.authMethod).toBe('password');
  });

  it('passkey-success is a legacy CG ID mode branch only', async () => {
    await expect(call('User/login', makeRequest({ passkeyData: { step: 'success', passkeyId: USER, userId: USER } }), {
      type: 'passkey-success', device: { publicKey: DEVICE_KEY },
    })).rejects.toThrow('NOT_SUPPORTED');
  });
});

describe('User/createUser', () => {
  const base = {
    displayAccount: 'cg',
    recaptchaToken: 'captcha',
    device: { publicKey: DEVICE_KEY },
    useCgProfile: { type: 'cg', displayName: 'newbie', imageId: null, extraData: { type: 'cg', description: '', homepage: '', links: [] } },
  };

  async function signUpPasskey(request: any) {
    const options = await call('Passkey/registrationOptions', request, { displayName: 'newbie' });
    await call('Passkey/verifyRegistration', request, { registrationResponse: new SoftAuthenticator().createCredential(options, ORIGIN) });
  }

  it('creates the account together with the pending passkey and logs in', async () => {
    const request = makeRequest();
    await signUpPasskey(request);
    const oldSid = request.sessionID;
    const result = await call('User/createUser', request, { ...base, usePreparedPasskey: true });
    const created = users.createUser.mock.calls[0][0] as any;
    expect(created.passkey).toMatchObject({ rpId: 'cg.box', origin: ORIGIN });
    expect(created.passkey.expiresAt).toBeUndefined();
    expect(result.ownData.id).toBe(NEW_USER);
    expect(sessionStore.has(oldSid)).toBe(false);
    expect(request.session).toMatchObject({ user: { id: NEW_USER, deviceId: 'device-new' }, authMethod: 'signup' });
    expect(request.session.pendingPasskey).toBeUndefined();
  });

  it('refuses an expired pending passkey', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
    const request = makeRequest();
    await signUpPasskey(request);
    jest.setSystemTime(Date.now() + 16 * 60 * 1000);
    await expect(call('User/createUser', request, { ...base, usePreparedPasskey: true })).rejects.toThrow('INVALID_REQUEST');
    expect(users.createUser).not.toHaveBeenCalled();
  });

  it.each([
    ['useTwitterCredentials'],
    ['useLuksoCredentials'],
    ['usePreparedFarcaster'],
  ])('%s no longer creates an account', async (flag) => {
    await expect(call('User/createUser', makeRequest(), { ...base, [flag]: true })).rejects.toThrow('NOT_SUPPORTED');
  });

  it('with mail enabled, the address must be verified first and becomes the account address', async () => {
    mailEnabled = true;
    const request = makeRequest();
    // email code first, then the sign-in method, then createUser
    await expect(call('Passkey/registrationOptions', request, { displayName: 'newbie' })).rejects.toThrow('EMAIL_VERIFICATION_REQUIRED');
    await expect(call('User/createUser', request, { ...base, useEmailAndPassword: { email: 'newbie@example.org', password: 'long enough' } })).rejects.toThrow('EMAIL_VERIFICATION_REQUIRED');

    await call('User/requestSignupEmailCode', request, { email: 'newbie@example.org', recaptchaToken: 'captcha' });
    const code = (emailUtils.sendSignupCodeEmail.mock.calls[0] as any)[1];
    await expect(call('User/verifySignupEmailCode', request, { email: 'other@example.org', code })).rejects.toThrow('VERIFY_EMAIL_INVALID_TOKEN');
    await call('User/verifySignupEmailCode', request, { email: 'newbie@example.org', code });
    // a password sign-up must use the verified address
    await expect(call('User/createUser', request, { ...base, useEmailAndPassword: { email: 'other@example.org', password: 'long enough' } })).rejects.toThrow('INVALID_REQUEST');
    const options = await call('Passkey/registrationOptions', request, { displayName: 'newbie' });
    expect(options.user.name).toBe('newbie@example.org');
    await call('Passkey/verifyRegistration', request, { registrationResponse: new SoftAuthenticator().createCredential(options, ORIGIN) });
    // the captcha was solved at requestSignupEmailCode: no second token
    const { recaptchaToken, ...withoutCaptcha } = base;
    verifyCaptchaToken.mockClear();
    const result = await call('User/createUser', request, { ...withoutCaptcha, usePreparedPasskey: true });
    expect(verifyCaptchaToken).not.toHaveBeenCalled();
    expect(users.createUser.mock.calls[0][0]).toMatchObject({ email: 'newbie@example.org', emailVerified: true });
    expect(result.ownData).toMatchObject({ email: 'newbie@example.org', emailVerified: true });
    expect(emailUtils.sendVerificationEmail).not.toHaveBeenCalled();
  });

  it('with mail enabled, a sign-up passkey cannot be verified without the verified address either', async () => {
    const request = makeRequest();
    const options = await call('Passkey/registrationOptions', request, { displayName: 'newbie' });
    mailEnabled = true;
    await expect(call('Passkey/verifyRegistration', request, {
      registrationResponse: new SoftAuthenticator().createCredential(options, ORIGIN),
    })).rejects.toThrow('EMAIL_VERIFICATION_REQUIRED');
    expect(request.session.pendingPasskey).toBeUndefined();
  });

  it('a taken address gets a notice instead of a code, with the same response', async () => {
    mailEnabled = true;
    users.isEmailAvailable.mockResolvedValueOnce(false);
    const request = makeRequest();
    await expect(call('User/requestSignupEmailCode', request, { email: 'taken@example.org', recaptchaToken: 'captcha' })).resolves.toBeUndefined();
    expect(emailUtils.sendSignupCodeEmail).not.toHaveBeenCalled();
    expect(emailUtils.sendSignupAddressTakenEmail).toHaveBeenCalledWith('taken@example.org');
    // no code exists, but a resend behaves exactly like one for a free address
    expect(request.session.signupEmail).toMatchObject({ email: 'taken@example.org' });
    expect(request.session.signupEmail.codeHash).toBeUndefined();
    users.isEmailAvailable.mockResolvedValueOnce(false);
    await expect(call('User/requestSignupEmailCode', request, { email: 'taken@example.org' })).resolves.toBeUndefined();
    await expect(call('User/verifySignupEmailCode', request, { email: 'taken@example.org', code: '12345678' })).rejects.toThrow('VERIFY_EMAIL_INVALID_TOKEN');
  });

  it('a taken and a free address answer alike: wrong codes, the guess limit, expiry, a new code', async () => {
    mailEnabled = true;
    const clock = jest.spyOn(Date, 'now');
    const run = async (taken: boolean) => {
      let now = Date.parse('2026-11-01T10:00:00Z');
      clock.mockImplementation(() => now);
      users.isEmailAvailable.mockResolvedValue(!taken);
      emailUtils.sendSignupCodeEmail.mockClear();
      const email = taken ? 'taken@example.org' : 'free@example.org';
      const request = makeRequest();
      const outcomes: unknown[] = [];
      const attempt = async () => {
        const sent = (emailUtils.sendSignupCodeEmail.mock.calls.at(-1) as any)?.[1];
        const code = sent === '00000000' ? '00000001' : '00000000';
        try {
          await call('User/verifySignupEmailCode', request, { email, code });
          outcomes.push('ok');
        }
        catch (e: any) {
          outcomes.push({ error: e.message, retryAfterSeconds: e.retryAfterSeconds, limit: e.limit });
        }
      };
      await call('User/requestSignupEmailCode', request, { email, recaptchaToken: 'captcha' });
      for (let i = 0; i < 7; i++) {
        now += 1000;
        await attempt();
      }
      // a new code (the captcha still counts), then it expires
      now += 61_000;
      await call('User/requestSignupEmailCode', request, { email });
      now += SIGNUP_CODE_TTL_MS + 1;
      await attempt();
      // after the expiry, a new code still needs no new captcha
      await expect(call('User/requestSignupEmailCode', request, { email })).resolves.toBeUndefined();
      return outcomes;
    };
    try {
      const free = await run(false);
      const taken = await run(true);
      expect(taken).toEqual(free);
      expect(free.slice(0, 5)).toEqual(Array(5).fill({ error: 'VERIFY_EMAIL_INVALID_TOKEN', retryAfterSeconds: undefined, limit: undefined }));
      expect(free[5]).toEqual({ error: 'RATE_LIMIT_EXCEEDED', retryAfterSeconds: expect.any(Number), limit: 'attempts' });
      expect(free[7]).toEqual({ error: 'VERIFY_EMAIL_EXPIRED_TOKEN', retryAfterSeconds: undefined, limit: undefined });
    }
    finally {
      clock.mockRestore();
      users.isEmailAvailable.mockResolvedValue(true);
    }
  });

  it('checks the sign-up captcha before any code mail goes out', async () => {
    mailEnabled = true;
    const request = makeRequest();
    await expect(call('User/requestSignupEmailCode', request, { email: 'a@example.org' })).rejects.toThrow('CAPTCHA_FAILED');
    await expect(call('User/requestSignupEmailCode', request, { email: 'a@example.org', recaptchaToken: 'wrong' })).rejects.toThrow('CAPTCHA_FAILED');
    expect(emailUtils.sendSignupCodeEmail).not.toHaveBeenCalled();
    await call('User/requestSignupEmailCode', request, { email: 'a@example.org', recaptchaToken: 'captcha' });
    // a resend to the same address needs no new token, another address does
    await call('User/requestSignupEmailCode', request, { email: 'A@example.org' });
    expect(emailUtils.sendSignupCodeEmail).toHaveBeenCalledTimes(2);
    await expect(call('User/requestSignupEmailCode', request, { email: 'b@example.org' })).rejects.toThrow('CAPTCHA_FAILED');
  });

  it('createUser still needs a captcha when no email code covered it', async () => {
    const { recaptchaToken, ...withoutCaptcha } = base;
    await expect(call('User/createUser', makeRequest(), { ...withoutCaptcha, useEmailAndPassword: { email: 'n@example.org', password: 'a-long-password' } })).rejects.toThrow('CAPTCHA_FAILED');
    await expect(call('User/createUser', makeRequest(), { ...base, recaptchaToken: 'wrong', useEmailAndPassword: { email: 'n@example.org', password: 'a-long-password' } })).rejects.toThrow('CAPTCHA_FAILED');
  });

  it('without mail, sign-up codes are unavailable', async () => {
    await expect(call('User/requestSignupEmailCode', makeRequest(), { email: 'a@example.org' })).rejects.toThrow('EMAIL_DISABLED');
  });
});

describe('the recovery phrase login', () => {
  it('is not available outside legacy CG ID mode', async () => {
    await expect(call('User/prepareWalletAction', makeRequest({ signSecret: 's'.repeat(20) }), {
      type: 'cg_evm',
      signature: '0x00',
      data: { type: 'evm', address: '0x' + '1'.repeat(40), siweMessage: 'm', secret: 's'.repeat(20) },
    })).rejects.toThrow('NOT_SUPPORTED');
    expect(wallets.prepareWalletAction).not.toHaveBeenCalled();
  });
});

describe('User/reauthenticate', () => {
  it('password: refreshes the authentication time', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
    const request = silentlyLoggedIn();
    await expect(call('User/reauthenticate', request, { type: 'password', password: 'wrong' })).rejects.toThrow('NOT_ALLOWED');
    const { validUntil } = await call('User/reauthenticate', request, { type: 'password', password: 'correct horse' });
    expect(validUntil).toBe(Date.now() + 5 * 60 * 1000);
    expect(request.session).toMatchObject({ authAt: Date.now(), authMethod: 'password' });
    await call('User/setPassword', request, { password: 'new password' });
    expect(users.setPassword).toHaveBeenCalledWith(USER, 'new password', expect.any(Function));
  });

  it('password: a password that predates the policy still re-authenticates', async () => {
    users.isPasswordCorrect.mockResolvedValueOnce(true);
    const request = silentlyLoggedIn();
    await call('User/reauthenticate', request, { type: 'password', password: 'short' });
    expect(request.session.authMethod).toBe('password');
  });

  it('passkey: only the session user\'s own credential', async () => {
    const own = new SoftAuthenticator();
    const foreign = new SoftAuthenticator();
    await seedPasskey(own, USER);
    await seedPasskey(foreign, OTHER_USER);
    const request = silentlyLoggedIn();
    const options = await call('Passkey/authenticationOptions', request, { purpose: 'stepup' });
    await expect(call('User/reauthenticate', request, {
      type: 'passkey', authenticationResponse: foreign.getAssertion(options, ORIGIN, [...foreign.credentials.keys()][0]),
    })).rejects.toThrow('NOT_ALLOWED');
    const again = await call('Passkey/authenticationOptions', request, { purpose: 'stepup' });
    await call('User/reauthenticate', request, { type: 'passkey', authenticationResponse: own.getAssertion(again, ORIGIN) });
    expect(request.session.authMethod).toBe('passkey');
  });

  it('wallet: a fresh signature of one of the user\'s login wallets', async () => {
    const stale = silentlyLoggedIn();
    stale.session.preparedCredential = { type: 'wallet', ownerId: USER, walletIdentifier: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', walletType: 'evm', result: { readyForLogin: true }, createdAt: Date.now() - 10 * 60 * 1000 };
    await expect(call('User/reauthenticate', stale, { type: 'wallet' })).rejects.toThrow('NOT_ALLOWED');
    const foreign = silentlyLoggedIn();
    foreign.session.preparedCredential = { type: 'wallet', ownerId: OTHER_USER, walletIdentifier: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', walletType: 'evm', result: { readyForLogin: true }, createdAt: Date.now() };
    await expect(call('User/reauthenticate', foreign, { type: 'wallet' })).rejects.toThrow('NOT_ALLOWED');
    // the wallet's sign-in was switched off since the signature was checked
    const switchedOff = silentlyLoggedIn();
    switchedOff.session.preparedCredential = { type: 'wallet', ownerId: USER, walletIdentifier: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', walletType: 'evm', result: { readyForLogin: true }, createdAt: Date.now() };
    wallets.isSignInWallet.mockResolvedValueOnce(false);
    await expect(call('User/reauthenticate', switchedOff, { type: 'wallet' })).rejects.toThrow('NOT_ALLOWED');
    const fresh = silentlyLoggedIn();
    fresh.session.preparedCredential = { type: 'wallet', ownerId: USER, walletIdentifier: '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', walletType: 'evm', result: { readyForLogin: true }, createdAt: Date.now() };
    await call('User/reauthenticate', fresh, { type: 'wallet' });
    expect(fresh.session.authMethod).toBe('wallet');
    expect(fresh.session.preparedCredential).toBeUndefined();
    expect(wallets.isSignInWallet).toHaveBeenLastCalledWith(USER, '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa', 'evm');
  });
});

describe('User/login {type: wallet}', () => {
  const WALLET_ADDRESS = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
  const prepared = (extra: Record<string, unknown> = {}) => ({
    type: 'wallet', ownerId: USER, walletIdentifier: WALLET_ADDRESS, walletType: 'evm',
    result: { readyForLogin: true }, createdAt: Date.now(), ...extra,
  });
  const login = (request: any) => call('User/login', request, { type: 'wallet', device: { publicKey: DEVICE_KEY } });

  it('signs in with a fresh signature of a wallet that still signs in for its owner', async () => {
    const request = makeRequest({ preparedCredential: prepared() });
    const result = await login(request);
    expect(result.ownData.id).toBe(USER);
    expect(wallets.isSignInWallet).toHaveBeenCalledWith(USER, WALLET_ADDRESS, 'evm');
    expect(request.session.preparedCredential).toBeUndefined();
  });

  it('a signature kept in a session past a few minutes signs in no one', async () => {
    const request = makeRequest({ preparedCredential: prepared({ createdAt: Date.now() - 6 * 60 * 1000 }) });
    await expect(login(request)).rejects.toThrow('NOT_ALLOWED');
    expect(devices.createDevice).not.toHaveBeenCalled();
  });

  it('a wallet removed (or its sign-in switched off) after the signature signs in no one; the signature is used up', async () => {
    wallets.isSignInWallet.mockResolvedValueOnce(false);
    const request = makeRequest({ preparedCredential: prepared() });
    await expect(login(request)).rejects.toThrow('NOT_ALLOWED');
    expect(devices.createDevice).not.toHaveBeenCalled();
    expect(request.session.preparedCredential).toBeUndefined();
  });

  it('a prepared credential from before the wallet was recorded in it signs in no one', async () => {
    const { walletIdentifier, ...old } = prepared();
    await expect(login(makeRequest({ preparedCredential: old }))).rejects.toThrow('NOT_ALLOWED');
  });
});

/**
 * Every route of the User, Passkey and Bot APIs is classified here. A new
 * route fails this test until it is added to one of the two lists — sensitive
 * ones with a request that must be refused without a recent authentication.
 * `adds`: the request adds a way into the account, which a transfer-link
 * session may do only while the account lacks a sign-in method here (the
 * account-security step); for a complete account it needs the step-up like
 * everything else.
 */
const PROTECTED: Record<string, { data: any; sideEffects: () => jest.Mock[]; adds?: boolean }> = {
  'User/setPassword': { data: { password: 'new password' }, sideEffects: () => [users.setPassword] },
  'User/updateOwnData': { data: { email: 'new@example.org' }, sideEffects: () => [users.updateUser] },
  'User/removeUserAccount': { data: { type: 'twitter' }, sideEffects: () => [users.removeUserAccount] },
  'User/addUserAccount': { data: { type: 'twitter' }, sideEffects: () => [users.addUserAccount], adds: true },
  'User/addPreparedWallet': { data: { loginEnabled: true, visibility: 'private' }, sideEffects: () => [wallets.createWallet], adds: true },
  'User/updateWallet': { data: { id: WALLET, loginEnabled: false }, sideEffects: () => [wallets.updateWallet] },
  'User/deleteWallet': { data: { id: WALLET }, sideEffects: () => [wallets.deleteWallet] },
  'Passkey/registrationOptions': { data: {}, sideEffects: () => [], adds: true },
  'Passkey/verifyRegistration': {
    data: { registrationResponse: { id: 'a'.repeat(22), rawId: 'a'.repeat(22), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: 'e30', attestationObject: 'oA' } } },
    sideEffects: () => [],
    adds: true,
  },
  'Passkey/remove': { data: { id: WALLET }, sideEffects: () => [] },
  'User/signOutOtherDevices': { data: {}, sideEffects: () => [signOutOtherDevices] },
  'Bot/disable': { data: { botUserId: OTHER_USER }, sideEffects: () => [bots.disableBot] },
  'Bot/tokens/issue': { data: { botUserId: OTHER_USER, name: 'ci' }, sideEffects: () => [botTokens.issueToken] },
};
const NOT_PROTECTED = new Set([
  // sign-in, sign-up and session
  'User/getSignableSecret', 'User/verifyCaptcha', 'User/clearLoginSession', 'User/login', 'User/ensureSession',
  'User/reauthenticate', 'User/requestSignupEmailCode', 'User/verifySignupEmailCode', 'User/checkLoginStatus',
  'User/logout', 'User/createUser', 'User/prepareWalletAction', 'User/sendOneTimePasswordForLogin',
  'User/requestEmailVerification', 'User/verifyEmail', 'User/getSecurityStatus',
  // transfer links: minted for the session's own user, redeemed logged out
  'User/createTransferLink', 'User/previewTransferLink', 'User/redeemTransferLink', 'User/declineTransferLink',
  'Passkey/authenticationOptions', 'Passkey/list', 'Passkey/rename',
  // editing the cg profile
  'User/updateUserAccount',
  // everything else: profile, social, content, settings, premium
  'User/setOwnExtraDataField', 'User/getWallets', 'User/getUserData', 'User/getSuggestedUsers',
  'User/getUserProfileDetails', 'User/setOwnStatus', 'User/isCgProfileNameAvailable', 'User/isEmailAvailable',
  'User/subscribeNewsletter', 'User/unsubscribeNewsletter', 'User/followUser', 'User/unfollowUser',
  'User/getArticleList', 'User/getArticleDetailView', 'User/createArticle', 'User/updateArticle',
  'User/deleteArticle', 'User/getFollowers', 'User/getFollowing', 'User/getFriends',
  'User/buyUserPremiumFeature', 'User/setPremiumFeatureAutoRenew', 'User/getUserCommunityIds',
  'User/getTransactionData',
  // bot management that does not mint credentials or remove a bot
  'Bot/list', 'Bot/listCommunityBots', 'Bot/listInstallableUserBots', 'Bot/create', 'Bot/update',
  'Bot/remove', 'Bot/install', 'Bot/setRoles', 'Bot/setAllowUserBots', 'Bot/tokens/list', 'Bot/tokens/revoke',
]);

describe('step-up: protected routes', () => {
  it('every User/Passkey/Bot route is classified', () => {
    const registered = Object.keys(routes).filter(name => /^(User|Passkey|Bot)\//.test(name));
    const unclassified = registered.filter(name => !(name in PROTECTED) && !NOT_PROTECTED.has(name));
    expect(unclassified).toEqual([]);
    const stale = [...Object.keys(PROTECTED), ...NOT_PROTECTED].filter(name => !registered.includes(name));
    expect(stale).toEqual([]);
  });

  for (const [name, spec] of Object.entries(PROTECTED)) {
    it(`${name}: refused without a recent authentication, before any change`, async () => {
      jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
      const prepared = { type: 'wallet', result: { readyForCreation: true }, preWallet: { type: 'evm' } };

      // device-key session: never fresh
      await expect(call(name, Object.assign(silentlyLoggedIn(), {}), spec.data)).rejects.toThrow('REAUTH_REQUIRED');

      // authenticated, but the window has passed
      const request = freshlyAuthenticated(USER, { preparedCredential: prepared });
      jest.setSystemTime(Date.now() + 5 * 60 * 1000 + 1);
      await expect(call(name, request, spec.data)).rejects.toThrow('REAUTH_REQUIRED');

      // a transfer session of a complete account is an ordinary sign-in: it
      // neither adds, removes nor replaces a way in without the step-up
      const transfer = () => makeRequest({ user: { id: USER, deviceId: 'd' }, authAt: Date.now(), authMethod: 'transfer', preparedCredential: prepared });
      await expect(call(name, transfer(), spec.data)).rejects.toThrow('REAUTH_REQUIRED');

      for (const sideEffect of spec.sideEffects()) {
        expect(sideEffect).not.toHaveBeenCalled();
      }

      // while the account has no sign-in method here (the account-security
      // step), a transfer session may add one — and still nothing else
      Object.assign(securityFacts, { hasPassword: false, passkeys: 0, loginWallets: 0 });
      if (spec.adds) {
        await call(name, transfer(), spec.data).catch((e: Error) => {
          expect(e.message).not.toBe('REAUTH_REQUIRED');
        });
        jest.clearAllMocks();
      }
      else if (name !== 'User/setPassword') {
        // (a first password is an addition, covered in transferAndSecurityStep.spec.ts)
        await expect(call(name, transfer(), spec.data)).rejects.toThrow('REAUTH_REQUIRED');
      }
      Object.assign(securityFacts, defaultSecurityFacts);

      // within the window the step-up check passes (the call may still fail
      // later on the mocked data, but not for lack of authentication)
      const fresh = freshlyAuthenticated(USER, { preparedCredential: prepared });
      jest.setSystemTime(Date.now() + 5 * 60 * 1000 - 1000);
      await call(name, fresh, spec.data).catch((e: Error) => {
        expect(e.message).not.toBe('REAUTH_REQUIRED');
      });
    });
  }

  it('conditional checks only apply to the sensitive part', async () => {
    await call('User/updateOwnData', silentlyLoggedIn(), { newsletter: true });
    expect(users.updateUser).toHaveBeenCalled();
    await call('User/updateWallet', silentlyLoggedIn(), { id: WALLET, visibility: 'public' });
    expect(wallets.updateWallet).toHaveBeenCalledTimes(1);
    // loginEnabled sent but unchanged (the mock wallet is login-enabled)
    await call('User/updateWallet', silentlyLoggedIn(), { id: WALLET, loginEnabled: true, visibility: 'public' });
    expect(wallets.updateWallet).toHaveBeenCalledTimes(2);
    wallets.getOwnWalletLoginEnabled.mockResolvedValueOnce(false);
    await call('User/deleteWallet', silentlyLoggedIn(), { id: WALLET });
    expect(wallets.deleteWallet).toHaveBeenCalled();
    // the cg profile is not a sign-in method
    await call('User/removeUserAccount', silentlyLoggedIn(), { type: 'cg' });
    expect(users.removeUserAccount).toHaveBeenCalledWith(USER, 'cg', { rpId: 'cg.box' }, undefined);
    await call('User/addUserAccount', silentlyLoggedIn(), { type: 'cg', displayName: 'someone' });
    expect(users.addUserAccount).toHaveBeenCalledTimes(1);
    // the unchanged address re-sent with other settings is no address change
    await call('User/updateOwnData', silentlyLoggedIn(), { email: 'someone@example.org', newsletter: false });
    expect(users.updateUser).toHaveBeenLastCalledWith(USER, { newsletter: false });
  });

  it('linking an X account notifies the verified address', async () => {
    mailEnabled = true;
    const request = freshlyAuthenticated(USER, {
      passport: { user: { username: 'someone', _json: { id_str: '42', followers_count: 1, friends_count: 2 } } },
    });
    await call('User/addUserAccount', request, { type: 'twitter' });
    expect(users.addUserAccount).toHaveBeenCalledWith(USER, expect.objectContaining({ type: 'twitter' }), undefined);
    await new Promise(resolve => setImmediate(resolve));
    expect(emailUtils.sendNewSignInMethodEmail).toHaveBeenCalledWith('someone@example.org', 'X account');
    // an added way in leaves the other devices signed in
    expect(signOutOtherDevices).not.toHaveBeenCalled();
  });

  it('linking a different X account than the one linked replaces a way in: plain step-up, the others signed out', async () => {
    const passport = { user: { username: 'other', _json: { id_str: '43', followers_count: 1, friends_count: 2 } } };
    users.getLinkedAccountId.mockResolvedValue('42');
    try {
      // a transfer session may add, never replace
      const transfer = makeRequest({ user: { id: USER, deviceId: 'd' }, authAt: Date.now(), authMethod: 'transfer', passport });
      await expect(call('User/addUserAccount', transfer, { type: 'twitter' })).rejects.toThrow('REAUTH_REQUIRED');
      expect(users.addUserAccount).not.toHaveBeenCalled();
      const request = freshlyAuthenticated(USER, { passport });
      await call('User/addUserAccount', request, { type: 'twitter' });
      expect(signOutOtherDevices).toHaveBeenCalledWith(request);
      // the same account again (a profile refresh) is no replacement
      jest.clearAllMocks();
      users.getLinkedAccountId.mockResolvedValue('43');
      await call('User/addUserAccount', freshlyAuthenticated(USER, { passport }), { type: 'twitter' });
      expect(signOutOtherDevices).not.toHaveBeenCalled();
    }
    finally {
      users.getLinkedAccountId.mockResolvedValue(null);
    }
  });

  it('removing or switching off a sign-in method keeps the last one (passed to the repositories)', async () => {
    await call('User/deleteWallet', freshlyAuthenticated(), { id: WALLET });
    expect(wallets.deleteWallet).toHaveBeenCalledWith(USER, { id: WALLET }, { rpId: 'cg.box' }, expect.any(Function));
    await call('User/updateWallet', freshlyAuthenticated(), { id: WALLET, loginEnabled: false });
    expect(wallets.updateWallet).toHaveBeenCalledWith(USER, { id: WALLET, loginEnabled: false }, { rpId: 'cg.box' }, expect.any(Function));
    await call('User/removeUserAccount', freshlyAuthenticated(), { type: 'farcaster' });
    expect(users.removeUserAccount).toHaveBeenCalledWith(USER, 'farcaster', { rpId: 'cg.box' }, expect.any(Function));
    // each removed a way in: each signed the other devices out after it
    expect(signOutOtherDevices).toHaveBeenCalledTimes(3);
    wallets.deleteWallet.mockRejectedValueOnce(new Error('LAST_LOGIN_METHOD'));
    await expect(call('User/deleteWallet', freshlyAuthenticated(), { id: WALLET })).rejects.toThrow('LAST_LOGIN_METHOD');
    // a refused removal changes nothing
    expect(signOutOtherDevices).toHaveBeenCalledTimes(3);
  });

  it('changes that remove no way in leave the other devices signed in', async () => {
    // wallet settings other than sign-in, a wallet that cannot sign in, the cg profile
    await call('User/updateWallet', silentlyLoggedIn(), { id: WALLET, visibility: 'public' });
    wallets.getOwnWalletLoginEnabled.mockResolvedValueOnce(false);
    await call('User/deleteWallet', silentlyLoggedIn(), { id: WALLET });
    await call('User/removeUserAccount', silentlyLoggedIn(), { type: 'cg' });
    // switching a wallet's sign-in on adds a way in
    wallets.getOwnWalletLoginEnabled.mockResolvedValueOnce(false);
    await call('User/updateWallet', freshlyAuthenticated(), { id: WALLET, loginEnabled: true });
    expect(wallets.updateWallet).toHaveBeenCalledTimes(2);
    expect(signOutOtherDevices).not.toHaveBeenCalled();
  });

  it('User/signOutOtherDevices: after a step-up, says how many devices it signed out', async () => {
    await expect(call('User/signOutOtherDevices', makeRequest(), {})).rejects.toThrow('LOGIN_REQUIRED');
    await expect(call('User/signOutOtherDevices', silentlyLoggedIn(), {})).rejects.toThrow('REAUTH_REQUIRED');
    expect(signOutOtherDevices).not.toHaveBeenCalled();
    const request = freshlyAuthenticated();
    await expect(call('User/signOutOtherDevices', request, {})).resolves.toEqual({ devices: 3, delayed: false });
    expect(signOutOtherDevices).toHaveBeenCalledWith(request);
    await expect(routes['User/signOutOtherDevices'].validator!.validateAsync({ userId: USER })).rejects.toThrow();
  });
});

describe('legacy CG ID mode', () => {
  beforeEach(() => {
    process.env.CG_LEGACY_CGID = 'true';
    process.env.CGID_URL = 'https://id.app.cg';
    passkeyConfig._resetPasskeyConfigCache();
  });

  it('CgId authenticates id.app.cg credentials; the main window redeems the result', async () => {
    const authenticator = new SoftAuthenticator();
    const row = await seedPasskey(authenticator, USER, 'id.app.cg');
    const request = makeRequest();
    const options = await call('CgId/generateAuthenticationOptions', request, {});
    expect(options.rpId).toBe('id.app.cg');
    expect(options.allowCredentials).toEqual([]);
    const verified = await call('CgId/verifyAuthenticationResponse', request, {
      frontendRequestId: 'req-1',
      authenticationResponse: authenticator.getAssertion(options, 'https://id.app.cg'),
    });
    expect(verified).toBe(true);
    expect(request.session.passkeyData).toMatchObject({ step: 'success', passkeyId: row.id, userId: USER });
    expect(request.session.passkeyData.expiresAt).toBeGreaterThan(Date.now());
    expect(event.emit).toHaveBeenCalledWith(expect.objectContaining({ type: 'cliCgIdSignResponse' }), { cgIdRequestIds: ['req-1'], sessionIds: [request.sessionID] });

    const result = await call('User/login', request, { type: 'passkey-success', device: { publicKey: DEVICE_KEY } });
    expect(result.ownData.id).toBe(USER);
    expect(request.session.passkeyData).toBeUndefined();
    expect(request.session.authMethod).toBe('passkey');
  });

  it('the keepalives store nothing (no session is created by them)', async () => {
    for (const route of ['User/ensureSession', 'CgId/ensureSession']) {
      const request = makeRequest();
      await call(route, request, {});
      const { regenerate, destroy, save, ...fields } = request.session;
      expect(fields).toEqual({});
    }
  });

  it('a cg.box credential is unknown to the legacy relying party', async () => {
    delete process.env.CG_LEGACY_CGID;
    passkeyConfig._resetPasskeyConfigCache();
    const authenticator = new SoftAuthenticator();
    await seedPasskey(authenticator, USER);
    process.env.CG_LEGACY_CGID = 'true';
    passkeyConfig._resetPasskeyConfigCache();
    const request = makeRequest();
    const options = await call('CgId/generateAuthenticationOptions', request, {});
    await expect(call('CgId/verifyAuthenticationResponse', request, {
      frontendRequestId: 'req-1',
      authenticationResponse: authenticator.getAssertion(options, 'https://id.app.cg', undefined, { rpId: 'cg.box' }),
    })).rejects.toThrow('NOT_FOUND');
  });

  it('an old CgId result cannot be redeemed', async () => {
    const authenticator = new SoftAuthenticator();
    const row = await seedPasskey(authenticator, USER, 'id.app.cg');
    const request = makeRequest({ passkeyData: { step: 'success', passkeyId: row.id, userId: USER, expiresAt: Date.now() - 1 } });
    await expect(call('User/login', request, { type: 'passkey-success', device: { publicKey: DEVICE_KEY } })).rejects.toThrow('INVALID_REQUEST');
    expect(request.session.passkeyData).toBeUndefined();
  });

  it('the CgId API takes no user id', async () => {
    await expect(call('CgId/generateAuthenticationOptions', makeRequest(), { userId: USER })).rejects.toThrow();
  });

  it('main-origin passkey login and sign-up passkeys are off', async () => {
    await expect(call('User/login', makeRequest(), {
      type: 'passkey',
      authenticationResponse: { id: 'a'.repeat(22), rawId: 'a'.repeat(22), type: 'public-key', clientExtensionResults: {}, response: { clientDataJSON: 'e30', authenticatorData: 'AA', signature: 'AA' } },
      device: { publicKey: DEVICE_KEY },
    })).rejects.toThrow('NOT_SUPPORTED');
  });
});
