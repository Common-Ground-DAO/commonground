// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Who may send which media into a call (`callHelper.hasPermissionToSendMedia`,
 * checked by the call server on `produce`) and who may moderate it
 * (`callHelper.hasPermissionToModerateCall`), against a real, throwaway
 * PostgreSQL (skipped unless CG_TEST_PG_HOST is set). The test creates and
 * drops its own database `cg_call_media_test` and the cluster-wide role
 * `mediasoup` if missing — never point it at a server with data. Host and
 * port come only from CG_TEST_PG_HOST / CG_TEST_PG_PORT
 * (tests/helpers/testPg.ts).
 *
 * Schema: the columns the statements touch. They run as the call server's
 * role `mediasoup` on a read-only session, with the table rights the
 * addMediasoup* / addCallPermissions / MediasoupCallJoinGrants migrations
 * give it.
 */

import { Pool } from 'pg';
import { TEST_PG_HOST, TEST_PG_PORT, TEST_PG_PASSWORD, describeDb } from './helpers/testPg';

const HOST = TEST_PG_HOST;
const PORT = TEST_PG_PORT;
const PASSWORD = TEST_PG_PASSWORD;
const MEDIASOUP_PASSWORD = 'mediasoup-test';
const DATABASE = 'cg_call_media_test';

let mockPoolTarget: Pool | undefined;
jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => (mockPoolTarget as any).query(...args) },
}));

import callHelper, { MEMBER_PERMISSIONS, MODERATOR_PERMISSIONS } from '../repositories/calls';
import { MediasoupCallJoinGrants1793635300000 as GrantsMigration } from '../migrations/1793635300000-mediasoupCallJoinGrants';
import { CallPermission, CommunityPermission } from '../common/enums';
import { MediaSendPermission } from '../mediasoup/mediaPermissions';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const COMMUNITY = id(0x100);
const OTHER_COMMUNITY = id(0x101);
const DELETED_COMMUNITY = id(0x102);
// calls (creator: CREATOR)
const CALL = id(0x200);           // Member: join + audio; Speaker: join + audio + video + share; Mod: the "moderate" preset (no SHARE_SCREEN)
const CALL_PUBLIC = id(0x201);    // Public: join + audio only
const CALL_CUSTOM = id(0x202);    // a custom role titled "Public": everything
const CALL_FOREIGN = id(0x203);   // the other community's roles: everything
const CALL_ENDED = id(0x204);     // as CALL, ended
const CALL_DELCOM = id(0x205);    // Member of the deleted community: everything
const CALL_BANNED_CREATOR = id(0x206); // created by BANNED_SPEAKER; Admin only
const CALL_PRESETS = id(0x207);  // the server's presets and the web client's "full" preset (creator: CREATOR)
const UNKNOWN_CALL = id(0x2ff);
// roles
const R_ADMIN = id(0x300);
const R_MEMBER = id(0x301);
const R_PUBLIC = id(0x302);
const R_SPEAKER = id(0x303);
const R_MOD = id(0x304);
const R_CUSTOM_PUBLIC = id(0x305);
const R_WEBRTC_MOD = id(0x306);   // community permission WEBRTC_MODERATE
const R_OTHER_PUBLIC = id(0x307);
const R_OTHER_MEMBER = id(0x308);
const R_OTHER_WEBRTC_MOD = id(0x309);
const R_DELCOM_MEMBER = id(0x30a);
const R_PRESET_MEMBER = id(0x30b);   // MEMBER_PERMISSIONS (a call without custom permissions)
const R_PRESET_MOD = id(0x30c);      // MODERATOR_PERMISSIONS
const R_CLIENT_FULL = id(0x30d);     // the web client's "full" preset
// users
const CREATOR = id(0x400);        // created the calls, claimed Member
const MEMBER = id(0x401);         // claimed Member
const SPEAKER = id(0x402);        // claimed Member + Speaker
const MOD = id(0x403);            // claimed Member + Mod
const WEBRTC_MOD = id(0x404);     // claimed Member + the WEBRTC_MODERATE role
const VISITOR = id(0x405);        // logged in, no role
const BANNED_SPEAKER = id(0x406); // banned, still holds Member + Speaker
const OTHER_MOD = id(0x407);      // WEBRTC_MODERATE and Member in the other community only
const UNCLAIMED = id(0x408);      // Speaker, not claimed
const BAN_OVER = id(0x409);       // claimed Speaker, a ban that has run out
const PRESET_MEMBER = id(0x40a);  // claimed R_PRESET_MEMBER
const PRESET_MOD = id(0x40b);     // claimed R_PRESET_MOD
const CLIENT_FULL = id(0x40c);    // claimed R_CLIENT_FULL
// what the call modal's "full" access grants a role (src/context/CallProvider.tsx, startCall)
const CLIENT_FULL_PRESET = ['CALL_EXISTS', 'CALL_JOIN', 'AUDIO_SEND', 'VIDEO_SEND', 'CHANNEL_READ', 'CHANNEL_WRITE', 'SHARE_SCREEN'];

