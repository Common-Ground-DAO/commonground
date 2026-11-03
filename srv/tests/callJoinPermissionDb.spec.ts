// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Who may join a call's room (`callHelper.hasPermissionToJoinCall`, used by
 * the call server before it creates a peer and on `join`) against a real,
 * throwaway PostgreSQL (skipped unless CG_TEST_PG_HOST is set). The test
 * creates and drops its own database `cg_call_join_test` and the
 * cluster-wide role `mediasoup` if missing — never point it at a server with
 * data. Host and port come only from CG_TEST_PG_HOST / CG_TEST_PG_PORT
 * (tests/helpers/testPg.ts).
 *
 * Schema: the columns the statement touches. It runs as the call server's
 * role `mediasoup` on a read-only session, with the table rights the
 * addMediasoup* / addCallPermissions migrations give it plus the
 * MediasoupCallJoinGrants migration (run here, up/down/up).
 */

import { Pool } from 'pg';
import { TEST_PG_HOST, TEST_PG_PORT, TEST_PG_PASSWORD, describeDb } from './helpers/testPg';

const HOST = TEST_PG_HOST;
const PORT = TEST_PG_PORT;
const PASSWORD = TEST_PG_PASSWORD;
const MEDIASOUP_PASSWORD = 'mediasoup-test';
const DATABASE = 'cg_call_join_test';

let mockPoolTarget: Pool | undefined;
jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => (mockPoolTarget as any).query(...args) },
}));

import callHelper from '../repositories/calls';
import { MediasoupCallJoinGrants1793635300000 as GrantsMigration } from '../migrations/1793635300000-mediasoupCallJoinGrants';
import { CallPermission } from '../common/enums';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const COMMUNITY = id(0x100);
const OTHER_COMMUNITY = id(0x101);
const DELETED_COMMUNITY = id(0x102);
// calls
const CALL_PUBLIC = id(0x200);          // Public: EXISTS + JOIN (+ the Admin role)
const CALL_MEMBER = id(0x201);          // Member: EXISTS + JOIN (a call without custom permissions)
const CALL_PUBLIC_SEE_ONLY = id(0x202); // Public: EXISTS + CHANNEL_READ, no JOIN
const CALL_PUBLIC_ENDED = id(0x203);    // as CALL_PUBLIC, ended
const CALL_MEMBER_ENDED = id(0x204);    // as CALL_MEMBER, ended
const CALL_PUBLIC_DELCOM = id(0x205);   // as CALL_PUBLIC, in the deleted community
const CALL_MEMBER_DELCOM = id(0x206);   // as CALL_MEMBER, in the deleted community
const CALL_PUBLIC_DELROLE = id(0x207);  // only a deleted Public role: EXISTS + JOIN
const CALL_FOREIGN_PUBLIC = id(0x208);  // only the other community's Public role: EXISTS + JOIN
const CALL_CUSTOM_PUBLIC = id(0x209);   // only a custom role titled "Public": EXISTS + JOIN
const UNKNOWN_CALL = id(0x2ff);
// roles
const R_ADMIN = id(0x300);
const R_MEMBER = id(0x301);
const R_PUBLIC = id(0x302);
const R_PUBLIC_DELETED = id(0x303);
const R_OTHER_PUBLIC = id(0x304);
const R_CUSTOM_PUBLIC = id(0x305);
const R_DELCOM_MEMBER = id(0x306);
const R_DELCOM_PUBLIC = id(0x307);
// users
const ADMIN = id(0x400);      // claimed Admin
const MEMBER = id(0x401);     // claimed Member (also of the deleted community)
const VISITOR = id(0x402);    // logged in, no role in the community
const UNCLAIMED = id(0x403);  // Member, not claimed
const BANNED = id(0x404);     // banned (no roles left), ban without end
const BAN_OVER = id(0x405);   // a ban that has run out
const MUTED = id(0x406);      // chat-muted, no roles

