// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Shared WebAuthn core (srv/util/passkeys.ts) driven by a software
 * authenticator: what a relying party accepts and what it refuses.
 */

jest.mock('../redis', () => require('./helpers/memoryRedis'));
jest.mock('../repositories/passkeys', () => require('./helpers/memoryPasskeys'));

import {
  AUTOFILL_CHALLENGE_TTL_MS,
  CHALLENGE_TTL_MS,
  MAX_CHALLENGES,
  createAuthenticationOptions,
  createRegistrationOptions,
  newUserHandle,
  verifyAuthentication,
  verifyRegistration,
} from '../util/passkeys';
import { buildLegacyCgidRp, buildMainRp } from '../util/passkeyConfig';
import { SoftAuthenticator } from './helpers/softAuthenticator';
import * as memoryPasskeys from './helpers/memoryPasskeys';
import * as memoryRedis from './helpers/memoryRedis';

const ORIGIN = 'https://cg.box';
const rp = buildMainRp({ baseUrl: ORIGIN, appHostname: 'cg.box', deployment: 'prod' });
const legacyRp = buildLegacyCgidRp({ cgidUrl: 'https://id.app.cg', deployment: 'prod' });
const USER = '00000000-0000-4000-8000-000000000001';
const OTHER_USER = '00000000-0000-4000-8000-000000000002';

function newSession(): any {
  return {};
}

async function register(session: any, authenticator: SoftAuthenticator, options: { userId?: string | null; relyingParty?: typeof rp; origin?: string } = {}) {
  const relyingParty = options.relyingParty ?? rp;
  const userId = options.userId === undefined ? USER : options.userId;
  const creationOptions = await createRegistrationOptions(relyingParty, session, {
    userId,
    userHandle: newUserHandle(),
    userName: 'someone@example.org',
    userDisplayName: 'someone',
    excludeCredentials: [],
  });
  const response = authenticator.createCredential(creationOptions, options.origin ?? relyingParty.origins[0]);
  const passkey = await verifyRegistration(relyingParty, session, response, { userId, name: 'Test key' });
  memoryPasskeys.insert(userId, passkey);
  return { passkey, response, creationOptions };
}

