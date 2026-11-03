// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The data cleanup migration `1793635400000-permissionDataCleanup` against a
 * real, throwaway PostgreSQL (skipped unless CG_TEST_PG_HOST is set). The
 * test creates and drops its own database `cg_permission_cleanup_test` —
 * never point it at a server with data. Host and port come only from
 * CG_TEST_PG_HOST / CG_TEST_PG_PORT (tests/helpers/testPg.ts).
 *
 * Schema: the real one — the migration chain before this migration runs
 * first (tests/helpers/migratedDb.ts), so every constraint and trigger of
 * the touched tables is in place, `community_order_validation` on users
 * included. The data is seeded with session_replication_role = replica
 * (foreign keys and triggers off), as old rows may break the rules the
 * triggers enforce now (community orders out of step with the roles). The
 * migration then runs with all triggers, in a transaction on one client as
 * the migration runner does (mode "all"), twice: the second run changes
 * nothing.
 */

import { Pool, PoolClient } from 'pg';
import { TEST_PG_HOST, TEST_PG_PORT, TEST_PG_PASSWORD, describeDb } from './helpers/testPg';
import { createMigratedDatabase } from './helpers/migratedDb';
import { PermissionDataCleanup1793635400000 as CleanupMigration } from '../migrations/1793635400000-permissionDataCleanup';
import { CallPermission, CommunityEventPermission } from '../common/enums';

const DATABASE = 'cg_permission_cleanup_test';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

// communities
const C = id(0x100);         // the community of the calls, events and bans
const O = id(0x101);         // another community
const Z = id(0x102);         // a community whose member count is already 0
// roles of C
const C_ADMIN = id(0x200);
const C_MEMBER = id(0x201);
const C_PUBLIC = id(0x202);
const C_CUSTOM = id(0x203);
const C_GATED = id(0x204);   // custom, assigned unclaimed
const C_DELETED = id(0x205); // custom, deleted
// roles of O and Z
const O_ADMIN = id(0x210);
const O_MEMBER = id(0x211);
const O_PUBLIC = id(0x212);
const Z_MEMBER = id(0x220);
// a call and an event in C, one call in O
const CALL = id(0x300);
const O_CALL = id(0x301);
const EVENT = id(0x310);
const ARTICLE = id(0x320);
// users
const CREATOR = id(0x400);        // creator of C, claimed Admin, not banned
const MEMBER = id(0x401);         // claimed Member of C, no block state
const BANNED = id(0x402);         // banned from C without end; also a member of O
const BAN_TIMED = id(0x403);      // banned from C until tomorrow
const BAN_OVER = id(0x404);       // a ban from C that has run out
const MUTED = id(0x405);          // chat-muted in C
const BANNED_ADMIN = id(0x406);   // banned from C, holds C's claimed Admin role
const BANNED_CREATOR = id(0x407); // creator of O, banned from O, claimed Member of O
const BANNED_UNCLAIMED = id(0x408); // banned from C, only an unclaimed role of C
const BANNED_IN_O = id(0x409);    // member of C and O, banned from O only
const BANNED_Z = id(0x40a);       // banned from Z, claimed Member of Z
// bots
const BOT_OF_BANNED = id(0x500);     // user bot of BANNED, Member of C and O
const DELETED_BOT = id(0x501);       // deleted user bot of BANNED, Member of C
const COMMUNITY_BOT = id(0x502);     // community bot of C, Member of C
const BOT_OF_MEMBER = id(0x503);     // user bot of MEMBER, Member of C
const BOT_OF_BANNED_ADMIN = id(0x504); // user bot of BANNED_ADMIN, Member of C
// community orders out of step with the roles (the trigger would refuse them)
const STALE_USER = id(0x40b);     // banned from C; Member of C, O and Z; order [C, O, C, O] (Z missing, duplicates)
const STALE_BOT = id(0x505);      // user bot of BANNED; Member of C and Z; order [C] (Z missing)
const STALE_NOT_IN_ORDER = id(0x40c); // banned from C; Member of C and O; order [] (C is not in it)
// channels
const C_CHANNEL = id(0x600);
const O_CHANNEL = id(0x601);

