// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Against a real, throwaway PostgreSQL (skipped unless CG_TEST_PG_HOST is
 * set; the database `cryptogram` is reset by this test — never point it at
 * a database with data):
 *
 *   docker run -d --name pg-test -e POSTGRES_PASSWORD=pw -e POSTGRES_DB=cryptogram cryptogram/db:18
 *   CG_TEST_PG_HOST=<host> CG_TEST_PG_PASSWORD=pw yarn jest tests/securityStepDb.spec.ts
 *
 * - the migration up / down / up, with its GRANTs;
 * - the realtime check of the account-security step under the call
 *   server's restricted role (`mediasoup`, no access to users / passkeys /
 *   wallets — only EXECUTE on security_step_db_required);
 * - transfer-token redemption: concurrent redemptions, expiry, deleted users.
 */

import { Pool } from 'pg';
import { TransferLinksAndSecurityStep1793520000000 as Migration } from '../migrations/1793520000000-transferLinksAndSecurityStep';

const HOST = process.env.CG_TEST_PG_HOST;
const ADMIN_PASSWORD = process.env.CG_TEST_PG_PASSWORD || 'pw';
const MEDIASOUP_PASSWORD = 'mediasoup-test';
const describeDb = HOST ? describe : describe.skip;

jest.mock('../redis', () => require('./helpers/memoryRedis'));

describeDb('account-security step and transfer links on PostgreSQL', () => {
  let admin: Pool;
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);

  /** loads srv modules with util/postgres connected as `role` */
  function withRole<T>(role: 'admin' | 'mediasoup', load: () => T): T {
    const saved = { ...process.env };
    process.env.DB_HOST = HOST;
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
      process.env.DB_TYPE = 'mediasoup';
      process.env.PG_PASSWORD = MEDIASOUP_PASSWORD;
    }
    let result!: T;
    jest.isolateModules(() => {
      result = load();
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
    admin = new Pool({ host: HOST, user: 'postgres', password: ADMIN_PASSWORD, database: 'cryptogram', max: 25 });
    await q(`DROP TABLE IF EXISTS transfer_tokens, passkeys, wallets, devices, users CASCADE`);
    await q(`DROP FUNCTION IF EXISTS security_step_db_required(uuid, text)`);
    for (const role of ['writer', 'reader']) {
      await q(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role}; END IF; END $$`);
    }
    await q(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mediasoup') THEN CREATE ROLE mediasoup LOGIN PASSWORD '${MEDIASOUP_PASSWORD}'; END IF; END $$`);
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
    await q(`CREATE TABLE devices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" uuid)`);
    // what the call server's role had before (see the addMediasoup* migrations)
    await q(`GRANT SELECT ON devices TO mediasoup`);
    await q(`REVOKE ALL ON users, passkeys, wallets FROM mediasoup`);

    const runner = { query: (sql: string, params?: unknown[]) => q(sql, params) } as any;
    const migration = new Migration();
    await migration.up(runner);
    await migration.down(runner);
    await migration.up(runner);

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
      const { token } = await helper.create(user, '/c/x/', 600000);
      await expect(helper.peek(token)).resolves.toMatchObject({ userId: user });
      const results = await Promise.all(Array.from({ length: 20 }, () => helper.consume(token)));
      expect(results.filter(Boolean)).toEqual([{ userId: user, nextPath: '/c/x/' }]);
      await expect(helper.consume(token)).resolves.toBeNull();

      const expired = await helper.create(user, null, 1);
      await new Promise(resolve => setTimeout(resolve, 20));
      await expect(helper.consume(expired.token)).resolves.toBeNull();

      const ofDeleted = await helper.create(deleted, null, 600000);
      await expect(helper.peek(ofDeleted.token)).resolves.toBeNull();
      await expect(helper.consume(ofDeleted.token)).resolves.toBeNull();

      const stored = await q(`SELECT count(*)::int AS n FROM transfer_tokens WHERE "tokenHash" = $1`, [token]);
      expect(stored.rows[0].n).toBe(0);
    }
    finally {
      await pool.end();
    }
  });
});
