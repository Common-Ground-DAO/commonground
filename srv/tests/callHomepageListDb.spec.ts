// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The homepage's open calls (`callHelper.getHomepageCalls`) against a real,
 * throwaway PostgreSQL with the migrated schema (skipped unless
 * CG_TEST_PG_HOST is set): a viewer sees a call through one of their
 * claimed roles of the call's community, a non-member (or a visitor without
 * a session) only through that community's predefined Public role — the
 * Member role's permissions count for members only. The test creates and
 * drops its own database `cg_call_homepage_test` — never point it at a
 * server with data. Host and port come only from CG_TEST_PG_HOST /
 * CG_TEST_PG_PORT (tests/helpers/testPg.ts).
 */

import { Pool } from 'pg';
import { TEST_PG_HOST, TEST_PG_PORT, TEST_PG_PASSWORD, describeDb } from './helpers/testPg';
import { createMigratedDatabase } from './helpers/migratedDb';

const DATABASE = 'cg_call_homepage_test';

let mockPoolTarget: Pool | undefined;
jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => (mockPoolTarget as any).query(...args) },
}));

import callHelper from '../repositories/calls';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const COMMUNITY = id(0x100);      // premium: its calls may show on the homepage
const OTHER = id(0x101);
const R_ADMIN = id(0x200);
const R_MEMBER = id(0x201);
const R_PUBLIC = id(0x202);
const R_OTHER_MEMBER = id(0x210);
const CALL_PUBLIC = id(0x300);    // Public: CALL_EXISTS
const CALL_MEMBERS = id(0x301);   // Member: CALL_EXISTS (and the Admin row)
const CALL_SERVER = id(0x400);
const MEMBER = id(0x500);         // claimed Member of COMMUNITY
const VISITOR = id(0x501);        // no role in COMMUNITY
const FOREIGN = id(0x502);        // claimed Member of OTHER only

describeDb('homepage calls on PostgreSQL', () => {
  let server: Pool;
  let admin: Pool;

  beforeAll(async () => {
    server = new Pool({ host: TEST_PG_HOST, port: TEST_PG_PORT, user: 'postgres', password: TEST_PG_PASSWORD, database: 'postgres', max: 2 });
    await createMigratedDatabase(server, DATABASE);
    admin = new Pool({ host: TEST_PG_HOST, port: TEST_PG_PORT, user: 'postgres', password: TEST_PG_PASSWORD, database: DATABASE });
    for (const pool of [server, admin]) {
      pool.on('error', () => undefined);
    }
    mockPoolTarget = admin;

    // seeded without foreign keys and triggers: only the rows the query reads
    const seed = await admin.connect();
    const s = (sql: string, params?: unknown[]) => seed.query(sql, params);
    await s(`SET session_replication_role = replica`);
    for (const userId of [MEMBER, VISITOR, FOREIGN]) {
      await s(`INSERT INTO users ("id", "displayAccount") VALUES ($1, 'cg')`, [userId]);
    }
    for (const [communityId, url] of [[COMMUNITY, 'home'], [OTHER, 'other']]) {
      await s(`INSERT INTO communities ("id", "title", "url", "description", "shortDescription", "links", "tags") VALUES ($1, $2, $2, '', '', '[]', '{}')`, [communityId, url]);
    }
    await s(`INSERT INTO communities_premium ("communityId", "featureName", "activeUntil") VALUES ($1, 'BASIC', now() + interval '30 days')`, [COMMUNITY]);
    for (const [roleId, communityId, title] of [[R_ADMIN, COMMUNITY, 'Admin'], [R_MEMBER, COMMUNITY, 'Member'], [R_PUBLIC, COMMUNITY, 'Public'], [R_OTHER_MEMBER, OTHER, 'Member']]) {
      await s(`INSERT INTO roles ("id", "communityId", "title", "type", "permissions") VALUES ($1, $2, $3, 'PREDEFINED', '{}')`, [roleId, communityId, title]);
    }
    await s(`INSERT INTO roles_users_users ("roleId", "userId", "claimed") VALUES ($1, $2, TRUE), ($3, $4, TRUE)`, [R_MEMBER, MEMBER, R_OTHER_MEMBER, FOREIGN]);
    await s(`INSERT INTO callservers ("id", "status", "url") VALUES ($1, '{}', 'https://call.test')`, [CALL_SERVER]);
    for (const [callId, minutes] of [[CALL_PUBLIC, 5], [CALL_MEMBERS, 10]] as [string, number][]) {
      await s(`INSERT INTO calls ("id", "communityId", "channelId", "callCreator", "title", "stageSlots", "previewUserIds", "callServerId", "startedAt")
        VALUES ($1, $2, gen_random_uuid(), $3, 't', 0, '{}', $4, now() - ($5 || ' minutes')::interval)`, [callId, COMMUNITY, MEMBER, CALL_SERVER, String(minutes)]);
    }
    const permissions: [string, string, string][] = [
      [CALL_PUBLIC, R_ADMIN, '{CALL_EXISTS,CALL_JOIN,CALL_MODERATE}'], [CALL_PUBLIC, R_PUBLIC, '{CALL_EXISTS,CALL_JOIN}'],
      [CALL_MEMBERS, R_ADMIN, '{CALL_EXISTS,CALL_JOIN,CALL_MODERATE}'], [CALL_MEMBERS, R_MEMBER, '{CALL_EXISTS,CALL_JOIN}'],
    ];
    for (const [callId, roleId, perms] of permissions) {
      await s(`INSERT INTO callpermissions ("callId", "roleId", "permissions") VALUES ($1, $2, $3)`, [callId, roleId, perms]);
    }
    await s(`SET session_replication_role = origin`);
    seed.release();
  }, 600000);

  afterAll(async () => {
    await admin?.end();
    await server?.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server?.end();
  });

  const listed = async (userId: string | undefined) => (await callHelper.getHomepageCalls(userId, 0)).map(c => c.id).sort();

  it('a member sees the calls open to the Member role and to the Public role', async () => {
    expect(await listed(MEMBER)).toEqual([CALL_PUBLIC, CALL_MEMBERS].sort());
  });

  it('a non-member sees only the calls open to the Public role', async () => {
    expect(await listed(VISITOR)).toEqual([CALL_PUBLIC]);
    expect(await listed(FOREIGN)).toEqual([CALL_PUBLIC]);
  });

  it('a visitor without a session sees only the calls open to the Public role', async () => {
    expect(await listed(undefined)).toEqual([CALL_PUBLIC]);
  });
});