let warn: jest.SpyInstance;
beforeEach(() => {
  memoryPasskeys.reset();
  memoryRedis.keys.clear();
  jest.useRealTimers();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => {
  warn.mockRestore();
});

describe('registration', () => {
  it('accepts a user-verified credential from the exact origin and binds it to the RP ID', async () => {
    const session = newSession();
    const { passkey } = await register(session, new SoftAuthenticator());
    expect(passkey.rpId).toBe('cg.box');
    expect(passkey.origin).toBe(ORIGIN);
    expect(passkey.webAuthnUserID).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(session.webauthnChallenges).toEqual({});
  });

  it('asks for a discoverable, user-verified credential', async () => {
    const options = await createRegistrationOptions(rp, newSession(), {
      userId: null, userHandle: newUserHandle(), userName: 'a', userDisplayName: 'a', excludeCredentials: [],
    });
    expect(options.authenticatorSelection).toMatchObject({ residentKey: 'required', userVerification: 'required' });
    expect(options.rp.id).toBe('cg.box');
    expect(options.attestation).toBe('none');
  });

  it.each([
    'http://cg.box',
    'https://sub.cg.box',
    'https://cg.box.evil.com',
  ])('rejects a response from origin %s', async (origin) => {
    const session = newSession();
    const options = await createRegistrationOptions(rp, session, {
      userId: USER, userHandle: newUserHandle(), userName: 'a', userDisplayName: 'a', excludeCredentials: [],
    });
    const response = new SoftAuthenticator().createCredential(options, origin);
    await expect(verifyRegistration(rp, session, response, { userId: USER, name: null })).rejects.toThrow('INVALID_SIGNATURE');
  });

  it('rejects a credential created for another RP ID', async () => {
    const session = newSession();
    const options = await createRegistrationOptions(rp, session, {
      userId: USER, userHandle: newUserHandle(), userName: 'a', userDisplayName: 'a', excludeCredentials: [],
    });
    const response = new SoftAuthenticator().createCredential(options, ORIGIN, { rpId: 'id.app.cg' });
    await expect(verifyRegistration(rp, session, response, { userId: USER, name: null })).rejects.toThrow('INVALID_SIGNATURE');
  });

  it('rejects a credential without user verification', async () => {
    const session = newSession();
    const options = await createRegistrationOptions(rp, session, {
      userId: USER, userHandle: newUserHandle(), userName: 'a', userDisplayName: 'a', excludeCredentials: [],
    });
    const response = new SoftAuthenticator().createCredential(options, ORIGIN, { uv: false });
    await expect(verifyRegistration(rp, session, response, { userId: USER, name: null })).rejects.toThrow('INVALID_SIGNATURE');
  });

  it('refuses a ceremony started for another session user', async () => {
    const session = newSession();
    const options = await createRegistrationOptions(rp, session, {
      userId: USER, userHandle: newUserHandle(), userName: 'a', userDisplayName: 'a', excludeCredentials: [],
    });
    const response = new SoftAuthenticator().createCredential(options, ORIGIN);
    await expect(verifyRegistration(rp, session, response, { userId: OTHER_USER, name: null })).rejects.toThrow('INVALID_SECRET');
  });
});

describe('challenges', () => {
  it('a challenge answers once: a replay fails, even from a stale copy of the session', async () => {
    const authenticator = new SoftAuthenticator();
    const session = newSession();
    await register(session, authenticator);
    const options = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null });
    const staleCopy = JSON.parse(JSON.stringify(session));
    const response = authenticator.getAssertion(options, ORIGIN);
    await verifyAuthentication(rp, session, response, { purpose: 'login', userId: null });
    await expect(verifyAuthentication(rp, session, response, { purpose: 'login', userId: null })).rejects.toThrow('INVALID_SECRET');
    // a concurrent request that loaded the session before it was saved
    await expect(verifyAuthentication(rp, staleCopy, response, { purpose: 'login', userId: null })).rejects.toThrow('INVALID_SECRET');
  });

  it('a failed verification still uses the challenge up', async () => {
    const authenticator = new SoftAuthenticator();
    const session = newSession();
    await register(session, authenticator);
    const options = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null });
    const bad = authenticator.getAssertion(options, 'https://evil.example');
    await expect(verifyAuthentication(rp, session, bad, { purpose: 'login', userId: null })).rejects.toThrow('INVALID_SIGNATURE');
    const good = authenticator.getAssertion(options, ORIGIN);
    await expect(verifyAuthentication(rp, session, good, { purpose: 'login', userId: null })).rejects.toThrow('INVALID_SECRET');
  });

  it('an expired challenge is refused', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
    const authenticator = new SoftAuthenticator();
    const session = newSession();
    await register(session, authenticator);
    const options = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null });
    jest.setSystemTime(Date.now() + CHALLENGE_TTL_MS + 1);
    const response = authenticator.getAssertion(options, ORIGIN);
    await expect(verifyAuthentication(rp, session, response, { purpose: 'login', userId: null })).rejects.toThrow('INVALID_SECRET');
  });

  it('the autofill (conditional) challenge lives longer', async () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
    const authenticator = new SoftAuthenticator();
    const session = newSession();
    await register(session, authenticator);
    const options = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null, conditional: true });
    jest.setSystemTime(Date.now() + CHALLENGE_TTL_MS + 1000);
    const response = authenticator.getAssertion(options, ORIGIN);
    await expect(verifyAuthentication(rp, session, response, { purpose: 'login', userId: null })).resolves.toMatchObject({ userId: USER });
    expect(AUTOFILL_CHALLENGE_TTL_MS).toBeGreaterThan(CHALLENGE_TTL_MS);
  });

  it('two tabs: both ceremonies verify, in any order', async () => {
    const authenticator = new SoftAuthenticator();
    const session = newSession();
    await register(session, authenticator);
    const first = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null });
    const second = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null });
    await expect(verifyAuthentication(rp, session, authenticator.getAssertion(second, ORIGIN), { purpose: 'login', userId: null })).resolves.toBeTruthy();
    await expect(verifyAuthentication(rp, session, authenticator.getAssertion(first, ORIGIN), { purpose: 'login', userId: null })).resolves.toBeTruthy();
  });

  it(`keeps at most ${MAX_CHALLENGES} challenges, dropping the oldest`, async () => {
    jest.useFakeTimers({ now: new Date('2026-10-31T12:00:00Z') });
    const session = newSession();
    const challenges: string[] = [];
    for (let i = 0; i < MAX_CHALLENGES + 2; i++) {
      jest.setSystemTime(Date.now() + 10);
      challenges.push((await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null })).challenge);
    }
    expect(Object.keys(session.webauthnChallenges).sort()).toEqual(challenges.slice(2).sort());
  });

  it('a login challenge cannot be used for step-up and vice versa', async () => {
    const authenticator = new SoftAuthenticator();
    const session = newSession();
    await register(session, authenticator);
    const login = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null });
    await expect(verifyAuthentication(rp, session, authenticator.getAssertion(login, ORIGIN), { purpose: 'stepup', userId: USER })).rejects.toThrow('INVALID_SECRET');
  });
});