describeDb('call join permission on PostgreSQL', () => {
  let server: Pool;
  let admin: Pool;
  let callServer: Pool;
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);

  beforeAll(async () => {
    server = new Pool({ host: HOST, port: PORT, user: 'postgres', password: PASSWORD, database: 'postgres', max: 2 });
    await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${DATABASE}`);
    await server.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mediasoup') THEN CREATE ROLE mediasoup; END IF; END $$`);
    await server.query(`ALTER ROLE mediasoup LOGIN PASSWORD '${MEDIASOUP_PASSWORD}'`);
    admin = new Pool({ host: HOST, port: PORT, user: 'postgres', password: PASSWORD, database: DATABASE });

    const permissionValues = Object.values(CallPermission).map(p => `'${p}'`).join(', ');
    await q(`CREATE TYPE "public"."callpermissions_permissions_enum" AS ENUM (${permissionValues})`);
    await q(`CREATE TYPE "public"."roles_type_enum" AS ENUM ('PREDEFINED', 'CUSTOM_MANUAL_ASSIGN', 'CUSTOM_AUTO_ASSIGN')`);
    await q(`CREATE TYPE "public"."user_community_state_blockstate_enum" AS ENUM ('CHAT_MUTED', 'BANNED')`);
    await q(`CREATE TABLE communities ("id" uuid PRIMARY KEY, "deletedAt" timestamptz, "title" varchar(64))`);
    await q(`CREATE TABLE calls ("id" uuid PRIMARY KEY, "communityId" uuid NOT NULL, "endedAt" timestamptz)`);
    await q(`CREATE TABLE roles ("id" uuid PRIMARY KEY, "communityId" uuid NOT NULL, "title" varchar(64) NOT NULL, "type" "public"."roles_type_enum" NOT NULL, "deletedAt" timestamptz)`);
    await q(`CREATE TABLE roles_users_users ("roleId" uuid NOT NULL, "userId" uuid NOT NULL, "claimed" boolean NOT NULL DEFAULT false, PRIMARY KEY ("userId", "roleId"))`);
    await q(`CREATE TABLE callpermissions ("callId" uuid NOT NULL, "roleId" uuid NOT NULL, "permissions" "public"."callpermissions_permissions_enum"[] NOT NULL, PRIMARY KEY ("callId", "roleId"))`);
    await q(`CREATE TABLE user_community_state ("userId" uuid NOT NULL, "communityId" uuid NOT NULL, "blockState" "public"."user_community_state_blockstate_enum", "blockStateUntil" timestamptz, "notifyMentions" boolean NOT NULL DEFAULT true, PRIMARY KEY ("userId", "communityId"))`);
    // what the call server's role had before (addMediasoup* and addCallPermissions migrations)
    await q(`GRANT SELECT ON calls, callpermissions, roles, roles_users_users TO mediasoup`);
    const runner = { query: (sql: string, params?: unknown[]) => q(sql, params) } as any;
    const migration = new GrantsMigration();
    await migration.up(runner);
    await migration.down(runner);
    await migration.up(runner);

    callServer = new Pool({
      host: HOST, port: PORT, user: 'mediasoup', password: MEDIASOUP_PASSWORD, database: DATABASE,
      options: '-c default_transaction_read_only=on',
    });
    for (const pool of [server, admin, callServer]) {
      pool.on('error', () => undefined);
    }
    mockPoolTarget = callServer;

    await q(`INSERT INTO communities ("id", "deletedAt") VALUES ($1, NULL), ($2, NULL), ($3, now())`, [COMMUNITY, OTHER_COMMUNITY, DELETED_COMMUNITY]);
    const calls: [string, string, boolean][] = [
      [CALL_PUBLIC, COMMUNITY, false],
      [CALL_MEMBER, COMMUNITY, false],
      [CALL_PUBLIC_SEE_ONLY, COMMUNITY, false],
      [CALL_PUBLIC_ENDED, COMMUNITY, true],
      [CALL_MEMBER_ENDED, COMMUNITY, true],
      [CALL_PUBLIC_DELCOM, DELETED_COMMUNITY, false],
      [CALL_MEMBER_DELCOM, DELETED_COMMUNITY, false],
      [CALL_PUBLIC_DELROLE, COMMUNITY, false],
      [CALL_FOREIGN_PUBLIC, COMMUNITY, false],
      [CALL_CUSTOM_PUBLIC, COMMUNITY, false],
    ];
    for (const [callId, communityId, ended] of calls) {
      await q(`INSERT INTO calls VALUES ($1, $2, $3)`, [callId, communityId, ended ? new Date() : null]);
    }
    const roles: [string, string, string, string, boolean][] = [
      [R_ADMIN, COMMUNITY, 'Admin', 'PREDEFINED', false],
      [R_MEMBER, COMMUNITY, 'Member', 'PREDEFINED', false],
      [R_PUBLIC, COMMUNITY, 'Public', 'PREDEFINED', false],
      [R_PUBLIC_DELETED, COMMUNITY, 'Public', 'PREDEFINED', true],
      [R_OTHER_PUBLIC, OTHER_COMMUNITY, 'Public', 'PREDEFINED', false],
      [R_CUSTOM_PUBLIC, COMMUNITY, 'Public', 'CUSTOM_MANUAL_ASSIGN', false],
      [R_DELCOM_MEMBER, DELETED_COMMUNITY, 'Member', 'PREDEFINED', false],
      [R_DELCOM_PUBLIC, DELETED_COMMUNITY, 'Public', 'PREDEFINED', false],
    ];
    for (const [roleId, communityId, title, type, deleted] of roles) {
      await q(`INSERT INTO roles VALUES ($1, $2, $3, $4, $5)`, [roleId, communityId, title, type, deleted ? new Date() : null]);
    }
    await q(`INSERT INTO roles_users_users VALUES ($1, $4, true), ($2, $5, true), ($3, $5, true), ($2, $6, false)`,
      [R_ADMIN, R_MEMBER, R_DELCOM_MEMBER, ADMIN, MEMBER, UNCLAIMED]);
    await q(`INSERT INTO user_community_state ("userId", "communityId", "blockState", "blockStateUntil") VALUES ($1, $4, 'BANNED', NULL), ($2, $4, 'BANNED', now() - interval '1 day'), ($3, $4, 'CHAT_MUTED', NULL)`,
      [BANNED, BAN_OVER, MUTED, COMMUNITY]);
    // a ban elsewhere does not matter
    await q(`INSERT INTO user_community_state ("userId", "communityId", "blockState", "blockStateUntil") VALUES ($1, $2, 'BANNED', NULL)`, [VISITOR, OTHER_COMMUNITY]);

    const JOIN = '{CALL_EXISTS,CALL_JOIN,CHANNEL_READ,CHANNEL_WRITE,AUDIO_SEND,VIDEO_SEND,SHARE_SCREEN}';
    const MODERATE = '{CALL_EXISTS,CALL_JOIN,CHANNEL_READ,CHANNEL_WRITE,AUDIO_SEND,VIDEO_SEND,SHARE_SCREEN,CALL_MODERATE,PIN_FOR_EVERYONE,END_CALL_FOR_EVERYONE}';
    const permissions: [string, string, string][] = [
      [CALL_PUBLIC, R_ADMIN, MODERATE],
      [CALL_PUBLIC, R_PUBLIC, JOIN],
      [CALL_MEMBER, R_ADMIN, MODERATE],
      [CALL_MEMBER, R_MEMBER, JOIN],
      [CALL_PUBLIC_SEE_ONLY, R_PUBLIC, '{CALL_EXISTS,CHANNEL_READ}'],
      [CALL_PUBLIC_ENDED, R_PUBLIC, JOIN],
      [CALL_MEMBER_ENDED, R_MEMBER, JOIN],
      [CALL_PUBLIC_DELCOM, R_DELCOM_PUBLIC, JOIN],
      [CALL_MEMBER_DELCOM, R_DELCOM_MEMBER, JOIN],
      [CALL_PUBLIC_DELROLE, R_PUBLIC_DELETED, JOIN],
      [CALL_FOREIGN_PUBLIC, R_OTHER_PUBLIC, JOIN],
      [CALL_CUSTOM_PUBLIC, R_CUSTOM_PUBLIC, JOIN],
    ];
    for (const [callId, roleId, perms] of permissions) {
      await q(`INSERT INTO callpermissions VALUES ($1, $2, $3)`, [callId, roleId, perms]);
    }
  }, 60000);

  afterAll(async () => {
    await callServer?.end();
    await admin?.end();
    await server?.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server?.end();
  });

  const mayJoin = (userId: string, callId: string) => callHelper.hasPermissionToJoinCall(userId, callId);

  describe('a call open to the Public role', () => {
    it('a member joins through the Public role alone', async () => {
      expect(await mayJoin(MEMBER, CALL_PUBLIC)).toBe(true);
    });

    it('a logged-in non-member joins (the Public role lets everyone see the call)', async () => {
      expect(await mayJoin(VISITOR, CALL_PUBLIC)).toBe(true);
      expect(await mayJoin(UNCLAIMED, CALL_PUBLIC)).toBe(true);
    });

    it('the admin joins through the claimed Admin role', async () => {
      expect(await mayJoin(ADMIN, CALL_PUBLIC)).toBe(true);
    });

    it('a user banned from the community does not; a ban that ran out or a chat mute does not stop it', async () => {
      expect(await mayJoin(BANNED, CALL_PUBLIC)).toBe(false);
      expect(await mayJoin(BAN_OVER, CALL_PUBLIC)).toBe(true);
      expect(await mayJoin(MUTED, CALL_PUBLIC)).toBe(true);
    });

    it('seeing the call without CALL_JOIN is not enough', async () => {
      expect(await mayJoin(MEMBER, CALL_PUBLIC_SEE_ONLY)).toBe(false);
      expect(await mayJoin(VISITOR, CALL_PUBLIC_SEE_ONLY)).toBe(false);
    });

    it('a deleted Public role, another community\'s Public role or a custom role titled "Public" grant nothing', async () => {
      for (const callId of [CALL_PUBLIC_DELROLE, CALL_FOREIGN_PUBLIC, CALL_CUSTOM_PUBLIC]) {
        expect(await mayJoin(MEMBER, callId)).toBe(false);
        expect(await mayJoin(VISITOR, callId)).toBe(false);
      }
    });
  });

  describe('a call open to the Member role (claimed roles, unchanged)', () => {
    it('a claimed member joins; non-members, unclaimed members and banned users do not', async () => {
      expect(await mayJoin(MEMBER, CALL_MEMBER)).toBe(true);
      expect(await mayJoin(ADMIN, CALL_MEMBER)).toBe(true);
      expect(await mayJoin(VISITOR, CALL_MEMBER)).toBe(false);
      expect(await mayJoin(UNCLAIMED, CALL_MEMBER)).toBe(false);
      expect(await mayJoin(BANNED, CALL_MEMBER)).toBe(false);
    });
  });

  it('the call server\'s role reads only the granted columns of communities and user_community_state', async () => {
    await expect(callServer.query(`SELECT "title" FROM communities`)).rejects.toThrow(/permission denied/);
    await expect(callServer.query(`SELECT "notifyMentions" FROM user_community_state`)).rejects.toThrow(/permission denied/);
  });

  describe('calls that are gone', () => {
    it('an ended call is refused, through the Public role and through a claimed role', async () => {
      expect(await mayJoin(MEMBER, CALL_PUBLIC_ENDED)).toBe(false);
      expect(await mayJoin(VISITOR, CALL_PUBLIC_ENDED)).toBe(false);
      expect(await mayJoin(MEMBER, CALL_MEMBER_ENDED)).toBe(false);
    });

    it('a call of a deleted community is refused', async () => {
      expect(await mayJoin(MEMBER, CALL_PUBLIC_DELCOM)).toBe(false);
      expect(await mayJoin(VISITOR, CALL_PUBLIC_DELCOM)).toBe(false);
      expect(await mayJoin(MEMBER, CALL_MEMBER_DELCOM)).toBe(false);
    });

    it('an unknown call is refused', async () => {
      expect(await mayJoin(MEMBER, UNKNOWN_CALL)).toBe(false);
    });
  });
});
