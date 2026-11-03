// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * How `permissionHelper.getPermissions` / `getRolePermissions` resolve roles,
 * against a real, throwaway PostgreSQL (skipped unless CG_TEST_PG_HOST is
 * set): the user's claimed roles plus the community's predefined Public role,
 * all of the community that owns the channel, article, call or event. A
 * custom role that carries the title "Public" is an ordinary role. The test
 * creates and drops its own database `cg_permission_public_test` — never
 * point it at a server with data. Host and port come only from
 * CG_TEST_PG_HOST / CG_TEST_PG_PORT (tests/helpers/testPg.ts).
 *
 * Schema: the columns the statements touch (permission arrays as text[]).
 */

import { Pool } from 'pg';
import { TEST_PG_HOST, TEST_PG_PORT, TEST_PG_PASSWORD, describeDb } from './helpers/testPg';

const HOST = TEST_PG_HOST;
const PORT = TEST_PG_PORT;
const PASSWORD = TEST_PG_PASSWORD;
const DATABASE = 'cg_permission_public_test';

let mockPoolTarget: Pool | undefined;
jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => (mockPoolTarget as any).query(...args) },
}));

import permissionHelper from '../repositories/permissions';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const COMMUNITY = id(0x100);
const OTHER_COMMUNITY = id(0x101);
const CHANNEL = id(0x200);
const ARTICLE = id(0x201);
const CALL = id(0x202);
const EVENT = id(0x203);
// roles
const R_PUBLIC = id(0x300);         // predefined Public of COMMUNITY
const R_CUSTOM_PUBLIC = id(0x301);  // custom role titled "Public" in COMMUNITY
const R_MEMBER = id(0x302);
const R_OTHER_PUBLIC = id(0x303);   // predefined Public of OTHER_COMMUNITY
const R_OTHER_MEMBER = id(0x304);   // Member of OTHER_COMMUNITY
// users
const VISITOR = id(0x400);          // no role
const CUSTOM_HOLDER = id(0x401);    // claimed the custom "Public" role
const FOREIGN = id(0x402);          // claimed Member of OTHER_COMMUNITY
const MEMBER = id(0x403);           // claimed Member of COMMUNITY