describe('authentication', () => {
  it('login options never carry credential ids', async () => {
    const options = await createAuthenticationOptions(rp, newSession(), { purpose: 'login', userId: null });
    expect(options.allowCredentials).toEqual([]);
    expect(options.userVerification).toBe('required');
    expect(options.rpId).toBe('cg.box');
  });

  it('accepts a user-verified assertion and records the use', async () => {
    const authenticator = new SoftAuthenticator('increment');
    const session = newSession();
    await register(session, authenticator);
    const options = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null });
    const row = await verifyAuthentication(rp, session, authenticator.getAssertion(options, ORIGIN), { purpose: 'login', userId: null });
    expect(row.userId).toBe(USER);
    expect(memoryPasskeys.rows[0].counter).toBe(1);
    expect(memoryPasskeys.rows[0].lastUsedAt).not.toBeNull();
  });

  it.each([
    'http://cg.box',
    'https://sub.cg.box',
    'https://cg.box.evil.com',
  ])('rejects an assertion from origin %s', async (origin) => {
    const authenticator = new SoftAuthenticator();
    const session = newSession();
    await register(session, authenticator);
    const options = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null });
    await expect(verifyAuthentication(rp, session, authenticator.getAssertion(options, origin), { purpose: 'login', userId: null })).rejects.toThrow('INVALID_SIGNATURE');
  });

  it('a credential of another RP ID is unknown here', async () => {
    const authenticator = new SoftAuthenticator();
    // registered on the legacy CG ID relying party (as imported rows are)
    await register(newSession(), authenticator, { relyingParty: legacyRp });
    const session = newSession();
    const options = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null });
    const id = [...authenticator.credentials.keys()][0];
    // the browser would sign for id.app.cg; either way the credential is not this RP's
    await expect(verifyAuthentication(rp, session, authenticator.getAssertion(options, ORIGIN, id, { rpId: 'id.app.cg' }), { purpose: 'login', userId: null })).rejects.toThrow('NOT_FOUND');
  });

  it('an assertion signed for another RP ID is refused even for a known credential', async () => {
    const authenticator = new SoftAuthenticator();
    const session = newSession();
    await register(session, authenticator);
    const options = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null });
    await expect(verifyAuthentication(rp, session, authenticator.getAssertion(options, ORIGIN, undefined, { rpId: 'id.app.cg' }), { purpose: 'login', userId: null })).rejects.toThrow('INVALID_SIGNATURE');
  });

  it('rejects an assertion without user verification', async () => {
    const authenticator = new SoftAuthenticator();
    const session = newSession();
    await register(session, authenticator);
    const options = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null });
    await expect(verifyAuthentication(rp, session, authenticator.getAssertion(options, ORIGIN, undefined, { uv: false }), { purpose: 'login', userId: null })).rejects.toThrow('INVALID_SIGNATURE');
  });

  it('rejects and reports a signature counter that does not increase', async () => {
    const authenticator = new SoftAuthenticator('increment');
    const session = newSession();
    await register(session, authenticator);
    const first = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null });
    await verifyAuthentication(rp, session, authenticator.getAssertion(first, ORIGIN, undefined, { counter: 7 }), { purpose: 'login', userId: null });
    const second = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null });
    await expect(verifyAuthentication(rp, session, authenticator.getAssertion(second, ORIGIN, undefined, { counter: 5 }), { purpose: 'login', userId: null })).rejects.toThrow('INVALID_SIGNATURE');
    expect(warn.mock.calls.some(call => String(call[0]).includes('counter'))).toBe(true);
  });

  it('a deleted credential is DELETED', async () => {
    const authenticator = new SoftAuthenticator();
    const session = newSession();
    await register(session, authenticator);
    memoryPasskeys.rows[0].deletedAt = new Date().toISOString();
    const options = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null });
    await expect(verifyAuthentication(rp, session, authenticator.getAssertion(options, ORIGIN), { purpose: 'login', userId: null })).rejects.toThrow('DELETED');
  });

  it('a user handle that does not match the credential is refused', async () => {
    const authenticator = new SoftAuthenticator();
    const session = newSession();
    await register(session, authenticator);
    const options = await createAuthenticationOptions(rp, session, { purpose: 'login', userId: null });
    await expect(verifyAuthentication(rp, session, authenticator.getAssertion(options, ORIGIN, undefined, { userHandle: newUserHandle() }), { purpose: 'login', userId: null })).rejects.toThrow('INVALID_SIGNATURE');
  });

  it('step-up: a missing user handle is fine, another user\'s credential is not', async () => {
    const authenticator = new SoftAuthenticator();
    await register(newSession(), authenticator, { userId: USER });
    const session = newSession();
    const options = await createAuthenticationOptions(rp, session, { purpose: 'stepup', userId: USER });
    await expect(verifyAuthentication(rp, session, authenticator.getAssertion(options, ORIGIN, undefined, { userHandle: null }), { purpose: 'stepup', userId: USER })).resolves.toMatchObject({ userId: USER });

    const foreign = await createAuthenticationOptions(rp, session, { purpose: 'stepup', userId: OTHER_USER });
    await expect(verifyAuthentication(rp, session, authenticator.getAssertion(foreign, ORIGIN), { purpose: 'stepup', userId: OTHER_USER })).rejects.toThrow('NOT_ALLOWED');
  });

  it('the legacy CG ID relying party still verifies its own credentials', async () => {
    const authenticator = new SoftAuthenticator();
    await register(newSession(), authenticator, { relyingParty: legacyRp });
    const session = newSession();
    const options = await createAuthenticationOptions(legacyRp, session, { purpose: 'login', userId: null });
    expect(options.rpId).toBe('id.app.cg');
    await expect(verifyAuthentication(legacyRp, session, authenticator.getAssertion(options, 'https://id.app.cg'), { purpose: 'login', userId: null })).resolves.toMatchObject({ rpId: 'id.app.cg' });
  });
});
