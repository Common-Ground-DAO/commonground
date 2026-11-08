// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The event list (`getUpcomingEvents`, `getCommunityEvents`) and the attend
 * check (`insertEventParticipant`) read event role permissions only through
 * live roles of the event's own community, against a real, throwaway
 * PostgreSQL (skipped unless CG_TEST_PG_HOST is set): a permission row that
 * names another community's role (or a deleted role) neither lists the event
 * nor lets anyone attend. The test creates and drops its own database
 * `cg_event_list_test` — never point it at a server with data. Host and port
 * come only from CG_TEST_PG_HOST / CG_TEST_PG_PORT (tests/helpers/testPg.ts).
 *
 * Schema: the columns the statements touch.
 */

import { Pool } from 'pg';
import { TEST_PG_HOST, TEST_PG_PORT, TEST_PG_PASSWORD, describeDb } from './helpers/testPg';

const DATABASE = 'cg_event_list_test';

let mockPoolTarget: Pool | undefined;
jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => (mockPoolTarget as any).query(...args) },
}));
jest.mock('../repositories/calls', () => ({ __esModule: true, default: {} }));
jest.mock('../repositories/files', () => ({ __esModule: true, default: {} }));
jest.mock('../api/util', () => ({ __esModule: true, convertEventPermissionToCallPermission: jest.fn() }));
jest.mock('../api/emails', () => ({ __esModule: true, default: {} }));

import communityEventHelper from '../repositories/communityEvents';
import { CommunityEventPermission } from '../common/enums';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const COMMUNITY = id(0x100);
const OTHER = id(0x101);
// roles
const R_ADMIN = id(0x200);
const R_MEMBER = id(0x201);
const R_PUBLIC = id(0x202);
const R_DELETED = id(0x203);      // custom role of COMMUNITY, deleted
const R_OTHER_PUBLIC = id(0x210);
const R_OTHER_MEMBER = id(0x211);
// events of COMMUNITY
const E_OWN_PUBLIC = id(0x300);   // own Public role: listed for everyone
const E_FOREIGN_PUBLIC = id(0x301); // only OTHER's Public role (and the Admin row)
const E_FOREIGN_MEMBER = id(0x302); // only OTHER's Member role (and the Admin row)
const E_DELETED_ROLE = id(0x303); // only a deleted role (and the Admin row)
// users
const VISITOR = id(0x400);        // no role
const FOREIGN = id(0x401);        // claimed Member of OTHER
const MEMBER = id(0x402);         // claimed Member of COMMUNITY
const FORMER = id(0x403);         // claimed the deleted role

