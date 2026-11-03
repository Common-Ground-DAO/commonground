// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The extra delivery targets of a call's live events
 * (`callHelper.getActiveMemberUserIds`, `getCallEventExtraTargets`) against a
 * real, throwaway PostgreSQL (skipped unless CG_TEST_PG_HOST is set). The
 * test creates and drops its own database `cg_call_delivery_test` and the
 * cluster-wide role `writer` if missing — never point it at a server with
 * data. Host and port come only from CG_TEST_PG_HOST / CG_TEST_PG_PORT
 * (tests/helpers/testPg.ts).
 *
 * Schema: the columns the statements touch. The statements run as the api's
 * role `writer` on read-only sessions.
 */

import { Pool } from 'pg';
import { TEST_PG_HOST, TEST_PG_PORT, TEST_PG_PASSWORD, describeDb } from './helpers/testPg';

const HOST = TEST_PG_HOST;
const PORT = TEST_PG_PORT;
const PASSWORD = TEST_PG_PASSWORD;
const WRITER_PASSWORD = 'writer-test';
const DATABASE = 'cg_call_delivery_test';

let mockPoolTarget: Pool | undefined;
jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => (mockPoolTarget as any).query(...args) },
}));

import callHelper from '../repositories/calls';
import { CallPermission } from '../common/enums';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const COMMUNITY = id(0x100);
// calls
const CALL_PUBLIC = id(0x200);      // Public: EXISTS + JOIN, Member: CHANNEL_READ
const CALL_PUBLIC_READ = id(0x201); // Public: EXISTS + CHANNEL_READ
const CALL_PRIVATE = id(0x202);     // Member: EXISTS + CHANNEL_READ only
const CALL_DELETED_PUBLIC = id(0x203); // only a deleted Public role: EXISTS + CHANNEL_READ
const CALL_CUSTOM_PUBLIC = id(0x204);  // only a custom role titled "Public": EXISTS + CHANNEL_READ
const CALL_FOREIGN_PUBLIC = id(0x205); // only another community's Public role: EXISTS + CHANNEL_READ
const UNKNOWN_CALL = id(0x2ff);
const OTHER_COMMUNITY = id(0x101);
// roles
const R_PUBLIC = id(0x300);
const R_MEMBER = id(0x301);
const R_DELETED = id(0x302);        // claimed by DELROLE, full permissions, deleted
const R_PUBLIC_DELETED = id(0x303);
const R_CUSTOM_PUBLIC = id(0x304);
const R_OTHER_PUBLIC = id(0x305);
// users
const MEMBER = id(0x400);           // claimed Member, two open memberships
const VISITOR = id(0x401);          // no role: Public only
const UNCLAIMED = id(0x402);        // Member, not claimed
const DELROLE = id(0x403);          // only the deleted role
const LEFT = id(0x404);             // claimed Member, membership closed
const ELSEWHERE = id(0x405);        // claimed Member, in another call only

const CHAT = [CallPermission.CALL_EXISTS, CallPermission.CHANNEL_READ];