describeDb('permission data cleanup migration on PostgreSQL', () => {
  let server: Pool;
  let admin: Pool;
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);
  let logs: string[] = [];

  /** runs `migration.up` in one transaction on one client, as the migration runner does */
  async function runUp(): Promise<{ lockTimeoutInside: string; lockTimeoutAfter: string }> {
    const client: PoolClient = await admin.connect();
    try {
      await client.query('BEGIN');
      await client.query(`SET LOCAL lock_timeout = '17s'`);
      // the triggers must fire (community_order_validation among them)
      expect((await client.query(`SELECT current_setting('session_replication_role') AS v`)).rows[0].v).toBe('origin');
      expect((await client.query(`SELECT count(*)::int AS n FROM pg_trigger WHERE tgname = 'community_order_validation' AND tgenabled = 'O'`)).rows[0].n).toBe(1);
      let lockTimeoutInside = '';
      const runner = {
        query: async (sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params);
          if (/^\s*WITH/.test(sql)) {
            lockTimeoutInside = (await client.query(`SELECT current_setting('lock_timeout') AS v`)).rows[0].v;
          }
          return result.rows;
        },
      } as any;
      await new CleanupMigration().up(runner);
      const lockTimeoutAfter = (await client.query(`SELECT current_setting('lock_timeout') AS v`)).rows[0].v;
      await client.query('COMMIT');
      return { lockTimeoutInside, lockTimeoutAfter };
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  /** everything the migration may change, in a stable order */
  async function snapshot() {
    const rows = async (sql: string) => (await q(sql)).rows;
    return {
      callpermissions: await rows(`SELECT "callId", "roleId" FROM callpermissions ORDER BY 1, 2`),
      eventPermissions: await rows(`SELECT "communityEventId", "roleId" FROM communities_events_permissions ORDER BY 1, 2`),
      channelPermissions: await rows(`SELECT "channelId", "roleId" FROM communities_channels_roles_permissions ORDER BY 1, 2`),
      articlePermissions: await rows(`SELECT "articleId", "roleId" FROM communities_articles_roles_permissions ORDER BY 1, 2`),
      roleAssignments: await rows(`SELECT "userId", "roleId", "claimed" FROM roles_users_users ORDER BY 1, 2`),
      communityOrders: await rows(`SELECT "id", "communityOrder" FROM users ORDER BY 1`),
      channelSettings: await rows(`SELECT "userId", "communityId", "channelId" FROM user_channel_settings ORDER BY 1, 2, 3`),
      states: await rows(`SELECT "userId", "communityId", "blockState", "blockStateUntil", "userLeftCommunity" FROM user_community_state ORDER BY 1, 2`),
      communities: await rows(`SELECT "id", "memberCount", "updatedAt" FROM communities ORDER BY 1`),
      roles: await rows(`SELECT "id", "title", "type", "deletedAt" FROM roles ORDER BY 1`),
    };
  }

  let before: Awaited<ReturnType<typeof snapshot>>;
  let afterFirst: Awaited<ReturnType<typeof snapshot>>;
  let afterSecond: Awaited<ReturnType<typeof snapshot>>;
  let firstLogs: string[];
  let secondLogs: string[];
  let firstLockTimeouts: { lockTimeoutInside: string; lockTimeoutAfter: string };

  beforeAll(async () => {
    server = new Pool({ host: TEST_PG_HOST, port: TEST_PG_PORT, user: 'postgres', password: TEST_PG_PASSWORD, database: 'postgres', max: 2 });
    await createMigratedDatabase(server, DATABASE, { before: 1793635400000 });
    admin = new Pool({ host: TEST_PG_HOST, port: TEST_PG_PORT, user: 'postgres', password: TEST_PG_PASSWORD, database: DATABASE });
    for (const pool of [server, admin]) {
      pool.on('error', () => undefined);
    }
    const seed = await admin.connect();
    await seed.query(`SET session_replication_role = replica`);
    const s = (sql: string, params?: unknown[]) => seed.query(sql, params);

    const users = [CREATOR, MEMBER, BANNED, BAN_TIMED, BAN_OVER, MUTED, BANNED_ADMIN, BANNED_CREATOR, BANNED_UNCLAIMED, BANNED_IN_O, BANNED_Z,
      STALE_USER, STALE_NOT_IN_ORDER];
    const bots = [BOT_OF_BANNED, DELETED_BOT, COMMUNITY_BOT, BOT_OF_MEMBER, BOT_OF_BANNED_ADMIN, STALE_BOT];
    for (const userId of users) {
      await s(`INSERT INTO users ("id", "displayAccount") VALUES ($1, 'cg')`, [userId]);
    }
    for (const userId of bots) {
      await s(`INSERT INTO users ("id", "displayAccount", "is_bot") VALUES ($1, 'bot', TRUE)`, [userId]);
    }
    // community orders; BANNED's holds Z without a Member role of it
    await s(`UPDATE users SET "communityOrder" = $2 WHERE id = $1`, [BANNED, [O, C, Z]]);
    await s(`UPDATE users SET "communityOrder" = $2 WHERE id = $1`, [BANNED_IN_O, [C, O]]);
    await s(`UPDATE users SET "communityOrder" = $2 WHERE id = $1`, [BOT_OF_BANNED, [C, O]]);
    await s(`UPDATE users SET "communityOrder" = $2 WHERE id = $1`, [BAN_OVER, [C]]);
    await s(`UPDATE users SET "communityOrder" = $2 WHERE id = $1`, [BANNED_ADMIN, [C]]);
    await s(`UPDATE users SET "communityOrder" = $2 WHERE id = $1`, [STALE_USER, [C, O, C, O]]);
    await s(`UPDATE users SET "communityOrder" = $2 WHERE id = $1`, [STALE_BOT, [C]]);

    const longAgo = '2020-01-01T00:00:00.000Z';
    for (const [communityId, creatorId, memberCount] of [[C, CREATOR, 20], [O, BANNED_CREATOR, 10], [Z, CREATOR, 0]] as [string, string, number][]) {
      await s(`INSERT INTO communities ("id", "title", "url", "description", "shortDescription", "links", "tags", "creatorId", "memberCount", "updatedAt")
        VALUES ($1, $5, $5, '', '', '[]', '{}', $2, $3, $4)`, [communityId, creatorId, memberCount, longAgo, `c-${communityId.slice(-4)}`]);
    }
    const roles: [string, string, string, string, boolean][] = [
      [C_ADMIN, C, 'Admin', 'PREDEFINED', false],
      [C_MEMBER, C, 'Member', 'PREDEFINED', false],
      [C_PUBLIC, C, 'Public', 'PREDEFINED', false],
      [C_CUSTOM, C, 'Moderators', 'CUSTOM_MANUAL_ASSIGN', false],
      [C_GATED, C, 'Holders', 'CUSTOM_AUTO_ASSIGN', false],
      [C_DELETED, C, 'Former', 'CUSTOM_MANUAL_ASSIGN', true],
      [O_ADMIN, O, 'Admin', 'PREDEFINED', false],
      [O_MEMBER, O, 'Member', 'PREDEFINED', false],
      [O_PUBLIC, O, 'Public', 'PREDEFINED', false],
      [Z_MEMBER, Z, 'Member', 'PREDEFINED', false],
    ];
    for (const [roleId, communityId, title, type, deleted] of roles) {
      await s(`INSERT INTO roles ("id", "communityId", "title", "type", "permissions", "deletedAt") VALUES ($1, $2, $3, $4, '{}', $5)`, [roleId, communityId, title, type, deleted ? longAgo : null]);
    }
    const assignments: [string, string, boolean][] = [
      [CREATOR, C_ADMIN, true], [CREATOR, C_MEMBER, true],
      [MEMBER, C_MEMBER, true], [MEMBER, C_CUSTOM, true],
      [BANNED, C_MEMBER, true], [BANNED, C_CUSTOM, true], [BANNED, C_GATED, false], [BANNED, C_DELETED, true], [BANNED, O_MEMBER, true],
      [BAN_TIMED, C_MEMBER, true],
      [BAN_OVER, C_MEMBER, true],
      [MUTED, C_MEMBER, true],
      [BANNED_ADMIN, C_ADMIN, true], [BANNED_ADMIN, C_MEMBER, true],
      [BANNED_CREATOR, O_MEMBER, true],
      [BANNED_UNCLAIMED, C_GATED, false],
      [BANNED_IN_O, C_MEMBER, true], [BANNED_IN_O, O_MEMBER, true],
      [BANNED_Z, Z_MEMBER, true],
      [BOT_OF_BANNED, C_MEMBER, true], [BOT_OF_BANNED, C_CUSTOM, true], [BOT_OF_BANNED, O_MEMBER, true],
      [DELETED_BOT, C_MEMBER, true],
      [COMMUNITY_BOT, C_MEMBER, true],
      [BOT_OF_MEMBER, C_MEMBER, true],
      [BOT_OF_BANNED_ADMIN, C_MEMBER, true],
      [STALE_USER, C_MEMBER, true], [STALE_USER, O_MEMBER, true], [STALE_USER, Z_MEMBER, true],
      [STALE_BOT, C_MEMBER, true], [STALE_BOT, Z_MEMBER, true],
      [STALE_NOT_IN_ORDER, C_MEMBER, true], [STALE_NOT_IN_ORDER, O_MEMBER, true],
    ];
    for (const [userId, roleId, claimed] of assignments) {
      await s(`INSERT INTO roles_users_users ("roleId", "userId", "claimed") VALUES ($1, $2, $3)`, [roleId, userId, claimed]);
    }
    const botRows: [string, string, string, string | null][] = [
      [BOT_OF_BANNED, 'user', BANNED, null], [DELETED_BOT, 'user', BANNED, longAgo], [COMMUNITY_BOT, 'community', C, null],
      [BOT_OF_MEMBER, 'user', MEMBER, null], [BOT_OF_BANNED_ADMIN, 'user', BANNED_ADMIN, null], [STALE_BOT, 'user', BANNED, null],
    ];
    for (const [userId, ownerType, ownerId, deletedAt] of botRows) {
      await s(`INSERT INTO bots ("userId", "ownerType", "ownerId", "deviceId", "deletedAt") VALUES ($1, $2, $3, gen_random_uuid(), $4)`, [userId, ownerType, ownerId, deletedAt]);
    }

    const states: [string, string, string | null, string | null][] = [
      [MEMBER, C, null, null],
      [BANNED, C, 'BANNED', null],
      [BANNED, O, null, null],
      [BAN_TIMED, C, 'BANNED', 'tomorrow'],
      [BAN_OVER, C, 'BANNED', 'yesterday'],
      [MUTED, C, 'CHAT_MUTED', null],
      [BANNED_ADMIN, C, 'BANNED', null],
      [BANNED_CREATOR, O, 'BANNED', null],
      [BANNED_UNCLAIMED, C, 'BANNED', null],
      [BANNED_IN_O, C, null, null],
      [BANNED_IN_O, O, 'BANNED', null],
      [BANNED_Z, Z, 'BANNED', null],
      [STALE_USER, C, 'BANNED', null],
      [STALE_NOT_IN_ORDER, C, 'BANNED', null],
    ];
    for (const [userId, communityId, blockState, until] of states) {
      const untilSql = until === 'tomorrow' ? `now() + interval '1 day'` : until === 'yesterday' ? `now() - interval '1 day'` : 'NULL';
      await s(`INSERT INTO user_community_state ("userId", "communityId", "blockState", "blockStateUntil") VALUES ($1, $2, $3, ${untilSql})`, [userId, communityId, blockState]);
    }
    for (const userId of [MEMBER, BANNED, BAN_TIMED, BOT_OF_BANNED, BAN_OVER, MUTED, BANNED_ADMIN]) {
      await s(`INSERT INTO user_channel_settings ("userId", "channelId", "communityId") VALUES ($1, $2, $3)`, [userId, C_CHANNEL, C]);
    }
    for (const userId of [BANNED, BOT_OF_BANNED, BANNED_IN_O]) {
      await s(`INSERT INTO user_channel_settings ("userId", "channelId", "communityId") VALUES ($1, $2, $3)`, [userId, O_CHANNEL, O]);
    }

    const MODERATE = `{${[CallPermission.CALL_EXISTS, CallPermission.CALL_JOIN, CallPermission.CALL_MODERATE].join(',')}}`;
    const JOIN = `{${[CallPermission.CALL_EXISTS, CallPermission.CALL_JOIN].join(',')}}`;
    for (const [callId, communityId] of [[CALL, C], [O_CALL, O]]) {
      await s(`INSERT INTO calls ("id", "communityId", "channelId", "callCreator", "title", "stageSlots", "previewUserIds") VALUES ($1, $2, gen_random_uuid(), $3, 't', 0, '{}')`, [callId, communityId, CREATOR]);
    }
    for (const [callId, roleId, perms] of [
      [CALL, C_ADMIN, MODERATE], [CALL, C_MEMBER, JOIN], [CALL, C_PUBLIC, JOIN], [CALL, C_CUSTOM, MODERATE],
      [CALL, C_DELETED, JOIN], [CALL, O_PUBLIC, JOIN], [CALL, O_MEMBER, JOIN],
      [O_CALL, O_ADMIN, MODERATE], [O_CALL, O_MEMBER, JOIN], [O_CALL, C_MEMBER, JOIN],
    ]) {
      await s(`INSERT INTO callpermissions ("callId", "roleId", "permissions") VALUES ($1, $2, $3)`, [callId, roleId, perms]);
    }
    const PREVIEW = `{${[CommunityEventPermission.EVENT_PREVIEW].join(',')}}`;
    await s(`INSERT INTO communities_events ("id", "communityId", "eventCreator", "title", "description", "scheduleDate", "type") VALUES ($1, $2, $3, 't', '{}', now(), 'external')`, [EVENT, C, CREATOR]);
    for (const roleId of [C_ADMIN, C_MEMBER, C_PUBLIC, C_CUSTOM, C_DELETED, O_PUBLIC, O_ADMIN]) {
      await s(`INSERT INTO communities_events_permissions ("communityEventId", "roleId", "permissions") VALUES ($1, $2, $3)`, [EVENT, roleId, PREVIEW]);
    }

    for (const [roleId, perms] of [[C_ADMIN, '{CHANNEL_EXISTS,CHANNEL_READ,CHANNEL_WRITE,CHANNEL_MODERATE}'], [C_MEMBER, '{CHANNEL_EXISTS,CHANNEL_READ}'],
      [O_MEMBER, '{CHANNEL_EXISTS,CHANNEL_READ}'], [C_DELETED, '{CHANNEL_EXISTS,CHANNEL_READ}']]) {
      await s(`INSERT INTO communities_channels_roles_permissions ("communityId", "channelId", "roleId", "permissions") VALUES ($1, $2, $3, $4)`, [C, C_CHANNEL, roleId, perms]);
    }
    for (const roleId of [C_ADMIN, C_PUBLIC, O_PUBLIC]) {
      await s(`INSERT INTO communities_articles_roles_permissions ("communityId", "articleId", "roleId", "permissions") VALUES ($1, $2, $3, '{ARTICLE_PREVIEW,ARTICLE_READ}')`, [C, ARTICLE, roleId]);
    }
    // back to the default, so the migration runs with every trigger
    await seed.query(`SET session_replication_role = origin`);
    seed.release();

    const log = jest.spyOn(console, 'log').mockImplementation((...args: unknown[]) => { logs.push(args.join(' ')); });
    before = await snapshot();
    firstLockTimeouts = await runUp();
    firstLogs = logs; logs = [];
    afterFirst = await snapshot();
    await new Promise(resolve => setTimeout(resolve, 20));
    await runUp();
    secondLogs = logs; logs = [];
    afterSecond = await snapshot();
    log.mockRestore();
  }, 600000);

  afterAll(async () => {
    await admin?.end();
    await server?.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server?.end();
  });

  const pairs = (rows: { [k: string]: unknown }[], a: string, b: string) => rows.map(r => `${r[a]}/${r[b]}`);
  const without = <T>(list: T[], removed: T[]) => list.filter(x => !removed.includes(x));

  it('removes the call permission rows of other communities\' roles and of deleted roles, and keeps the rest (the Admin row too)', () => {
    const removed = [`${CALL}/${C_DELETED}`, `${CALL}/${O_PUBLIC}`, `${CALL}/${O_MEMBER}`, `${O_CALL}/${C_MEMBER}`];
    expect(pairs(afterFirst.callpermissions, 'callId', 'roleId'))
      .toEqual(without(pairs(before.callpermissions, 'callId', 'roleId'), removed));
    expect(pairs(afterFirst.callpermissions, 'callId', 'roleId')).toEqual(expect.arrayContaining([
      `${CALL}/${C_ADMIN}`, `${CALL}/${C_MEMBER}`, `${CALL}/${C_PUBLIC}`, `${CALL}/${C_CUSTOM}`, `${O_CALL}/${O_ADMIN}`, `${O_CALL}/${O_MEMBER}`,
    ]));
  });

  it('removes the event permission rows of other communities\' roles and of deleted roles, and keeps the rest', () => {
    expect(pairs(afterFirst.eventPermissions, 'communityEventId', 'roleId'))
      .toEqual([C_ADMIN, C_MEMBER, C_PUBLIC, C_CUSTOM].map(r => `${EVENT}/${r}`));
  });

  it('removes the channel and article permission rows of other communities\' roles and of deleted roles, and keeps the rest', () => {
    expect(pairs(afterFirst.channelPermissions, 'channelId', 'roleId')).toEqual([C_ADMIN, C_MEMBER].map(r => `${C_CHANNEL}/${r}`));
    expect(pairs(afterFirst.articlePermissions, 'articleId', 'roleId')).toEqual([C_ADMIN, C_PUBLIC].map(r => `${ARTICLE}/${r}`));
  });

  it('removes every role assignment of an actively banned user in the community of the ban, and of the live user bots of that user', () => {
    const removed = [
      `${BANNED}/${C_MEMBER}`, `${BANNED}/${C_CUSTOM}`, `${BANNED}/${C_GATED}`, `${BANNED}/${C_DELETED}`,
      `${BAN_TIMED}/${C_MEMBER}`,
      `${BANNED_UNCLAIMED}/${C_GATED}`,
      `${BANNED_IN_O}/${O_MEMBER}`,
      `${BANNED_Z}/${Z_MEMBER}`,
      `${BOT_OF_BANNED}/${C_MEMBER}`, `${BOT_OF_BANNED}/${C_CUSTOM}`,
      `${STALE_USER}/${C_MEMBER}`, `${STALE_BOT}/${C_MEMBER}`, `${STALE_NOT_IN_ORDER}/${C_MEMBER}`,
    ];
    expect(pairs(afterFirst.roleAssignments, 'userId', 'roleId'))
      .toEqual(without(pairs(before.roleAssignments, 'userId', 'roleId'), removed));
  });

  it('keeps expired bans, chat mutes, other users, other communities of a banned user, banned Admins, banned creators and the bots that are not reconciled', () => {
    const kept = pairs(afterFirst.roleAssignments, 'userId', 'roleId');
    expect(kept).toEqual(expect.arrayContaining([
      `${BAN_OVER}/${C_MEMBER}`, `${MUTED}/${C_MEMBER}`, `${MEMBER}/${C_MEMBER}`, `${MEMBER}/${C_CUSTOM}`, `${CREATOR}/${C_ADMIN}`,
      `${BANNED}/${O_MEMBER}`, `${BANNED_IN_O}/${C_MEMBER}`, `${BOT_OF_BANNED}/${O_MEMBER}`,
      `${BANNED_ADMIN}/${C_ADMIN}`, `${BANNED_ADMIN}/${C_MEMBER}`, `${BOT_OF_BANNED_ADMIN}/${C_MEMBER}`,
      `${BANNED_CREATOR}/${O_MEMBER}`,
      `${DELETED_BOT}/${C_MEMBER}`, `${COMMUNITY_BOT}/${C_MEMBER}`, `${BOT_OF_MEMBER}/${C_MEMBER}`,
      `${STALE_USER}/${O_MEMBER}`, `${STALE_USER}/${Z_MEMBER}`, `${STALE_BOT}/${Z_MEMBER}`, `${STALE_NOT_IN_ORDER}/${O_MEMBER}`,
    ]));
  });

  it('updates the community orders, channel settings and community states of the removed memberships only', () => {
    const order = Object.fromEntries(afterFirst.communityOrders.map(r => [r.id, r.communityOrder]));
    // without the removed community, and matching the claimed Member roles
    // left (what community_order_validation requires): Z goes from BANNED's
    // order (no Member role of Z), the duplicates go, missing Member
    // communities are added at the end
    expect(order[BANNED]).toEqual([O]);
    expect(order[BANNED_IN_O]).toEqual([C]);
    expect(order[BOT_OF_BANNED]).toEqual([O]);
    expect(order[STALE_USER]).toEqual([O, Z]);
    expect(order[STALE_BOT]).toEqual([Z]);
    // not containing a removed community: not written
    expect(order[STALE_NOT_IN_ORDER]).toEqual([]);
    expect(order[BAN_OVER]).toEqual([C]);
    expect(order[BANNED_ADMIN]).toEqual([C]);

    expect(afterFirst.channelSettings.map(r => `${r.userId}/${r.communityId}`)).toEqual(without(
      before.channelSettings.map(r => `${r.userId}/${r.communityId}`),
      [`${BANNED}/${C}`, `${BAN_TIMED}/${C}`, `${BOT_OF_BANNED}/${C}`, `${BANNED_IN_O}/${O}`],
    ));

    const left = afterFirst.states.filter(s => s.userLeftCommunity !== null).map(s => `${s.userId}/${s.communityId}`);
    expect(left.sort()).toEqual([`${BANNED}/${C}`, `${BAN_TIMED}/${C}`, `${BANNED_UNCLAIMED}/${C}`, `${BANNED_IN_O}/${O}`, `${BANNED_Z}/${Z}`,
      `${STALE_USER}/${C}`, `${STALE_NOT_IN_ORDER}/${C}`].sort());
    // the block states themselves stay
    expect(afterFirst.states.map(s => [s.userId, s.communityId, s.blockState, String(s.blockStateUntil)]))
      .toEqual(before.states.map(s => [s.userId, s.communityId, s.blockState, String(s.blockStateUntil)]));
  });

  it('lowers the member count by the removed holders of the Member role, not below 0', () => {
    const count = Object.fromEntries(afterFirst.communities.map(r => [r.id, r.memberCount]));
    // C: BANNED, BAN_TIMED, BOT_OF_BANNED, STALE_USER, STALE_BOT and
    // STALE_NOT_IN_ORDER held Member; BANNED_UNCLAIMED did not
    expect(count[C]).toBe(14);
    expect(count[O]).toBe(9);
    expect(count[Z]).toBe(0);
    for (const row of afterFirst.communities) {
      expect(new Date(row.updatedAt).getTime()).toBeGreaterThan(new Date(before.communities.find(b => b.id === row.id)!.updatedAt).getTime());
    }
  });

  it('renames and deletes no role', () => {
    expect(afterFirst.roles).toEqual(before.roles);
  });

  it('logs the counts of each step', () => {
    expect(firstLogs).toEqual([
      expect.stringContaining('removed 4 callpermissions rows'),
      expect.stringContaining('removed 3 communities_events_permissions rows'),
      expect.stringContaining('removed 2 communities_channels_roles_permissions and 1 communities_articles_roles_permissions rows'),
      expect.stringMatching(/removed 13 role assignments of banned users \(9 memberships, 2 of them bots of banned owners; 5 community orders, 4 channel settings, 7 community states, 3 member counts updated\)/),
    ]);
  });

  it('sets lock_timeout for its statements only, transaction-locally', () => {
    expect(firstLockTimeouts).toEqual({ lockTimeoutInside: '5s', lockTimeoutAfter: '17s' });
  });

  it('a second run changes nothing', () => {
    expect(afterSecond).toEqual(afterFirst);
    expect(secondLogs).toEqual([
      expect.stringContaining('removed 0 callpermissions rows'),
      expect.stringContaining('removed 0 communities_events_permissions rows'),
      expect.stringContaining('removed 0 communities_channels_roles_permissions and 0 communities_articles_roles_permissions rows'),
      expect.stringContaining('removed 0 role assignments of banned users (0 memberships'),
    ]);
  });

  it('down() is a no-op', async () => {
    const runner = { query: jest.fn() } as any;
    await new CleanupMigration().down(runner);
    expect(runner.query).not.toHaveBeenCalled();
    expect(await snapshot()).toEqual(afterSecond);
  });
});