describeDb('Public role resolution of permissionHelper on PostgreSQL', () => {
  let server: Pool;
  let admin: Pool;
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);

  beforeAll(async () => {
    server = new Pool({ host: HOST, port: PORT, user: 'postgres', password: PASSWORD, database: 'postgres', max: 2 });
    await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${DATABASE}`);
    admin = new Pool({ host: HOST, port: PORT, user: 'postgres', password: PASSWORD, database: DATABASE });
    for (const pool of [server, admin]) {
      pool.on('error', () => undefined);
    }
    mockPoolTarget = admin;

    await q(`CREATE TABLE roles ("id" uuid PRIMARY KEY, "communityId" uuid NOT NULL, "title" varchar(64) NOT NULL, "type" text NOT NULL, "deletedAt" timestamptz, "permissions" text[] NOT NULL DEFAULT '{}')`);
    await q(`CREATE TABLE roles_users_users ("roleId" uuid NOT NULL, "userId" uuid NOT NULL, "claimed" boolean NOT NULL DEFAULT false, PRIMARY KEY ("userId", "roleId"))`);
    await q(`CREATE TABLE calls ("id" uuid PRIMARY KEY, "communityId" uuid NOT NULL, "channelId" uuid)`);
    await q(`CREATE TABLE callpermissions ("callId" uuid NOT NULL, "roleId" uuid NOT NULL, "permissions" text[] NOT NULL, PRIMARY KEY ("callId", "roleId"))`);
    await q(`CREATE TABLE communities_channels_roles_permissions ("communityId" uuid NOT NULL, "channelId" uuid NOT NULL, "roleId" uuid NOT NULL, "permissions" text[] NOT NULL)`);
    await q(`CREATE TABLE communities_articles_roles_permissions ("communityId" uuid NOT NULL, "articleId" uuid NOT NULL, "roleId" uuid NOT NULL, "permissions" text[] NOT NULL)`);
    await q(`CREATE TABLE communities_events ("id" uuid PRIMARY KEY, "communityId" uuid NOT NULL)`);
    await q(`CREATE TABLE communities_events_permissions ("communityEventId" uuid NOT NULL, "roleId" uuid NOT NULL, "permissions" text[] NOT NULL)`);

    await q(`INSERT INTO roles VALUES
      ($1, $6, 'Public', 'PREDEFINED', NULL, '{COMMUNITY_EXISTS}'),
      ($2, $6, 'Public', 'CUSTOM_MANUAL_ASSIGN', NULL, '{COMMUNITY_MODERATE}'),
      ($3, $6, 'Member', 'PREDEFINED', NULL, '{COMMUNITY_CHANNEL_READ}'),
      ($4, $7, 'Public', 'PREDEFINED', NULL, '{COMMUNITY_MANAGE_INFO}'),
      ($5, $7, 'Member', 'PREDEFINED', NULL, '{COMMUNITY_MANAGE_ROLES}')`,
      [R_PUBLIC, R_CUSTOM_PUBLIC, R_MEMBER, R_OTHER_PUBLIC, R_OTHER_MEMBER, COMMUNITY, OTHER_COMMUNITY]);
    await q(`INSERT INTO roles_users_users VALUES ($1, $2, true), ($3, $4, true), ($5, $6, true)`,
      [R_CUSTOM_PUBLIC, CUSTOM_HOLDER, R_OTHER_MEMBER, FOREIGN, R_MEMBER, MEMBER]);
    await q(`INSERT INTO calls VALUES ($1, $2, $3)`, [CALL, COMMUNITY, CHANNEL]);
    await q(`INSERT INTO communities_events VALUES ($1, $2)`, [EVENT, COMMUNITY]);
    // every object: the real Public role gets the "public" permission, the
    // custom "Public" role, another community's Public and Member role get
    // the "extra" one
    const objects: [string, string, string][] = [
      ['callpermissions', '"callId"', CALL],
      ['communities_events_permissions', '"communityEventId"', EVENT],
    ];
    for (const [table, column, objectId] of objects) {
      for (const [roleId, perm] of [[R_PUBLIC, 'CALL_EXISTS'], [R_CUSTOM_PUBLIC, 'CALL_JOIN'], [R_OTHER_PUBLIC, 'AUDIO_SEND'], [R_OTHER_MEMBER, 'VIDEO_SEND'], [R_MEMBER, 'CHANNEL_READ']]) {
        await q(`INSERT INTO ${table} (${column}, "roleId", "permissions") VALUES ($1, $2, $3)`, [objectId, roleId, `{${perm}}`]);
      }
    }
    for (const [table, column, objectId] of [['communities_channels_roles_permissions', '"channelId"', CHANNEL], ['communities_articles_roles_permissions', '"articleId"', ARTICLE]]) {
      for (const [roleId, perm] of [[R_PUBLIC, 'CALL_EXISTS'], [R_CUSTOM_PUBLIC, 'CALL_JOIN'], [R_OTHER_PUBLIC, 'AUDIO_SEND'], [R_OTHER_MEMBER, 'VIDEO_SEND'], [R_MEMBER, 'CHANNEL_READ']]) {
        await q(`INSERT INTO ${table} ("communityId", ${column}, "roleId", "permissions") VALUES ($1, $2, $3, $4)`, [COMMUNITY, objectId, roleId, `{${perm}}`]);
      }
    }
  }, 60000);

  afterAll(async () => {
    await admin?.end();
    await server?.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server?.end();
  });

  const sorted = (set: Set<any>) => Array.from(set).sort();
  const scopes = () => [
    { name: 'call', options: { callId: CALL } },
    { name: 'call with channel', options: { callId: CALL, channelId: CHANNEL } },
    { name: 'event', options: { communityEventId: EVENT } },
    { name: 'channel', options: { communityId: COMMUNITY, channelId: CHANNEL } },
    { name: 'article', options: { communityId: COMMUNITY, articleId: ARTICLE } },
  ];

  it.each(scopes())('$name: anonymous and role-less users get only the predefined Public role', async ({ options }) => {
    expect(sorted(await permissionHelper.getPermissions(options as any))).toEqual(['CALL_EXISTS']);
    expect(sorted(await permissionHelper.getPermissions({ ...options, userId: VISITOR } as any))).toEqual(['CALL_EXISTS']);
  });

  it.each(scopes())('$name: a custom role titled "Public" grants only to those who claimed it', async ({ options }) => {
    expect(sorted(await permissionHelper.getPermissions({ ...options, userId: CUSTOM_HOLDER } as any))).toEqual(['CALL_EXISTS', 'CALL_JOIN']);
  });

  it.each(scopes())('$name: roles of another community grant nothing, claimed or Public', async ({ options }) => {
    expect(sorted(await permissionHelper.getPermissions({ ...options, userId: FOREIGN } as any))).toEqual(['CALL_EXISTS']);
  });

  it.each(scopes())('$name: a member gets the claimed role plus Public', async ({ options }) => {
    expect(sorted(await permissionHelper.getPermissions({ ...options, userId: MEMBER } as any))).toEqual(['CALL_EXISTS', 'CHANNEL_READ']);
  });

  it('community permissions: the predefined Public role, not the custom one', async () => {
    expect(sorted(await permissionHelper.getPermissions({ communityId: COMMUNITY }))).toEqual(['COMMUNITY_EXISTS']);
    expect(sorted(await permissionHelper.getPermissions({ communityId: COMMUNITY, userId: CUSTOM_HOLDER })))
      .toEqual(['COMMUNITY_EXISTS', 'COMMUNITY_MODERATE']);
  });

  it('getRolePermissions lists only roles of the owning community', async () => {
    const callRoles = await permissionHelper.getRolePermissions({ callId: CALL, channelId: CHANNEL });
    expect(callRoles.map(r => r.id).sort()).toEqual([R_PUBLIC, R_CUSTOM_PUBLIC, R_MEMBER].sort());
    const eventRoles = await permissionHelper.getRolePermissions({ communityEventId: EVENT });
    expect(eventRoles.map(r => r.id).sort()).toEqual([R_PUBLIC, R_CUSTOM_PUBLIC, R_MEMBER].sort());
    const channelRoles = await permissionHelper.getRolePermissions({ communityId: COMMUNITY, channelId: CHANNEL });
    expect(channelRoles.map(r => r.id).sort()).toEqual([R_PUBLIC, R_CUSTOM_PUBLIC, R_MEMBER].sort());
  });
});