describeDb('call delivery targets on PostgreSQL', () => {
  let server: Pool;
  let admin: Pool;
  let writer: Pool;
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);

  beforeAll(async () => {
    server = new Pool({ host: HOST, port: PORT, user: 'postgres', password: PASSWORD, database: 'postgres', max: 2 });
    await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${DATABASE}`);
    await server.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'writer') THEN CREATE ROLE writer; END IF; END $$`);
    await server.query(`ALTER ROLE writer LOGIN PASSWORD '${WRITER_PASSWORD}'`);
    admin = new Pool({ host: HOST, port: PORT, user: 'postgres', password: PASSWORD, database: DATABASE });

    const permissionValues = Object.values(CallPermission).map(p => `'${p}'`).join(', ');
    await q(`CREATE TYPE "public"."callpermissions_permissions_enum" AS ENUM (${permissionValues})`);
    await q(`CREATE TABLE calls ("id" uuid PRIMARY KEY, "communityId" uuid NOT NULL)`);
    await q(`CREATE TYPE "public"."roles_type_enum" AS ENUM ('PREDEFINED', 'CUSTOM_MANUAL_ASSIGN', 'CUSTOM_AUTO_ASSIGN')`);
    await q(`CREATE TABLE roles ("id" uuid PRIMARY KEY, "communityId" uuid NOT NULL, "title" varchar(64) NOT NULL, "deletedAt" timestamptz, "type" "public"."roles_type_enum" NOT NULL DEFAULT 'PREDEFINED')`);
    await q(`CREATE TABLE roles_users_users ("roleId" uuid NOT NULL, "userId" uuid NOT NULL, "claimed" boolean NOT NULL DEFAULT false, PRIMARY KEY ("userId", "roleId"))`);
    await q(`CREATE TABLE callpermissions ("callId" uuid NOT NULL, "roleId" uuid NOT NULL, "permissions" "public"."callpermissions_permissions_enum"[] NOT NULL, PRIMARY KEY ("callId", "roleId"))`);
    await q(`CREATE TABLE callmembers ("id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "callId" uuid NOT NULL, "userId" uuid NOT NULL, "leftAt" timestamptz)`);
    await q(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO writer`);

    writer = new Pool({
      host: HOST, port: PORT, user: 'writer', password: WRITER_PASSWORD, database: DATABASE,
      options: '-c default_transaction_read_only=on',
    });
    for (const pool of [server, admin, writer]) {
      pool.on('error', () => undefined);
    }
    mockPoolTarget = writer;

    await q(`INSERT INTO calls VALUES ($1, $5), ($2, $5), ($3, $5), ($4, $5)`,
      [CALL_PUBLIC, CALL_PUBLIC_READ, CALL_PRIVATE, CALL_DELETED_PUBLIC, COMMUNITY]);
    await q(`INSERT INTO roles VALUES ($1, $5, 'Public', NULL), ($2, $5, 'Member', NULL), ($3, $5, 'Old', now()), ($4, $5, 'Public', now())`,
      [R_PUBLIC, R_MEMBER, R_DELETED, R_PUBLIC_DELETED, COMMUNITY]);
    await q(`INSERT INTO calls VALUES ($1, $3), ($2, $3)`, [CALL_CUSTOM_PUBLIC, CALL_FOREIGN_PUBLIC, COMMUNITY]);
    await q(`INSERT INTO roles VALUES ($1, $3, 'Public', NULL, 'CUSTOM_MANUAL_ASSIGN'), ($2, $4, 'Public', NULL, 'PREDEFINED')`,
      [R_CUSTOM_PUBLIC, R_OTHER_PUBLIC, COMMUNITY, OTHER_COMMUNITY]);
    await q(`INSERT INTO roles_users_users VALUES ($1, $3, true), ($1, $4, false), ($2, $5, true), ($1, $6, true), ($1, $7, true)`,
      [R_MEMBER, R_DELETED, MEMBER, UNCLAIMED, DELROLE, LEFT, ELSEWHERE]);
    const permissions: [string, string, string][] = [
      [CALL_PUBLIC, R_PUBLIC, '{CALL_EXISTS,CALL_JOIN}'],
      [CALL_PUBLIC, R_MEMBER, '{CHANNEL_READ}'],
      [CALL_PUBLIC, R_DELETED, '{CALL_EXISTS,CALL_JOIN,CHANNEL_READ}'],
      [CALL_PUBLIC_READ, R_PUBLIC, '{CALL_EXISTS,CALL_JOIN,CHANNEL_READ}'],
      [CALL_PRIVATE, R_MEMBER, '{CALL_EXISTS,CALL_JOIN,CHANNEL_READ}'],
      [CALL_DELETED_PUBLIC, R_PUBLIC_DELETED, '{CALL_EXISTS,CHANNEL_READ}'],
      [CALL_CUSTOM_PUBLIC, R_CUSTOM_PUBLIC, '{CALL_EXISTS,CHANNEL_READ}'],
      [CALL_FOREIGN_PUBLIC, R_OTHER_PUBLIC, '{CALL_EXISTS,CHANNEL_READ}'],
    ];
    for (const [callId, roleId, perms] of permissions) {
      await q(`INSERT INTO callpermissions VALUES ($1, $2, $3)`, [callId, roleId, perms]);
    }
    const memberships: [string, string, boolean][] = [];
    for (const callId of [CALL_PUBLIC, CALL_PUBLIC_READ, CALL_PRIVATE, CALL_DELETED_PUBLIC, CALL_CUSTOM_PUBLIC, CALL_FOREIGN_PUBLIC]) {
      memberships.push(
        [callId, MEMBER, false], [callId, MEMBER, false], // a second open membership (rejoin)
        [callId, VISITOR, false], [callId, UNCLAIMED, false], [callId, DELROLE, false],
        [callId, LEFT, true],
      );
    }
    memberships.push([id(0x2fe), ELSEWHERE, false]);
    for (const [callId, userId, left] of memberships) {
      await q(`INSERT INTO callmembers ("callId", "userId", "leftAt") VALUES ($1, $2, $3)`, [callId, userId, left ? new Date() : null]);
    }
  }, 60000);

  afterAll(async () => {
    await writer?.end();
    await admin?.end();
    await server?.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server?.end();
  });

  const sorted = (ids: string[]) => [...ids].sort();

  describe('getActiveMemberUserIds (call chat: CALL_EXISTS + CHANNEL_READ)', () => {
    it('union of a claimed role and Public; left, unclaimed and deleted-role users are out; each user once', async () => {
      // MEMBER: EXISTS from Public + READ from the claimed Member role
      expect(await callHelper.getActiveMemberUserIds(CALL_PUBLIC, CHAT)).toEqual([MEMBER]);
    });

    it('Public alone may read: every present user', async () => {
      expect(sorted(await callHelper.getActiveMemberUserIds(CALL_PUBLIC_READ, CHAT)))
        .toEqual(sorted([MEMBER, VISITOR, UNCLAIMED, DELROLE]));
    });

    it('a private call: only the claimed role holders', async () => {
      expect(await callHelper.getActiveMemberUserIds(CALL_PRIVATE, CHAT)).toEqual([MEMBER]);
    });

    it('a deleted Public role grants nothing', async () => {
      expect(await callHelper.getActiveMemberUserIds(CALL_DELETED_PUBLIC, CHAT)).toEqual([]);
    });

    it('a custom role titled "Public" and another community\'s Public role grant nothing', async () => {
      expect(await callHelper.getActiveMemberUserIds(CALL_CUSTOM_PUBLIC, CHAT)).toEqual([]);
      expect(await callHelper.getActiveMemberUserIds(CALL_FOREIGN_PUBLIC, CHAT)).toEqual([]);
    });

    it('CALL_EXISTS alone through Public: every present user of that call, none of another call', async () => {
      expect(sorted(await callHelper.getActiveMemberUserIds(CALL_PUBLIC, [CallPermission.CALL_EXISTS])))
        .toEqual(sorted([MEMBER, VISITOR, UNCLAIMED, DELROLE]));
    });

    it('an unknown call has no members', async () => {
      expect(await callHelper.getActiveMemberUserIds(UNKNOWN_CALL, CHAT)).toEqual([]);
    });
  });

  describe('getCallEventExtraTargets (cliCallEvent new: CALL_EXISTS)', () => {
    it('a call Public may see: the present users who may see it and the community', async () => {
      const targets = await callHelper.getCallEventExtraTargets(CALL_PUBLIC);
      expect(sorted(targets.activeMemberUserIds)).toEqual(sorted([MEMBER, VISITOR, UNCLAIMED, DELROLE]));
      expect(targets.publicCommunityId).toBe(COMMUNITY);
    });

    it('a private call: claimed role holders, no community', async () => {
      expect(await callHelper.getCallEventExtraTargets(CALL_PRIVATE))
        .toEqual({ activeMemberUserIds: [MEMBER], publicCommunityId: null });
    });

    it('a deleted Public role: no community, no members', async () => {
      expect(await callHelper.getCallEventExtraTargets(CALL_DELETED_PUBLIC))
        .toEqual({ activeMemberUserIds: [], publicCommunityId: null });
    });

    it('a custom role titled "Public" or another community\'s Public role: no community, no members', async () => {
      expect(await callHelper.getCallEventExtraTargets(CALL_CUSTOM_PUBLIC))
        .toEqual({ activeMemberUserIds: [], publicCommunityId: null });
      expect(await callHelper.getCallEventExtraTargets(CALL_FOREIGN_PUBLIC))
        .toEqual({ activeMemberUserIds: [], publicCommunityId: null });
    });

    it('an unknown call: no targets', async () => {
      expect(await callHelper.getCallEventExtraTargets(UNKNOWN_CALL))
        .toEqual({ activeMemberUserIds: [], publicCommunityId: null });
    });
  });
});
