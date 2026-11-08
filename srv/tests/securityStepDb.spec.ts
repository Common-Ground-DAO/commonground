// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Against a real, throwaway PostgreSQL (skipped unless CG_TEST_PG_HOST is
 * set; the database `cryptogram` is reset by this test — never point it at
 * a database with data):
 *
 *   docker run -d --name pg-test -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=cryptogram cryptogram/db:18
 *   CG_TEST_PG_HOST=127.0.0.1 CG_TEST_PG_PORT=55432 CG_TEST_PG_PASSWORD=pw yarn jest tests/securityStepDb.spec.ts
 *
 * Host and port come only from CG_TEST_PG_HOST / CG_TEST_PG_PORT
 * (tests/helpers/testPg.ts), also for the util/postgres pools it loads.
 *
 * - the migration up / down / up, with its GRANTs;
 * - the realtime check of the account-security step under the call
 *   server's restricted role (`mediasoup`, no access to users / passkeys /
 *   wallets — only EXECUTE on security_step_db_required);
 * - transfer-token redemption: concurrent redemptions, expiry, deleted users;
 * - session generations (docs/auth-identity §2): the migration, logins that
 *   start while a sign-out of other devices commits, device keys and transfer
 *   links from before a sign-out (also under the call server's role), a
 *   signed-out session that tries to sign out others, concurrent sign-outs;
 *   with CG_TEST_REDIS_URL also the Valkey copies (script, re-seed).
 */

import { Pool } from 'pg';
import { webcrypto } from 'node:crypto';
import { TransferLinksAndSecurityStep1793520000000 as Migration } from '../migrations/1793520000000-transferLinksAndSecurityStep';
import { SessionGenerations1793560000000 as GenerationsMigration } from '../migrations/1793560000000-sessionGenerations';
import { TEST_PG_HOST, TEST_PG_PORT, TEST_PG_PASSWORD, describeDb } from './helpers/testPg';

const HOST = TEST_PG_HOST;
const PORT = TEST_PG_PORT;
const ADMIN_PASSWORD = TEST_PG_PASSWORD;
const MEDIASOUP_PASSWORD = 'mediasoup-test';
const WRITER_PASSWORD = 'writer-test';
const REDIS_URL = process.env.CG_TEST_REDIS_URL;

jest.mock('../redis', () => require('./helpers/memoryRedis'));

describeDb('account-security step and transfer links on PostgreSQL', () => {
  let admin: Pool;
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);

  /** loads srv modules with util/postgres connected as `role` */
  function withRole<T>(role: 'admin' | 'writer' | 'mediasoup', load: () => T): T {
    const saved = { ...process.env };
    process.env.DB_HOST = HOST;
    // util/postgres takes DB_PORT (default 5432): always the test server's
    process.env.DB_PORT = String(PORT);
    process.env.BASE_URL = 'https://cg.box';
    process.env.DEPLOYMENT = 'prod';
    delete process.env.CG_LEGACY_CGID;
    if (role === 'admin') {
      process.env.PG_SU_NAME = 'postgres';
      process.env.PG_SU_PASSWORD = ADMIN_PASSWORD;
    }
    else {
      delete process.env.PG_SU_NAME;
      delete process.env.PG_SU_PASSWORD;
      process.env.DB_TYPE = role;
      process.env.PG_PASSWORD = role === 'writer' ? WRITER_PASSWORD : MEDIASOUP_PASSWORD;
    }
    process.env.REDIS_SECRET = 'test-secret-0123456789';
    let result!: T;
    jest.isolateModules(() => {
      result = load();
      // whatever the modules connect through is the test server
      const { options } = require('../util/postgres').default as Pool;
      if (options.host !== HOST || options.port !== PORT) {
        throw new Error(`util/postgres points at ${options.host}:${options.port}, not the test server`);
      }
    });
    process.env = saved;
    return result;
  }

  let user: string;
  let xOnly: string;
  let weak: string;
  let deleted: string;

  let warn: jest.SpyInstance;
  beforeAll(async () => {
    // util/postgres warns about missing Docker secrets outside dev
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    admin = new Pool({ host: HOST, port: PORT, user: 'postgres', password: ADMIN_PASSWORD, database: 'cryptogram', max: 25 });
    await q(`DROP TABLE IF EXISTS transfer_tokens, passkeys, wallets, devices, users CASCADE`);
    await q(`DROP FUNCTION IF EXISTS security_step_db_required(uuid, text)`);
    await q(`DROP FUNCTION IF EXISTS session_generation_of(uuid)`);
    await q(`DROP SEQUENCE IF EXISTS session_generation_seq`);
    for (const role of ['writer', 'reader']) {
      await q(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role}; END IF; END $$`);
    }
    await q(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mediasoup') THEN CREATE ROLE mediasoup LOGIN PASSWORD '${MEDIASOUP_PASSWORD}'; END IF; END $$`);
    // the api's role, with the table rights the earlier migrations give it
    await q(`ALTER ROLE writer LOGIN PASSWORD '${WRITER_PASSWORD}'`);
    // the parts of the schema these statements touch, as before the migration
    await q(`CREATE TABLE users (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      email varchar(255), "emailVerified" boolean NOT NULL DEFAULT false,
      password varchar(255), is_bot boolean NOT NULL DEFAULT false,
      "deletedAt" timestamptz(3), "updatedAt" timestamptz(3) DEFAULT now(),
      "verificationCode" varchar(32), "verificationCodeExpiration" timestamptz(3))`);
    await q(`CREATE UNIQUE INDEX users_email_lower ON users (LOWER(email))`);
    await q(`CREATE INDEX "idx_users_verification_codes" ON users ("verificationCode")`);
    await q(`CREATE TABLE passkeys (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" uuid, "rpId" text, "deletedAt" timestamptz)`);
    await q(`CREATE TABLE wallets (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" uuid, type text, "loginEnabled" boolean, "deletedAt" timestamptz)`);
    await q(`CREATE TABLE devices (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" uuid, "publicKey" jsonb,
      "webPushSubscription" jsonb, "deviceInfo" jsonb DEFAULT '{}',
      "createdAt" timestamptz(3) DEFAULT now(), "updatedAt" timestamptz(3) DEFAULT now(), "deletedAt" timestamptz(3))`);
    // what the call server's role had before (see the addMediasoup* migrations)
    await q(`GRANT SELECT ON devices TO mediasoup`);
    await q(`GRANT ALL PRIVILEGES ON users, devices TO writer`);
    await q(`REVOKE ALL ON users, passkeys, wallets FROM mediasoup`);

    const runner = { query: (sql: string, params?: unknown[]) => q(sql, params) } as any;
    const migration = new Migration();
    await migration.up(runner);
    await migration.down(runner);
    await migration.up(runner);
    const generations = new GenerationsMigration();
    await generations.up(runner);
    await generations.down(runner);
    await generations.up(runner);

    const insert = async (sql: string, params: unknown[] = []) => (await q(sql, params)).rows[0].id as string;
    user = await insert(`INSERT INTO users (email, "emailVerified", password) VALUES ('a@example.org', true, 'hash') RETURNING id`);
    xOnly = await insert(`INSERT INTO users (email, "emailVerified") VALUES ('x@example.org', true) RETURNING id`);
    weak = await insert(`INSERT INTO users (email, password, "passwordChangeRequired") VALUES ('w@example.org', 'hash', true) RETURNING id`);
    deleted = await insert(`INSERT INTO users (email, password, "deletedAt") VALUES ('d@example.org', 'hash', now()) RETURNING id`);
  }, 60000);

  afterAll(async () => {
    warn.mockRestore();
    await admin?.end();
  });

  it('the migration leaves the expected schema and grants', async () => {
    const columns = (await q(`SELECT column_name FROM information_schema.columns WHERE table_name = 'users'`)).rows.map(row => row.column_name);
    expect(columns).toContain('passwordChangeRequired');
    expect(columns).not.toContain('verificationCode');
    const grants = (await q(`SELECT grantee, privilege_type FROM information_schema.role_table_grants WHERE table_name = 'transfer_tokens' AND grantee IN ('writer', 'reader')`)).rows;
    expect(grants).toEqual(expect.arrayContaining([{ grantee: 'reader', privilege_type: 'SELECT' }, { grantee: 'writer', privilege_type: 'UPDATE' }]));
    const execute = (await q(`SELECT has_function_privilege('mediasoup', 'security_step_db_required(uuid, text)', 'EXECUTE') AS ok, has_function_privilege('public', 'security_step_db_required(uuid, text)', 'EXECUTE') AS public`)).rows[0];
    expect(execute).toEqual({ ok: true, public: false });
  });

  it('the call server\'s role gets the answer, but cannot read the tables', async () => {
    const { securityStep, pool } = withRole('mediasoup', () => ({
      securityStep: require('../util/securityStep') as typeof import('../util/securityStep'),
      pool: require('../util/postgres').default as Pool,
    }));
    try {
      await expect(securityStep.isSecurityStepRequiredForRealtime(user, { useApiRecord: false })).resolves.toBe(false);
      await expect(securityStep.isSecurityStepRequiredForRealtime(xOnly, { useApiRecord: false })).resolves.toBe(true);
      await expect(securityStep.isSecurityStepRequiredForRealtime(weak, { useApiRecord: false })).resolves.toBe(true);
      await expect(securityStep.isSecurityStepRequiredForRealtime(deleted, { useApiRecord: false })).resolves.toBe(true);
      await expect(securityStep.isSecurityStepRequiredForRealtime('00000000-0000-4000-8000-00000000dead', { useApiRecord: false })).resolves.toBe(true);

      // a passkey of this RP or a sign-in wallet counts; one of another RP does not
      await q(`INSERT INTO passkeys ("userId", "rpId") VALUES ($1, 'id.app.cg')`, [xOnly]);
      await expect(securityStep.isSecurityStepRequiredForRealtime(xOnly, { useApiRecord: false })).resolves.toBe(true);
      await q(`INSERT INTO passkeys ("userId", "rpId") VALUES ($1, 'cg.box')`, [xOnly]);
      await expect(securityStep.isSecurityStepRequiredForRealtime(xOnly, { useApiRecord: false })).resolves.toBe(false);

      await expect(pool.query(`SELECT * FROM users`)).rejects.toThrow(/permission denied/);
      await expect(pool.query(`SELECT * FROM passkeys`)).rejects.toThrow(/permission denied/);
    }
    finally {
      await pool.end();
    }
  });

  it('transfer tokens: of 20 concurrent redemptions exactly one succeeds; expired and deleted fail', async () => {
    const { helper, pool } = withRole('admin', () => ({
      helper: require('../repositories/transferTokens').default as typeof import('../repositories/transferTokens').default,
      pool: require('../util/postgres').default as Pool,
    }));
    try {
      const { token } = await helper.create(user, '/c/x/', 600000, 0);
      await expect(helper.peek(token)).resolves.toMatchObject({ userId: user });
      const results = await Promise.all(Array.from({ length: 20 }, () => helper.consume(token)));
      expect(results.filter(Boolean)).toEqual([{ userId: user, nextPath: '/c/x/' }]);
      await expect(helper.consume(token)).resolves.toBeNull();

      const expired = await helper.create(user, null, 1, 0);
      await new Promise(resolve => setTimeout(resolve, 20));
      await expect(helper.consume(expired.token)).resolves.toBeNull();

      const ofDeleted = await helper.create(deleted, null, 600000, 0);
      await expect(helper.peek(ofDeleted.token)).resolves.toBeNull();
      await expect(helper.consume(ofDeleted.token)).resolves.toBeNull();

      const stored = await q(`SELECT count(*)::int AS n FROM transfer_tokens WHERE "tokenHash" = $1`, [token]);
      expect(stored.rows[0].n).toBe(0);
    }
    finally {
      await pool.end();
    }
  });

  it('transfer tokens (as the api\'s role): a declined link and the unused links of a sign-out never redeem; other accounts keep theirs', async () => {
    const { helper, pool } = withRole('writer', () => ({
      helper: require('../repositories/transferTokens').default as typeof import('../repositories/transferTokens').default,
      pool: require('../util/postgres').default as Pool,
    }));
    try {
      const declined = await helper.create(user, null, 600000, 0);
      const sibling = await helper.create(user, null, 600000, 0);
      const othersOpen = await helper.create(xOnly, null, 600000, 0);
      await expect(helper.decline(declined.token)).resolves.toBe(true);
      await expect(helper.decline(declined.token)).resolves.toBe(false);
      await expect(helper.peek(declined.token)).resolves.toBeNull();
      await expect(helper.consume(declined.token)).resolves.toBeNull();
      // the account's other unused link went with it; another account's did not
      await expect(helper.consume(sibling.token)).resolves.toBeNull();
      await expect(helper.peek(othersOpen.token)).resolves.toMatchObject({ userId: xOnly });
      await expect(helper.decline('A'.repeat(43))).resolves.toBe(false);

      const used = await helper.create(user, null, 600000, 0);
      await expect(helper.consume(used.token)).resolves.toMatchObject({ userId: user });
      const open1 = await helper.create(user, null, 600000, 0);
      const open2 = await helper.create(user, '/c/y/', 600000, 0);
      const others = await helper.create(xOnly, null, 600000, 0);
      await expect(helper.discardUnused(user)).resolves.toBe(2);
      await expect(helper.consume(open1.token)).resolves.toBeNull();
      await expect(helper.consume(open2.token)).resolves.toBeNull();
      await expect(helper.discardUnused(user)).resolves.toBe(0);
      await expect(helper.consume(others.token)).resolves.toMatchObject({ userId: xOnly });
    }
    finally {
      await pool.end();
    }
  });

  it('a transfer session adds a way in only while the database shows the account lacks it', async () => {
    const { securityStep, pool } = withRole('admin', () => ({
      securityStep: require('../util/securityStep') as typeof import('../util/securityStep'),
      pool: require('../util/postgres').default as Pool,
    }));
    const moved = (await q(`INSERT INTO users (email) VALUES ('moved@example.org') RETURNING id`)).rows[0].id as string;
    const session = (authMethod: string, agoMs = 0) => ({ session: { user: { id: moved, deviceId: 'd' }, authAt: Date.now() - agoMs, authMethod } }) as any;
    const add = (request: unknown, what: 'sign-in-method' | 'email') => securityStep.requireAuthToAdd(request as any, what, { emailRequired: true });
    try {
      // no sign-in method here and no verified address: the step, in both parts
      await expect(add(session('transfer', 30 * 60 * 1000), 'sign-in-method')).resolves.toEqual({ userId: moved });
      await expect(add(session('transfer'), 'email')).resolves.toEqual({ userId: moved });
      // a device-key session alone is no sign-in
      await expect(add({ session: { user: { id: moved, deviceId: 'd' } } }, 'sign-in-method')).rejects.toThrow('REAUTH_REQUIRED');
      // a passkey of the old relying party does not count here
      await q(`INSERT INTO passkeys ("userId", "rpId") VALUES ($1, 'id.app.cg')`, [moved]);
      await expect(add(session('transfer'), 'sign-in-method')).resolves.toEqual({ userId: moved });
      // one of this instance does: a second method takes the step-up, the address still not
      await q(`INSERT INTO passkeys ("userId", "rpId") VALUES ($1, 'cg.box')`, [moved]);
      await expect(add(session('transfer'), 'sign-in-method')).rejects.toThrow('REAUTH_REQUIRED');
      await expect(add(session('transfer'), 'email')).resolves.toEqual({ userId: moved });
      await expect(securityStep.isSecurityStepRequiredForRealtime(moved)).resolves.toBe(true);
      // complete: the transfer session is an ordinary sign-in for everything
      await q(`UPDATE users SET "emailVerified" = true WHERE id = $1`, [moved]);
      await expect(add(session('transfer'), 'email')).rejects.toThrow('REAUTH_REQUIRED');
      await expect(add(session('transfer'), 'sign-in-method')).rejects.toThrow('REAUTH_REQUIRED');
      // the realtime check agrees (the api's record was cleared on the way)
      await expect(securityStep.isSecurityStepRequiredForRealtime(moved)).resolves.toBe(false);
      // the usual step-up works
      await expect(add(session('passkey'), 'sign-in-method')).resolves.toEqual({ userId: moved });
      await expect(add(session('passkey', 6 * 60 * 1000), 'sign-in-method')).rejects.toThrow('REAUTH_REQUIRED');
    }
    finally {
      await pool.end();
    }
  });

  it('a first password: of concurrent writes exactly one lands, and never over an existing password', async () => {
    const { users, pool } = withRole('writer', () => ({
      users: require('../repositories/users').default as typeof import('../repositories/users').default,
      pool: require('../util/postgres').default as Pool,
    }));
    const fresh = (await q(`INSERT INTO users (email) VALUES ('first-pw@example.org') RETURNING id`)).rows[0].id as string;
    try {
      const results = await Promise.all(Array.from({ length: 5 }, (_, i) => users.setFirstPassword(fresh, `password ${i}`)));
      expect(results.filter(Boolean)).toHaveLength(1);
      const stored = (await q(`SELECT password FROM users WHERE id = $1`, [fresh])).rows[0].password as string;
      await expect(users.setFirstPassword(fresh, 'another one')).resolves.toBe(false);
      expect((await q(`SELECT password FROM users WHERE id = $1`, [fresh])).rows[0].password).toBe(stored);
      // an account that had one all along
      await expect(users.setFirstPassword(user, 'another one')).resolves.toBe(false);
    }
    finally {
      await pool.end();
    }
  }, 30000);

  describe('session generations', () => {
    type Repos = {
      users: typeof import('../repositories/users').default;
      devices: typeof import('../repositories/device').default;
      tokens: typeof import('../repositories/transferTokens').default;
      pool: Pool;
    };
    let repos: Repos;
    let account: string;

    // as the api's role (writer), like in production
    beforeAll(() => {
      repos = withRole('writer', () => ({
        users: require('../repositories/users').default,
        devices: require('../repositories/device').default,
        tokens: require('../repositories/transferTokens').default,
        pool: require('../util/postgres').default as Pool,
      }));
    });
    afterAll(async () => {
      await repos.pool.end();
    });
    beforeEach(async () => {
      account = (await q(`INSERT INTO users (email, "emailVerified", password) VALUES ($1, true, 'hash') RETURNING id`, [`g${Date.now()}${Math.random()}@example.org`])).rows[0].id;
    });

    /** a device key of `account` created by a login with generation `gen`, and a signature for `secret` */
    async function deviceKey(gen: number) {
      const keyPair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-384' }, true, ['sign', 'verify']) as CryptoKeyPair;
      const publicKey = await webcrypto.subtle.exportKey('jwk', keyPair.publicKey);
      const { deviceId } = await repos.devices.createDevice(account, publicKey, gen);
      const sign = async (secret: string) => Buffer.from(await webcrypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-384' }, keyPair.privateKey, new TextEncoder().encode(secret))).toString('base64');
      return { deviceId, sign };
    }
    const verify = async (key: Awaited<ReturnType<typeof deviceKey>>) =>
      repos.devices.verifyDeviceAndGetUserId(key.deviceId, 's'.repeat(20), await key.sign('s'.repeat(20)));

    /** a change of the account's password in one transaction with the sign-out; `beforeCommit` runs before COMMIT */
    async function changePassword(callerGeneration: number, keepDeviceId: string, beforeCommit: () => Promise<void> = async () => undefined) {
      const client = await repos.pool.connect();
      try {
        await client.query('BEGIN');
        await client.query(`UPDATE users SET password = 'new hash' WHERE id = $1`, [account]);
        const gen = await repos.users.bumpSessionGeneration(client, account, callerGeneration, keepDeviceId);
        await beforeCommit();
        await client.query('COMMIT');
        return gen;
      }
      catch (e) {
        await client.query('ROLLBACK');
        throw e;
      }
      finally {
        client.release();
      }
    }

    it('the migration: sequence, columns, and the generation function for every role', async () => {
      for (const [table, column] of [['users', 'sessionGeneration'], ['devices', 'generation'], ['transfer_tokens', 'generation']]) {
        const row = (await q(`SELECT data_type, column_default FROM information_schema.columns WHERE table_name = $1 AND column_name = $2`, [table, column])).rows[0];
        expect(row).toEqual({ data_type: 'bigint', column_default: '0' });
      }
      const privileges = (await q(`SELECT has_sequence_privilege('writer', 'session_generation_seq', 'USAGE') AS usage,
        has_function_privilege('mediasoup', 'session_generation_of(uuid)', 'EXECUTE') AS mediasoup,
        has_function_privilege('public', 'session_generation_of(uuid)', 'EXECUTE') AS public`)).rows[0];
      expect(privileges).toEqual({ usage: true, mediasoup: true, public: false });
    });

    it('a login that starts while a sign-out commits waits for the commit, and then gets a later generation', async () => {
      const keep = await deviceKey(await repos.users.nextSessionGeneration());
      let started: Promise<number> | undefined;
      let settled = false;
      const gen = await changePassword(0, keep.deviceId, async () => {
        started = repos.users.nextSessionGeneration();
        started.then(() => { settled = true; });
        await new Promise(resolve => setTimeout(resolve, 300));
        expect(settled).toBe(false);
      });
      const loginGeneration = await started!;
      expect(loginGeneration).toBeGreaterThan(gen);
      // the change is visible to it: its credential check sees the new password
      expect((await q(`SELECT password FROM users WHERE id = $1`, [account])).rows[0].password).toBe('new hash');
    });

    it('a device-key login that verified the key before the commit and saves after it is refused; the key is dead', async () => {
      const keep = await deviceKey(await repos.users.nextSessionGeneration());
      const old = await deviceKey(await repos.users.nextSessionGeneration());
      // the login starts and checks the key …
      const loginGeneration = await repos.users.nextSessionGeneration();
      await expect(verify(old)).resolves.toMatchObject({ userId: account });
      // … the password change commits with the sign-out …
      const gen = await changePassword(0, keep.deviceId);
      // … and the login's check after saving its session refuses it
      expect(await repos.users.getSessionGeneration(account)).toBe(gen);
      expect(gen).toBeGreaterThan(loginGeneration);
      // from the commit on, the old key signs in nowhere (HTTP and socket login use the same lookup)
      await expect(verify(old)).rejects.toThrow('NOT_FOUND');
      await expect(repos.devices.isLiveDevice(old.deviceId)).resolves.toBe(false);
      // the device that signed the others out keeps working
      await expect(verify(keep)).resolves.toMatchObject({ userId: account });
      await expect(repos.devices.isLiveDevice(keep.deviceId)).resolves.toBe(true);
      // and so does a key of a login that started after the sign-out
      const later = await deviceKey(await repos.users.nextSessionGeneration());
      await expect(verify(later)).resolves.toMatchObject({ userId: account });
      // the clean-up deletes exactly the dead keys
      await expect(repos.devices.deleteStaleDevices(account, gen)).resolves.toEqual([old.deviceId]);
    });

    it('the call server\'s role rejects an old key too', async () => {
      const keep = await deviceKey(await repos.users.nextSessionGeneration());
      const old = await deviceKey(await repos.users.nextSessionGeneration());
      await changePassword(0, keep.deviceId);
      const { devices, pool } = withRole('mediasoup', () => ({
        devices: require('../repositories/device').default as typeof import('../repositories/device').default,
        pool: require('../util/postgres').default as Pool,
      }));
      try {
        await expect(devices.verifyDeviceAndGetUserId(old.deviceId, 's'.repeat(20), await old.sign('s'.repeat(20)))).rejects.toThrow('NOT_FOUND');
        await expect(devices.verifyDeviceAndGetUserId(keep.deviceId, 's'.repeat(20), await keep.sign('s'.repeat(20)))).resolves.toMatchObject({ userId: account });
      }
      finally {
        await pool.end();
      }
    });

    it('a transfer link minted before a sign-out does not redeem; one minted after does', async () => {
      const keep = await deviceKey(await repos.users.nextSessionGeneration());
      const before = await repos.tokens.create(account, null, 600000, 3);
      const gen = await changePassword(0, keep.deviceId);
      await expect(repos.tokens.peek(before.token)).resolves.toBeNull();
      await expect(repos.tokens.consume(before.token)).resolves.toBeNull();
      const after = await repos.tokens.create(account, null, 600000, gen);
      await expect(repos.tokens.consume(after.token)).resolves.toMatchObject({ userId: account });
      // the clean-up deletes only the dead, unused one
      const old = await repos.tokens.create(account, null, 600000, 1);
      await expect(repos.tokens.deleteStale(account, gen)).resolves.toBe(2);
      void old;
    });

    it('a session that was signed out itself cannot sign out others, and its change is rolled back', async () => {
      const first = await deviceKey(await repos.users.nextSessionGeneration());
      const second = await deviceKey(await repos.users.nextSessionGeneration());
      const secondSession = await repos.users.nextSessionGeneration();
      const gen = await changePassword(0, first.deviceId);
      await q(`UPDATE users SET password = 'hash' WHERE id = $1`, [account]);
      await expect(changePassword(secondSession, second.deviceId)).rejects.toThrow('LOGIN_REQUIRED');
      expect(await repos.users.getSessionGeneration(account)).toBe(gen);
      expect((await q(`SELECT password FROM users WHERE id = $1`, [account])).rows[0].password).toBe('hash');
      await expect(verify(first)).resolves.toMatchObject({ userId: account });
    });

    it('two sign-outs at the same time: the generation only grows; of two sessions of one account the later is refused', async () => {
      const first = await deviceKey(await repos.users.nextSessionGeneration());
      const second = await deviceKey(await repos.users.nextSessionGeneration());
      const caller = await repos.users.nextSessionGeneration();
      const results = await Promise.allSettled([
        repos.users.bumpSessionGenerationAlone(account, caller, first.deviceId),
        repos.users.bumpSessionGenerationAlone(account, caller, second.deviceId),
      ]);
      const done = results.filter(r => r.status === 'fulfilled') as PromiseFulfilledResult<number>[];
      expect(done).toHaveLength(1);
      expect((results.find(r => r.status === 'rejected') as PromiseRejectedResult).reason.message).toBe('LOGIN_REQUIRED');
      expect(await repos.users.getSessionGeneration(account)).toBe(done[0].value);
      // two accounts at once: both take effect, with distinct, growing generations
      const other = (await q(`INSERT INTO users (email) VALUES ($1) RETURNING id`, [`o${Date.now()}@example.org`])).rows[0].id;
      const gens = await Promise.all([
        repos.users.bumpSessionGenerationAlone(account, done[0].value, first.deviceId),
        repos.users.bumpSessionGenerationAlone(other, 0, '00000000-0000-4000-8000-00000000beef'),
      ]);
      expect(gens[0]).not.toBe(gens[1]);
      expect(Math.min(...gens)).toBeGreaterThan(done[0].value);
    });

    it('the login path itself: a device login that verified the old key before the commit is refused after saving its session', async () => {
      const keep = await deviceKey(await repos.users.nextSessionGeneration());
      const old = await deviceKey(await repos.users.nextSessionGeneration());
      // the api's session setup and login helpers, connected as writer
      const mods = withRole('writer', () => ({
        express: require('express') as typeof import('express'),
        session: require('express-session') as typeof import('express-session'),
        setup: require('../util/sessionSetup') as typeof import('../util/sessionSetup'),
        userSessions: require('../util/userSessions') as typeof import('../util/userSessions'),
        auth: require('../util/authSession') as typeof import('../util/authSession'),
        users: require('../repositories/users').default as Repos['users'],
        devices: require('../repositories/device').default as Repos['devices'],
        pool: require('../util/postgres').default as Pool,
      }));
      const store = new mods.session.MemoryStore();
      const revoked = new Set<string>();
      const revocations = { revoke: async (sid: string) => { revoked.add(sid); }, isRevoked: async (sid: string) => revoked.has(sid) };
      const index = { record: async () => undefined, forget: async () => undefined, list: async () => [] as string[] };
      const copies = { read: async () => ({ gen: 0, keepSid: null }), publish: async () => undefined, copiedUpTo: async () => 0, markCopied: async () => undefined };
      mods.userSessions.withUserSessionIndex(store, index, {
        generations: copies,
        currentGeneration: (userId) => mods.users.getSessionGeneration(userId),
        discardDevice: (deviceId) => mods.devices.deleteDevice(deviceId),
      });
      let release!: () => void;
      let verified!: () => void;
      const released = new Promise<void>(resolve => { release = resolve; });
      const verifiedPromise = new Promise<void>(resolve => { verified = resolve; });
      const app = mods.express();
      // the session secret is read when the middleware is built (util/sessionSecret.ts),
      // after withRole restored the environment
      const savedSecret = process.env.REDIS_SECRET;
      process.env.REDIS_SECRET = 'test-secret-0123456789';
      try {
        app.use(mods.setup.createSessionMiddlewares(mods.setup.withSessionRevocation(store, revocations), revocations));
      }
      finally {
        if (savedSecret === undefined) delete process.env.REDIS_SECRET;
        else process.env.REDIS_SECRET = savedSecret;
      }
      // User/login {type:'device'}, reduced to its steps: generation, key check, (wait), session
      app.post('/device-login', async (request, response) => {
        try {
          mods.userSessions.setLoginGeneration(request, await mods.users.nextSessionGeneration());
          const { userId } = await mods.devices.verifyDeviceAndGetUserId(old.deviceId, 's'.repeat(20), await old.sign('s'.repeat(20)));
          verified();
          await released;
          await mods.auth.establishLoginSession(request, { userId, deviceId: old.deviceId, method: 'device' });
          response.json({});
        }
        catch (e) {
          response.json({ error: (e as Error).message });
        }
      });
      const server = app.listen(0);
      try {
        const pending = fetch(`http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}/device-login`, { method: 'POST' });
        await verifiedPromise;
        // the password change commits with the sign-out while the login runs
        await changePassword(0, keep.deviceId);
        release();
        const answer = await (await pending).json();
        expect(answer).toEqual({ error: 'NOT_FOUND' });
        // the session it saved is gone again
        const left = await new Promise<string[]>((resolve) => store.all((_e, all) => resolve(Object.keys(all ?? {}))));
        expect(left).toEqual([]);
        await expect(verify(old)).rejects.toThrow('NOT_FOUND');
      }
      finally {
        server.close();
        await mods.pool.end();
      }
    });

    (REDIS_URL ? it : it.skip)('the Valkey copies: one script, never lowered, kept session only with a newer generation', async () => {
      const { createClient } = require('redis') as typeof import('redis');
      const client = createClient({ url: REDIS_URL });
      await client.connect();
      try {
        const { redisSessionGenerations } = require('../util/sessionGenerations') as typeof import('../util/sessionGenerations');
        const copies = redisSessionGenerations(client as never);
        const keep = await deviceKey(await repos.users.nextSessionGeneration());
        const gen = await changePassword(0, keep.deviceId);
        await copies.publish(account, gen, 'sid-1');
        // an older sign-out arriving late changes neither the copy nor the kept session
        await copies.publish(account, gen - 1, 'sid-0');
        expect(await copies.read(account)).toEqual({ gen, keepSid: 'sid-1' });
      }
      finally {
        await client.quit();
      }
    });

    (REDIS_URL ? it : it.skip)('the reconciler: a copy that failed at sign-out, and one lost with Valkey data, arrive with its next run', async () => {
      const { createClient } = require('redis') as typeof import('redis');
      const client = createClient({ url: REDIS_URL });
      await client.connect();
      const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
      try {
        const generations = require('../util/sessionGenerations') as typeof import('../util/sessionGenerations');
        const copies = generations.redisSessionGenerations(client as never);
        const reconciler = new generations.GenerationReconciler(copies, (after) => repos.users.sessionGenerationsSince(after));
        expect(await reconciler.reconcile()).toBe(true);
        expect(reconciler.ready).toBe(true);
        // a sign-out whose copy fails (Valkey refuses writes)
        const keep = await deviceKey(await repos.users.nextSessionGeneration());
        const gen = await changePassword(0, keep.deviceId);
        const failing = { ...copies, publish: async () => { throw new Error('OOM command not allowed'); } };
        await expect(generations.publishGeneration(failing, account, gen, 'sid-1', 2)).resolves.toBe(false);
        expect((await copies.read(account)).gen).toBe(0);
        // the next run copies it
        expect(await reconciler.reconcile()).toBe(true);
        expect((await copies.read(account)).gen).toBe(gen);
        // Valkey loses its data (restored from an older snapshot): the next run copies again
        await client.flushDb();
        expect(await reconciler.reconcile()).toBe(true);
        expect((await copies.read(account)).gen).toBe(gen);
      }
      finally {
        error.mockRestore();
        await client.quit();
      }
    });

    it('a sign-out that cannot get its locks gives up instead of making logins wait', async () => {
      const keep = await deviceKey(await repos.users.nextSessionGeneration());
      // a long transaction holds the user row
      const holder = await q(`SELECT 1`).then(async () => {
        const client = await repos.pool.connect();
        await client.query('BEGIN');
        await client.query(`SELECT 1 FROM users WHERE id = $1 FOR UPDATE`, [account]);
        return client;
      });
      try {
        const started = Date.now();
        await expect(repos.users.bumpSessionGenerationAlone(account, 0, keep.deviceId)).rejects.toThrow('SERVICE_UNAVAILABLE');
        expect(Date.now() - started).toBeLessThan(8000);
        // logins were never blocked: the advisory lock is taken only after the row lock
        const login = Date.now();
        await repos.users.nextSessionGeneration();
        expect(Date.now() - login).toBeLessThan(1000);
      }
      finally {
        await holder.query('ROLLBACK');
        holder.release();
      }
      expect(await repos.users.getSessionGeneration(account)).toBe(0);
    }, 20000);
  });
});