const AUDIO = CallPermission.AUDIO_SEND;
const VIDEO = CallPermission.VIDEO_SEND;
const SHARE = CallPermission.SHARE_SCREEN;
const KINDS: MediaSendPermission[] = [AUDIO, VIDEO, SHARE];

describeDb('call media and moderation permissions on PostgreSQL', () => {
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

    const callPermissionValues = Object.values(CallPermission).map(p => `'${p}'`).join(', ');
    const communityPermissionValues = Object.values(CommunityPermission).map(p => `'${p}'`).join(', ');
    await q(`CREATE TYPE "public"."callpermissions_permissions_enum" AS ENUM (${callPermissionValues})`);
    await q(`CREATE TYPE "public"."roles_permissions_enum" AS ENUM (${communityPermissionValues})`);
    await q(`CREATE TYPE "public"."roles_type_enum" AS ENUM ('PREDEFINED', 'CUSTOM_MANUAL_ASSIGN', 'CUSTOM_AUTO_ASSIGN')`);
    await q(`CREATE TYPE "public"."user_community_state_blockstate_enum" AS ENUM ('CHAT_MUTED', 'BANNED')`);
    await q(`CREATE TABLE communities ("id" uuid PRIMARY KEY, "deletedAt" timestamptz, "title" varchar(64))`);
    await q(`CREATE TABLE calls ("id" uuid PRIMARY KEY, "communityId" uuid NOT NULL, "endedAt" timestamptz, "callCreator" uuid NOT NULL)`);
    await q(`CREATE TABLE roles ("id" uuid PRIMARY KEY, "communityId" uuid NOT NULL, "title" varchar(64) NOT NULL, "type" "public"."roles_type_enum" NOT NULL, "deletedAt" timestamptz, "permissions" "public"."roles_permissions_enum"[] NOT NULL DEFAULT '{}')`);
    await q(`CREATE TABLE roles_users_users ("roleId" uuid NOT NULL, "userId" uuid NOT NULL, "claimed" boolean NOT NULL DEFAULT false, PRIMARY KEY ("userId", "roleId"))`);
    await q(`CREATE TABLE callpermissions ("callId" uuid NOT NULL, "roleId" uuid NOT NULL, "permissions" "public"."callpermissions_permissions_enum"[] NOT NULL, PRIMARY KEY ("callId", "roleId"))`);
    await q(`CREATE TABLE user_community_state ("userId" uuid NOT NULL, "communityId" uuid NOT NULL, "blockState" "public"."user_community_state_blockstate_enum", "blockStateUntil" timestamptz, "notifyMentions" boolean NOT NULL DEFAULT true, PRIMARY KEY ("userId", "communityId"))`);
    await q(`GRANT SELECT ON calls, callpermissions, roles, roles_users_users TO mediasoup`);
    await new GrantsMigration().up({ query: (sql: string, params?: unknown[]) => q(sql, params) } as any);

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
      [CALL, COMMUNITY, false],
      [CALL_PUBLIC, COMMUNITY, false],
      [CALL_CUSTOM, COMMUNITY, false],
      [CALL_FOREIGN, COMMUNITY, false],
      [CALL_ENDED, COMMUNITY, true],
      [CALL_DELCOM, DELETED_COMMUNITY, false],
    ];
    for (const [callId, communityId, ended] of calls) {
      await q(`INSERT INTO calls VALUES ($1, $2, $3, $4)`, [callId, communityId, ended ? new Date() : null, CREATOR]);
    }
    await q(`INSERT INTO calls VALUES ($1, $2, NULL, $3), ($4, $2, NULL, $5)`, [CALL_BANNED_CREATOR, COMMUNITY, BANNED_SPEAKER, CALL_PRESETS, CREATOR]);
    const roles: [string, string, string, string, string][] = [
      [R_ADMIN, COMMUNITY, 'Admin', 'PREDEFINED', '{}'],
      [R_MEMBER, COMMUNITY, 'Member', 'PREDEFINED', '{}'],
      [R_PUBLIC, COMMUNITY, 'Public', 'PREDEFINED', '{}'],
      [R_SPEAKER, COMMUNITY, 'Speaker', 'CUSTOM_MANUAL_ASSIGN', '{}'],
      [R_MOD, COMMUNITY, 'Mod', 'CUSTOM_MANUAL_ASSIGN', '{}'],
      [R_CUSTOM_PUBLIC, COMMUNITY, 'Public', 'CUSTOM_MANUAL_ASSIGN', '{}'],
      [R_WEBRTC_MOD, COMMUNITY, 'Call mods', 'CUSTOM_MANUAL_ASSIGN', '{WEBRTC_MODERATE}'],
      [R_OTHER_PUBLIC, OTHER_COMMUNITY, 'Public', 'PREDEFINED', '{}'],
      [R_OTHER_MEMBER, OTHER_COMMUNITY, 'Member', 'PREDEFINED', '{}'],
      [R_OTHER_WEBRTC_MOD, OTHER_COMMUNITY, 'Call mods', 'CUSTOM_MANUAL_ASSIGN', '{WEBRTC_MODERATE}'],
      [R_DELCOM_MEMBER, DELETED_COMMUNITY, 'Member', 'PREDEFINED', '{}'],
      [R_PRESET_MEMBER, COMMUNITY, 'Preset member', 'CUSTOM_MANUAL_ASSIGN', '{}'],
      [R_PRESET_MOD, COMMUNITY, 'Preset mod', 'CUSTOM_MANUAL_ASSIGN', '{}'],
      [R_CLIENT_FULL, COMMUNITY, 'Client full', 'CUSTOM_MANUAL_ASSIGN', '{}'],
    ];
    for (const [roleId, communityId, title, type, permissions] of roles) {
      await q(`INSERT INTO roles VALUES ($1, $2, $3, $4, NULL, $5)`, [roleId, communityId, title, type, permissions]);
    }
    const claims: [string, string, boolean][] = [
      [R_MEMBER, CREATOR, true],
      [R_MEMBER, MEMBER, true], [R_DELCOM_MEMBER, MEMBER, true],
      [R_MEMBER, SPEAKER, true], [R_SPEAKER, SPEAKER, true],
      [R_MEMBER, MOD, true], [R_MOD, MOD, true],
      [R_MEMBER, WEBRTC_MOD, true], [R_WEBRTC_MOD, WEBRTC_MOD, true],
      [R_MEMBER, BANNED_SPEAKER, true], [R_SPEAKER, BANNED_SPEAKER, true],
      [R_OTHER_WEBRTC_MOD, OTHER_MOD, true], [R_OTHER_MEMBER, OTHER_MOD, true],
      [R_SPEAKER, UNCLAIMED, false],
      [R_SPEAKER, BAN_OVER, true],
      [R_PRESET_MEMBER, PRESET_MEMBER, true],
      [R_PRESET_MOD, PRESET_MOD, true],
      [R_CLIENT_FULL, CLIENT_FULL, true],
    ];
    for (const [roleId, userId, claimed] of claims) {
      await q(`INSERT INTO roles_users_users VALUES ($1, $2, $3)`, [roleId, userId, claimed]);
    }
    await q(`INSERT INTO user_community_state ("userId", "communityId", "blockState", "blockStateUntil") VALUES ($1, $3, 'BANNED', NULL), ($2, $3, 'BANNED', now() - interval '1 day')`,
      [BANNED_SPEAKER, BAN_OVER, COMMUNITY]);

    const JOIN_AUDIO = '{CALL_EXISTS,CALL_JOIN,CHANNEL_READ,CHANNEL_WRITE,AUDIO_SEND}';
    const FULL = '{CALL_EXISTS,CALL_JOIN,CHANNEL_READ,CHANNEL_WRITE,AUDIO_SEND,VIDEO_SEND,SHARE_SCREEN}';
    // the web client's "moderate" preset: no SHARE_SCREEN
    const MODERATE = '{CALL_EXISTS,CALL_JOIN,AUDIO_SEND,VIDEO_SEND,CHANNEL_READ,CHANNEL_WRITE,CALL_MODERATE,PIN_FOR_EVERYONE,END_CALL_FOR_EVERYONE}';
    const ADMIN = '{CALL_EXISTS,CALL_JOIN,CHANNEL_READ,CHANNEL_WRITE,AUDIO_SEND,VIDEO_SEND,SHARE_SCREEN,CALL_MODERATE,PIN_FOR_EVERYONE,END_CALL_FOR_EVERYONE}';
    const permissions: [string, string, string][] = [
      [CALL, R_ADMIN, ADMIN],
      [CALL, R_MEMBER, JOIN_AUDIO],
      [CALL, R_SPEAKER, FULL],
      [CALL, R_MOD, MODERATE],
      [CALL_PUBLIC, R_ADMIN, ADMIN],
      [CALL_PUBLIC, R_PUBLIC, JOIN_AUDIO],
      [CALL_CUSTOM, R_CUSTOM_PUBLIC, ADMIN],
      [CALL_FOREIGN, R_OTHER_PUBLIC, ADMIN],
      [CALL_FOREIGN, R_OTHER_MEMBER, ADMIN],
      [CALL_ENDED, R_SPEAKER, FULL],
      [CALL_DELCOM, R_DELCOM_MEMBER, FULL],
      [CALL_BANNED_CREATOR, R_ADMIN, ADMIN],
      [CALL_PRESETS, R_PRESET_MEMBER, `{${MEMBER_PERMISSIONS.join(',')}}`],
      [CALL_PRESETS, R_PRESET_MOD, `{${MODERATOR_PERMISSIONS.join(',')}}`],
      [CALL_PRESETS, R_CLIENT_FULL, `{${CLIENT_FULL_PRESET.join(',')}}`],
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

  const maySend = (userId: string, callId: string, permission: MediaSendPermission, onStage = false) =>
    callHelper.hasPermissionToSendMedia(userId, callId, permission, onStage);
  const mayModerate = (userId: string, callId: string) => callHelper.hasPermissionToModerateCall(userId, callId);

  describe('hasPermissionToSendMedia', () => {
    it('each kind needs its own permission through a claimed role', async () => {
      expect(await maySend(MEMBER, CALL, AUDIO)).toBe(true);
      expect(await maySend(MEMBER, CALL, VIDEO)).toBe(false);
      expect(await maySend(MEMBER, CALL, SHARE)).toBe(false);
      expect(await maySend(SPEAKER, CALL, AUDIO)).toBe(true);
      expect(await maySend(SPEAKER, CALL, VIDEO)).toBe(true);
      expect(await maySend(SPEAKER, CALL, SHARE)).toBe(true);
    });

    it('a user without a role, or with an unclaimed one, sends nothing into a call not open to Public', async () => {
      for (const kind of KINDS) {
        expect(await maySend(VISITOR, CALL, kind)).toBe(false);
        expect(await maySend(UNCLAIMED, CALL, kind)).toBe(false);
      }
    });

    it('the predefined Public role of the call\'s community grants what it holds, to everyone', async () => {
      expect(await maySend(VISITOR, CALL_PUBLIC, AUDIO)).toBe(true);
      expect(await maySend(MEMBER, CALL_PUBLIC, AUDIO)).toBe(true);
      expect(await maySend(VISITOR, CALL_PUBLIC, VIDEO)).toBe(false);
      expect(await maySend(VISITOR, CALL_PUBLIC, SHARE)).toBe(false);
    });

    it('a custom role titled "Public" and the roles of another community grant nothing', async () => {
      for (const kind of KINDS) {
        expect(await maySend(VISITOR, CALL_CUSTOM, kind)).toBe(false);
        expect(await maySend(MEMBER, CALL_CUSTOM, kind)).toBe(false);
        expect(await maySend(VISITOR, CALL_FOREIGN, kind)).toBe(false);
        expect(await maySend(OTHER_MOD, CALL_FOREIGN, kind)).toBe(false);
      }
    });

    it('the call creator and the call\'s moderators send every kind', async () => {
      for (const kind of KINDS) {
        expect(await maySend(CREATOR, CALL, kind)).toBe(true);
        expect(await maySend(CREATOR, CALL_FOREIGN, kind)).toBe(true);
        // CALL_MODERATE without SHARE_SCREEN (the "moderate" preset)
        expect(await maySend(MOD, CALL, kind)).toBe(true);
        // WEBRTC_MODERATE on a claimed role of the call's community
        expect(await maySend(WEBRTC_MOD, CALL, kind)).toBe(true);
      }
    });

    it('WEBRTC_MODERATE in another community does not count', async () => {
      expect(await maySend(OTHER_MOD, CALL, VIDEO)).toBe(false);
      expect(await maySend(OTHER_MOD, CALL, AUDIO)).toBe(false);
    });

    it('a banned user sends nothing, even with claimed roles or on the stage; a ban that ran out does not stop it', async () => {
      for (const kind of KINDS) {
        expect(await maySend(BANNED_SPEAKER, CALL, kind)).toBe(false);
        expect(await maySend(BANNED_SPEAKER, CALL_PUBLIC, kind, true)).toBe(false);
        expect(await maySend(BAN_OVER, CALL, kind)).toBe(true);
      }
    });

    it('the server\'s presets and the web client\'s "full" preset allow every kind', async () => {
      for (const kind of KINDS) {
        expect(await maySend(PRESET_MEMBER, CALL_PRESETS, kind)).toBe(true);
        expect(await maySend(PRESET_MOD, CALL_PRESETS, kind)).toBe(true);
        expect(await maySend(CLIENT_FULL, CALL_PRESETS, kind)).toBe(true);
      }
    });

    it('a banned call creator sends nothing', async () => {
      for (const kind of KINDS) {
        expect(await maySend(BANNED_SPEAKER, CALL_BANNED_CREATOR, kind)).toBe(false);
      }
    });

    it('on a broadcast stage the roles are not asked', async () => {
      expect(await maySend(VISITOR, CALL, VIDEO, true)).toBe(true);
      expect(await maySend(MEMBER, CALL, SHARE, true)).toBe(true);
    });

    it('an ended call, a call of a deleted community and an unknown call take no media', async () => {
      expect(await maySend(SPEAKER, CALL_ENDED, AUDIO)).toBe(false);
      expect(await maySend(CREATOR, CALL_ENDED, AUDIO)).toBe(false);
      expect(await maySend(MEMBER, CALL_DELCOM, AUDIO)).toBe(false);
      expect(await maySend(MEMBER, CALL_DELCOM, AUDIO, true)).toBe(false);
      expect(await maySend(MEMBER, UNKNOWN_CALL, AUDIO)).toBe(false);
    });
  });

  describe('hasPermissionToModerateCall', () => {
    it('CALL_MODERATE on the call or WEBRTC_MODERATE, through a claimed role of the call\'s community', async () => {
      expect(await mayModerate(MOD, CALL)).toBe(true);
      expect(await mayModerate(WEBRTC_MOD, CALL)).toBe(true);
      expect(await mayModerate(SPEAKER, CALL)).toBe(false);
      expect(await mayModerate(VISITOR, CALL)).toBe(false);
    });

    it('roles of another community, a custom role titled "Public" and Public itself do not moderate', async () => {
      expect(await mayModerate(OTHER_MOD, CALL)).toBe(false);
      expect(await mayModerate(OTHER_MOD, CALL_FOREIGN)).toBe(false);
      expect(await mayModerate(VISITOR, CALL_CUSTOM)).toBe(false);
      expect(await mayModerate(VISITOR, CALL_PUBLIC)).toBe(false);
    });

    it('the call creator moderates without a role on the call, unless banned', async () => {
      expect(await mayModerate(CREATOR, CALL)).toBe(true);
      expect(await mayModerate(CREATOR, CALL_FOREIGN)).toBe(true);
      expect(await mayModerate(BANNED_SPEAKER, CALL_BANNED_CREATOR)).toBe(false);
    });

    it('a banned user does not moderate', async () => {
      await q(`INSERT INTO roles_users_users VALUES ($1, $2, true)`, [R_MOD, BANNED_SPEAKER]);
      try {
        expect(await mayModerate(BANNED_SPEAKER, CALL)).toBe(false);
      } finally {
        await q(`DELETE FROM roles_users_users WHERE "roleId" = $1 AND "userId" = $2`, [R_MOD, BANNED_SPEAKER]);
      }
    });
  });
});