describeDb('event list and attend check on PostgreSQL', () => {
  let server: Pool;
  let admin: Pool;
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);

  beforeAll(async () => {
    server = new Pool({ host: TEST_PG_HOST, port: TEST_PG_PORT, user: 'postgres', password: TEST_PG_PASSWORD, database: 'postgres', max: 2 });
    await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${DATABASE}`);
    admin = new Pool({ host: TEST_PG_HOST, port: TEST_PG_PORT, user: 'postgres', password: TEST_PG_PASSWORD, database: DATABASE });
    for (const pool of [server, admin]) {
      pool.on('error', () => undefined);
    }
    mockPoolTarget = admin;

    const values = Object.values(CommunityEventPermission).map(p => `'${p}'`).join(', ');
    await q(`CREATE TYPE "public"."communities_events_permissions_permissions_enum" AS ENUM (${values})`);
    await q(`CREATE TABLE roles ("id" uuid PRIMARY KEY, "communityId" uuid NOT NULL, "title" varchar(64) NOT NULL, "type" text NOT NULL, "deletedAt" timestamptz)`);
    await q(`CREATE TABLE roles_users_users ("roleId" uuid NOT NULL, "userId" uuid NOT NULL, "claimed" boolean NOT NULL DEFAULT false, PRIMARY KEY ("userId", "roleId"))`);
    await q(`CREATE TABLE communities_events (
      "id" uuid PRIMARY KEY, "communityId" uuid NOT NULL, "url" varchar(30), "eventCreator" uuid NOT NULL, "callId" uuid,
      "type" text NOT NULL, "imageId" varchar(64), "title" varchar(100) NOT NULL, "description" jsonb NOT NULL,
      "externalUrl" varchar(250), "location" varchar(250), "scheduleDate" timestamptz NOT NULL, "duration" integer,
      "createdAt" timestamptz NOT NULL DEFAULT now(), "updatedAt" timestamptz NOT NULL DEFAULT now(), "deletedAt" timestamptz)`);
    await q(`CREATE TABLE communities_events_participants ("eventId" uuid NOT NULL, "userId" uuid NOT NULL, "createdAt" timestamptz NOT NULL DEFAULT now(), PRIMARY KEY ("eventId", "userId"))`);
    await q(`CREATE TABLE communities_events_permissions ("communityEventId" uuid NOT NULL, "roleId" uuid NOT NULL, "permissions" "public"."communities_events_permissions_permissions_enum"[] NOT NULL, PRIMARY KEY ("communityEventId", "roleId"))`);

    await q(`INSERT INTO roles VALUES
      ($1, $7, 'Admin', 'PREDEFINED', NULL),
      ($2, $7, 'Member', 'PREDEFINED', NULL),
      ($3, $7, 'Public', 'PREDEFINED', NULL),
      ($4, $7, 'Former', 'CUSTOM_MANUAL_ASSIGN', now()),
      ($5, $8, 'Public', 'PREDEFINED', NULL),
      ($6, $8, 'Member', 'PREDEFINED', NULL)`,
      [R_ADMIN, R_MEMBER, R_PUBLIC, R_DELETED, R_OTHER_PUBLIC, R_OTHER_MEMBER, COMMUNITY, OTHER]);
    await q(`INSERT INTO roles_users_users VALUES ($1, $2, TRUE), ($3, $4, TRUE), ($5, $6, TRUE)`,
      [R_OTHER_MEMBER, FOREIGN, R_MEMBER, MEMBER, R_DELETED, FORMER]);

    const events: [string, number][] = [[E_OWN_PUBLIC, 1], [E_FOREIGN_PUBLIC, 2], [E_FOREIGN_MEMBER, 3], [E_DELETED_ROLE, 4]];
    for (const [eventId, day] of events) {
      await q(`INSERT INTO communities_events ("id", "communityId", "eventCreator", "type", "title", "description", "scheduleDate", "duration")
        VALUES ($1, $2, $3, 'external', 't', '{}', now() + ($4 || ' days')::interval, 60)`, [eventId, COMMUNITY, MEMBER, String(day)]);
    }
    const ALL = '{EVENT_PREVIEW,EVENT_ATTEND,EVENT_MODERATE}';
    const VIEW_ATTEND = '{EVENT_PREVIEW,EVENT_ATTEND}';
    const rows: [string, string, string][] = [
      [E_OWN_PUBLIC, R_ADMIN, ALL], [E_OWN_PUBLIC, R_PUBLIC, VIEW_ATTEND],
      [E_FOREIGN_PUBLIC, R_ADMIN, ALL], [E_FOREIGN_PUBLIC, R_OTHER_PUBLIC, VIEW_ATTEND],
      [E_FOREIGN_MEMBER, R_ADMIN, ALL], [E_FOREIGN_MEMBER, R_OTHER_MEMBER, VIEW_ATTEND],
      [E_DELETED_ROLE, R_ADMIN, ALL], [E_DELETED_ROLE, R_DELETED, VIEW_ATTEND],
    ];
    for (const [eventId, roleId, perms] of rows) {
      await q(`INSERT INTO communities_events_permissions VALUES ($1, $2, $3)`, [eventId, roleId, perms]);
    }
  }, 60000);

  afterAll(async () => {
    await admin?.end();
    await server?.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server?.end();
  });

  const upcoming = async (userId?: string) =>
    (await communityEventHelper.getUpcomingEvents(userId, {} as any)).map(e => e.id).sort();

  it('a leftover row of another community\'s Public role does not list the event for anyone', async () => {
    expect(await upcoming(undefined)).toEqual([E_OWN_PUBLIC]);
    expect(await upcoming(VISITOR)).toEqual([E_OWN_PUBLIC]);
  });

  it('a leftover row of another community\'s role does not list the event for that role\'s members', async () => {
    expect(await upcoming(FOREIGN)).toEqual([E_OWN_PUBLIC]);
    expect((await communityEventHelper.getCommunityEvents(COMMUNITY, FOREIGN)).map(e => e.id)).toEqual([E_OWN_PUBLIC]);
  });

  it('a row of a deleted role lists nothing', async () => {
    expect(await upcoming(FORMER)).toEqual([E_OWN_PUBLIC]);
  });

  it('the listed role permissions name only live roles of the event\'s community', async () => {
    const [event] = await communityEventHelper.getCommunityEvents(COMMUNITY, MEMBER);
    expect(event.id).toBe(E_OWN_PUBLIC);
    expect(event.rolePermissions.map(rp => rp.roleId).sort()).toEqual([R_ADMIN, R_PUBLIC].sort());
  });

  it('a leftover row of another community\'s role or a deleted role does not let anyone attend', async () => {
    await expect(communityEventHelper.insertEventParticipant(FOREIGN, { eventId: E_FOREIGN_MEMBER } as any)).rejects.toThrow();
    await expect(communityEventHelper.insertEventParticipant(FORMER, { eventId: E_DELETED_ROLE } as any)).rejects.toThrow();
    const participants = await q(`SELECT count(*)::int AS n FROM communities_events_participants`);
    expect(participants.rows[0].n).toBe(0);
  });
});
