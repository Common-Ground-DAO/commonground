// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * `Message/getSyncState` and the notification read-state writes against a
 * real, throwaway PostgreSQL (skipped unless CG_TEST_PG_HOST is set). The
 * test creates and drops its own database `cg_sync_state_test` and the
 * cluster-wide roles `writer`/`reader` if missing — never point it at a
 * server with data:
 *
 *   docker run -d --name pg-test -p 127.0.0.1:55432:5432 -e POSTGRES_PASSWORD=pw postgres:18
 *   CG_TEST_PG_HOST=127.0.0.1 CG_TEST_PG_PORT=55432 CG_TEST_PG_PASSWORD=pw yarn jest tests/syncStateDb.spec.ts
 *
 * Host and port come only from CG_TEST_PG_HOST / CG_TEST_PG_PORT
 * (tests/helpers/testPg.ts).
 *
 * Schema: the tables the statements touch as before the chat-sync
 * migrations, then the real migrations `1793635200000-chatSyncSeq`
 * (`channel_sync_state`, `messages."syncSeq"`, the trigger, the live unread
 * index) and `1793635100000-syncStateIndexes` (up / down / up). Sequences
 * therefore come from the trigger.
 *
 * The repositories run as the api's role `writer`: getSyncState on a pool
 * whose sessions are read-only (`default_transaction_read_only`), so any
 * write it attempted would fail; `markAsRead` / `markAllAsRead` on a
 * writable pool in their own block.
 */

import { Pool } from 'pg';
import { TEST_PG_HOST, TEST_PG_PORT, TEST_PG_PASSWORD, describeDb } from './helpers/testPg';

const HOST = TEST_PG_HOST;
const PORT = TEST_PG_PORT;
const PASSWORD = TEST_PG_PASSWORD;
const WRITER_PASSWORD = 'writer-test';
const DATABASE = 'cg_sync_state_test';

let mockReadOnlyPool: Pool | undefined;
/** the pool the repositories run on: read-only, except for the notification writes */
let mockPoolTarget: Pool | undefined;
jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: { query: (...args: any[]) => (mockPoolTarget as any).query(...args) },
}));

jest.mock('../repositories/files', () => ({ __esModule: true, default: {} }));

import { ChatSyncSeq1793635200000 as ChatSyncSeqMigration } from '../migrations/1793635200000-chatSyncSeq';
import { SyncStateIndexes1793635100000 as IndexMigration } from '../migrations/1793635100000-syncStateIndexes';
import syncStateHelper from '../repositories/syncState';
import { UNREAD_CAP } from '../repositories/messages';
import notificationHelper from '../repositories/notifications';

const id = (n: number) => `00000000-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;

const ME = id(1);
const OTHER = id(2);

// communities
const C_MEMBER = id(0x100);    // I hold the Member role
const C_DELETED = id(0x101);   // deleted community where I hold a role
const C_FOREIGN = id(0x102);   // not a member, Public may read
const C_UNCLAIMED = id(0x103); // my role assignment is not claimed
const C_DELROLE = id(0x104);   // my only role is deleted

// roles
const R_MEMBER = id(0x200);
const R_PUBLIC = id(0x201);
const R_EXTRA = id(0x202);     // second claimed role, EXISTS only
const R_DELETED_C = id(0x203);
const R_FOREIGN_PUBLIC = id(0x204);
const R_UNCLAIMED = id(0x205);
const R_DELROLE = id(0x206);
const R_OTHER_ONLY = id(0x207); // a role in C_MEMBER I do not hold
const R_CUSTOM_PUBLIC = id(0x208); // a custom role in C_MEMBER titled "Public", nobody holds it

// channels in C_MEMBER
const CH_READ = id(0x300);          // Member: EXISTS + READ, lastRead set
const CH_PUBLIC = id(0x301);        // only Public: EXISTS + READ
const CH_EXISTS_ONLY = id(0x302);   // Member: EXISTS only
const CH_SPLIT = id(0x303);         // Member: READ, extra role: EXISTS
const CH_READ_NO_EXISTS = id(0x304);// Member: READ only
const CH_DELETED = id(0x305);       // deleted channel
const CH_OTHER_ROLE = id(0x306);    // only a role I do not hold
const CH_NO_LASTREAD = id(0x307);   // readable, no lastRead
const CH_MANY = id(0x308);          // more unread than the cap
const CH_CUSTOM_PUBLIC = id(0x309); // only the custom "Public" role: EXISTS + READ
// channels elsewhere
const CH_IN_DELETED_C = id(0x310);
const CH_FOREIGN = id(0x311);
const CH_UNCLAIMED = id(0x312);
const CH_DELROLE = id(0x313);
// chats
const CHAT = id(0x400);
const CHAT_CH = id(0x401);
const CHAT_NO_LASTREAD = id(0x402);
const CHAT_NO_LASTREAD_CH = id(0x403);
const CHAT_FOREIGN = id(0x404);
const CHAT_FOREIGN_CH = id(0x405);
const CHAT_DELETED = id(0x406);
const CHAT_DELETED_CH = id(0x407);

describeDb('getSyncState and notification read state on PostgreSQL', () => {
  let admin: Pool;
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);
  const T0 = '2026-11-01T10:00:00.000Z';
  let messageNo = 0;

  /** messages at T0 + minutes */
  async function addMessages(channelId: string, creatorId: string, minutes: number[], deleted = false) {
    for (const minute of minutes) {
      messageNo += 1;
      await q(
        `INSERT INTO messages ("id", "creatorId", "channelId", "body", "createdAt", "deletedAt")
         VALUES ($1, $2, $3, '{"version":"1","content":[]}', $4::timestamptz + make_interval(mins => $5), $6)`,
        [id(0x10000 + messageNo), creatorId, channelId, T0, minute, deleted ? T0 : null],
      );
    }
  }

  let server: Pool;
  // like TypeORM's QueryRunner.query: the rows
  const runner = { query: async (sql: string, params?: unknown[]) => (await q(sql, params)).rows } as any;
  const writerPool = (readOnly: boolean) => new Pool({
    host: HOST, port: PORT, user: 'writer', password: WRITER_PASSWORD, database: DATABASE,
    ...(readOnly ? { options: '-c default_transaction_read_only=on' } : {}),
  });
  const indexes = async () => (await q(
    `SELECT indexname, indexdef FROM pg_indexes WHERE indexname IN ('idx_notifications_userId_unread', 'idx_chats_userIds_gin') ORDER BY indexname`,
  )).rows;

  let warn: jest.SpyInstance;
  beforeAll(async () => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    server = new Pool({ host: HOST, port: PORT, user: 'postgres', password: PASSWORD, database: 'postgres', max: 2 });
    await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${DATABASE}`);
    for (const role of ['writer', 'reader']) {
      await server.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role}; END IF; END $$`);
    }
    await server.query(`ALTER ROLE writer LOGIN PASSWORD '${WRITER_PASSWORD}'`);
    admin = new Pool({ host: HOST, port: PORT, user: 'postgres', password: PASSWORD, database: DATABASE });

    // the parts of the schema the statements touch, as before the chat-sync
    // migrations (owned by the migrating superuser; writer has table rights)
    await q(`CREATE TYPE ccrp_permissions_enum AS ENUM ('CHANNEL_EXISTS', 'CHANNEL_READ', 'CHANNEL_WRITE', 'CHANNEL_MODERATE')`);
    await q(`CREATE TABLE communities ("id" uuid PRIMARY KEY, "deletedAt" timestamptz)`);
    await q(`CREATE TABLE roles ("id" uuid PRIMARY KEY, "communityId" uuid NOT NULL, "title" varchar(64) NOT NULL, "deletedAt" timestamptz, "type" text NOT NULL DEFAULT 'PREDEFINED')`);
    await q(`CREATE TABLE roles_users_users ("roleId" uuid NOT NULL, "userId" uuid NOT NULL, "claimed" boolean NOT NULL DEFAULT false, PRIMARY KEY ("userId", "roleId"))`);
    await q(`CREATE TABLE communities_channels ("channelId" uuid NOT NULL, "communityId" uuid NOT NULL, "deletedAt" timestamptz, PRIMARY KEY ("channelId", "communityId"))`);
    await q(`CREATE TABLE communities_channels_roles_permissions ("communityId" uuid NOT NULL, "channelId" uuid NOT NULL, "roleId" uuid NOT NULL, "permissions" ccrp_permissions_enum[] NOT NULL, PRIMARY KEY ("communityId", "channelId", "roleId"))`);
    await q(`CREATE TABLE chats ("id" uuid PRIMARY KEY, "channelId" uuid NOT NULL UNIQUE, "userIds" uuid[] NOT NULL, "deletedAt" timestamptz)`);
    await q(`CREATE INDEX ON chats ("userIds")`);
    await q(`CREATE TABLE channelreadstate ("userId" uuid NOT NULL, "channelId" uuid NOT NULL, "lastRead" timestamptz(3) NOT NULL, PRIMARY KEY ("userId", "channelId"))`);
    await q(`CREATE TABLE messages (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "creatorId" uuid NOT NULL, "channelId" uuid NOT NULL,
      "body" jsonb NOT NULL, "createdAt" timestamptz(3) NOT NULL DEFAULT now(), "updatedAt" timestamptz(3) NOT NULL DEFAULT now(),
      "deletedAt" timestamptz(3),
      CONSTRAINT "UQ_6df0905b0802e8402e6570c6505" UNIQUE ("channelId", "createdAt"))`);
    await q(`CREATE INDEX ON messages ("channelId")`);
    await q(`CREATE TABLE notifications (
      "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(), "userId" uuid NOT NULL, "read" boolean NOT NULL DEFAULT false,
      "updatedAt" timestamptz(3) NOT NULL DEFAULT '2026-01-01T00:00:00Z')`);
    await q(`CREATE INDEX ON notifications ("userId")`);
    await q(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO writer`);
    await q(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO reader`);

    await new ChatSyncSeqMigration().up(runner);
    const indexMigration = new IndexMigration();
    await indexMigration.up(runner);
    await indexMigration.down(runner);
    expect(await indexes()).toEqual([]);
    await indexMigration.up(runner);

    mockReadOnlyPool = writerPool(true);
    mockPoolTarget = mockReadOnlyPool;
    for (const pool of [server, admin, mockReadOnlyPool]) {
      pool.on('error', () => undefined);
    }

    await q(`INSERT INTO communities VALUES ($1, NULL), ($2, now()), ($3, NULL), ($4, NULL), ($5, NULL)`,
      [C_MEMBER, C_DELETED, C_FOREIGN, C_UNCLAIMED, C_DELROLE]);
    await q(`INSERT INTO roles VALUES
      ($1, $8, 'Member', NULL), ($2, $8, 'Public', NULL), ($3, $8, 'Extra', NULL), ($7, $8, 'Other', NULL),
      ($4, $9, 'Member', NULL), ($5, $10, 'Public', NULL), ($6, $11, 'Member', NULL), ($12, $13, 'Member', now())`,
      [R_MEMBER, R_PUBLIC, R_EXTRA, R_DELETED_C, R_FOREIGN_PUBLIC, R_UNCLAIMED, R_OTHER_ONLY,
        C_MEMBER, C_DELETED, C_FOREIGN, C_UNCLAIMED, R_DELROLE, C_DELROLE]);
    await q(`INSERT INTO roles VALUES ($1, $2, 'Public', NULL, 'CUSTOM_MANUAL_ASSIGN')`, [R_CUSTOM_PUBLIC, C_MEMBER]);
    await q(`INSERT INTO roles_users_users VALUES
      ($1, $6, true), ($2, $6, true), ($3, $6, true), ($4, $6, false), ($5, $6, true), ($7, $8, true)`,
      [R_MEMBER, R_EXTRA, R_DELETED_C, R_UNCLAIMED, R_DELROLE, ME, R_OTHER_ONLY, OTHER]);

    const channels: [string, string, boolean][] = [
      [CH_READ, C_MEMBER, false], [CH_PUBLIC, C_MEMBER, false], [CH_EXISTS_ONLY, C_MEMBER, false],
      [CH_SPLIT, C_MEMBER, false], [CH_READ_NO_EXISTS, C_MEMBER, false], [CH_DELETED, C_MEMBER, true],
      [CH_OTHER_ROLE, C_MEMBER, false], [CH_NO_LASTREAD, C_MEMBER, false], [CH_MANY, C_MEMBER, false],
      [CH_IN_DELETED_C, C_DELETED, false], [CH_FOREIGN, C_FOREIGN, false], [CH_UNCLAIMED, C_UNCLAIMED, false],
      [CH_DELROLE, C_DELROLE, false],
      [CH_CUSTOM_PUBLIC, C_MEMBER, false],
    ];
    for (const [channelId, communityId, deleted] of channels) {
      await q(`INSERT INTO communities_channels VALUES ($1, $2, $3)`, [channelId, communityId, deleted ? T0 : null]);
    }
    const readable = '{CHANNEL_EXISTS,CHANNEL_READ}';
    const permissions: [string, string, string, string][] = [
      [C_MEMBER, CH_READ, R_MEMBER, '{CHANNEL_EXISTS,CHANNEL_READ,CHANNEL_WRITE}'],
      [C_MEMBER, CH_PUBLIC, R_PUBLIC, readable],
      [C_MEMBER, CH_EXISTS_ONLY, R_MEMBER, '{CHANNEL_EXISTS}'],
      [C_MEMBER, CH_EXISTS_ONLY, R_PUBLIC, '{CHANNEL_EXISTS}'],
      [C_MEMBER, CH_SPLIT, R_MEMBER, '{CHANNEL_READ}'],
      [C_MEMBER, CH_SPLIT, R_EXTRA, '{CHANNEL_EXISTS}'],
      [C_MEMBER, CH_READ_NO_EXISTS, R_MEMBER, '{CHANNEL_READ}'],
      [C_MEMBER, CH_DELETED, R_MEMBER, readable],
      [C_MEMBER, CH_OTHER_ROLE, R_OTHER_ONLY, readable],
      [C_MEMBER, CH_NO_LASTREAD, R_MEMBER, readable],
      [C_MEMBER, CH_MANY, R_MEMBER, readable],
      [C_DELETED, CH_IN_DELETED_C, R_DELETED_C, readable],
      [C_FOREIGN, CH_FOREIGN, R_FOREIGN_PUBLIC, readable],
      [C_UNCLAIMED, CH_UNCLAIMED, R_UNCLAIMED, readable],
      [C_DELROLE, CH_DELROLE, R_DELROLE, readable],
      [C_MEMBER, CH_CUSTOM_PUBLIC, R_CUSTOM_PUBLIC, readable],
    ];
    for (const [communityId, channelId, roleId, perms] of permissions) {
      await q(`INSERT INTO communities_channels_roles_permissions VALUES ($1, $2, $3, $4)`, [communityId, channelId, roleId, perms]);
    }
    await q(`INSERT INTO chats VALUES ($1, $2, $9, NULL), ($3, $4, $9, NULL), ($5, $6, $10, NULL), ($7, $8, $9, now())`,
      [CHAT, CHAT_CH, CHAT_NO_LASTREAD, CHAT_NO_LASTREAD_CH, CHAT_FOREIGN, CHAT_FOREIGN_CH, CHAT_DELETED, CHAT_DELETED_CH,
        [ME, OTHER], [OTHER, id(3)]]);

    // lastRead at T0 + 10 min where set
    const lastRead = new Date(Date.parse(T0) + 10 * 60_000).toISOString();
    for (const channelId of [CH_READ, CH_PUBLIC, CH_MANY, CHAT_CH]) {
      await q(`INSERT INTO channelreadstate VALUES ($1, $2, $3)`, [ME, channelId, lastRead]);
    }

    // CH_READ: 2 of others after lastRead, 1 own after, 1 deleted after, 1 before
    await addMessages(CH_READ, OTHER, [5, 11, 12]);
    await addMessages(CH_READ, ME, [13]);
    await addMessages(CH_READ, OTHER, [14], true);
    // CH_PUBLIC: nothing after lastRead
    await addMessages(CH_PUBLIC, OTHER, [1]);
    // CH_NO_LASTREAD (community, no lastRead): messages exist, unread stays 0
    await addMessages(CH_NO_LASTREAD, OTHER, [1, 2, 3]);
    // CH_MANY: more than the cap
    await q(
      `INSERT INTO messages ("creatorId", "channelId", "body", "createdAt")
       SELECT $1, $2, '{"version":"1","content":[]}', $3::timestamptz + make_interval(secs => g)
       FROM generate_series(1, ${UNREAD_CAP + 50}) g`,
      [OTHER, CH_MANY, lastRead],
    );
    // chat with lastRead: 1 before, 2 after (one own)
    await addMessages(CHAT_CH, OTHER, [1, 20]);
    await addMessages(CHAT_CH, ME, [21]);
    // chat without lastRead: every message of others counts
    await addMessages(CHAT_NO_LASTREAD_CH, OTHER, [1, 2, 3]);
    await addMessages(CHAT_NO_LASTREAD_CH, ME, [4]);
    await addMessages(CHAT_NO_LASTREAD_CH, OTHER, [5], true);
    // invisible channels have messages too
    await addMessages(CH_EXISTS_ONLY, OTHER, [30]);
    await addMessages(CH_FOREIGN, OTHER, [30]);

    // a sequence beyond 2^31 (the trigger gave CHAT_CH 3) reaches the client exactly
    await q(`UPDATE channel_sync_state SET seq = 9007199254740991 WHERE "channelId" = $1`, [CHAT_CH]);
    await q(`INSERT INTO notifications ("userId", "read") VALUES ($1, false), ($1, false), ($1, true), ($2, false)`, [ME, OTHER]);
  }, 60000);

  afterAll(async () => {
    warn?.mockRestore();
    await mockReadOnlyPool?.end();
    await admin?.end();
    await server?.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server?.end();
  });

  it('the index migration: both indexes, as declared', async () => {
    expect(await indexes()).toEqual([
      { indexname: 'idx_chats_userIds_gin', indexdef: expect.stringContaining('USING gin ("userIds")') },
      { indexname: 'idx_notifications_userId_unread', indexdef: expect.stringContaining('USING btree ("userId") WHERE (read = false)') },
    ]);
  });

  const byChannel = (channels: API.Messages.getSyncState.ChannelState[]) =>
    Object.fromEntries(channels.map(c => [c.channelId, c]));

  it('lists exactly the readable channels and chats', async () => {
    const { channels } = await syncStateHelper.getSyncState(ME, {});
    expect(channels.map(c => c.channelId).sort()).toEqual([
      CH_READ, CH_PUBLIC, CH_SPLIT, CH_NO_LASTREAD, CH_MANY, CHAT_CH, CHAT_NO_LASTREAD_CH,
    ].sort());
  });

  it('reports read state, unread counts and sequences', async () => {
    const response = await syncStateHelper.getSyncState(ME, {});
    const state = byChannel(response.channels);

    expect(state[CH_READ]).toEqual({
      channelId: CH_READ,
      communityId: C_MEMBER,
      // five inserts, numbered by the trigger
      syncSeq: 5,
      lastRead: '2026-11-01T10:10:00.000Z',
      lastMessageDate: '2026-11-01T10:13:00.000Z',
      unread: 2,
    });
    expect(state[CH_PUBLIC]).toMatchObject({ communityId: C_MEMBER, syncSeq: 1, unread: 0 });
    expect(state[CH_PUBLIC].chatId).toBeUndefined();
    // community channel without lastRead: 0
    expect(state[CH_NO_LASTREAD]).toMatchObject({ lastRead: null, unread: 0, lastMessageDate: '2026-11-01T10:03:00.000Z' });
    // channel without messages
    expect(state[CH_SPLIT]).toMatchObject({ lastMessageDate: null, lastRead: null, unread: 0, syncSeq: 0 });
    // capped
    expect(state[CH_MANY].unread).toBe(UNREAD_CAP);
    // chat with lastRead: others after lastRead only
    expect(state[CHAT_CH]).toEqual({
      channelId: CHAT_CH,
      chatId: CHAT,
      syncSeq: 9007199254740991,
      lastRead: '2026-11-01T10:10:00.000Z',
      lastMessageDate: '2026-11-01T10:21:00.000Z',
      unread: 1,
    });
    // chat without lastRead: every non-deleted message of others
    expect(state[CHAT_NO_LASTREAD_CH]).toMatchObject({ chatId: CHAT_NO_LASTREAD, lastRead: null, unread: 3 });
    expect(state[CHAT_NO_LASTREAD_CH].communityId).toBeUndefined();

    expect(response.notificationUnreadCount).toBe(2);
    expect(Number.isNaN(Date.parse(response.serverTime))).toBe(false);
  });

  it('follows a new message: sequence and unread from one snapshot', async () => {
    const before = byChannel((await syncStateHelper.getSyncState(ME, { channelIds: [CH_READ] })).channels)[CH_READ];
    await addMessages(CH_READ, OTHER, [40]);
    const after = byChannel((await syncStateHelper.getSyncState(ME, { channelIds: [CH_READ] })).channels)[CH_READ];
    const stored = (await q(`SELECT seq FROM channel_sync_state WHERE "channelId" = $1`, [CH_READ])).rows[0].seq;
    expect(after.syncSeq).toBe(before.syncSeq + 1);
    expect(after.syncSeq).toBe(Number(stored));
    expect(after.unread).toBe(before.unread + 1);
    expect(after.lastMessageDate).toBe('2026-11-01T10:40:00.000Z');
  });

  it('restricts the answer to the requested channels, still by visibility', async () => {
    const { channels } = await syncStateHelper.getSyncState(ME, {
      channelIds: [CH_READ, CHAT_NO_LASTREAD_CH, CH_EXISTS_ONLY, CH_FOREIGN, CHAT_FOREIGN_CH, id(0xfff)],
    });
    expect(channels.map(c => c.channelId).sort()).toEqual([CH_READ, CHAT_NO_LASTREAD_CH].sort());

    const empty = await syncStateHelper.getSyncState(ME, { channelIds: [] });
    expect(empty.channels).toEqual([]);
    expect(empty.notificationUnreadCount).toBe(2);
  });

  it('writes nothing', async () => {
    const before = await q(`SELECT count(*)::int AS n FROM channelreadstate`);
    await syncStateHelper.getSyncState(ME, {});
    await syncStateHelper.getSyncState(OTHER, {});
    const after = await q(`SELECT count(*)::int AS n FROM channelreadstate`);
    expect(after.rows[0].n).toBe(before.rows[0].n);
    // the repository's pool really refuses writes
    await expect(mockReadOnlyPool!.query(`INSERT INTO channelreadstate VALUES ($1, $2, now())`, [ME, CH_NO_LASTREAD]))
      .rejects.toThrow(/read-only transaction/);
  });

  it('gives another user only their own view', async () => {
    const state = byChannel((await syncStateHelper.getSyncState(OTHER, {})).channels);
    // OTHER holds only R_OTHER_ONLY in C_MEMBER, plus Public there
    expect(Object.keys(state).sort()).toEqual([CH_OTHER_ROLE, CH_PUBLIC, CHAT_CH, CHAT_NO_LASTREAD_CH, CHAT_FOREIGN_CH].sort());
    // OTHER has no lastRead on CHAT_CH: all of ME's messages count
    expect(state[CHAT_CH]).toMatchObject({ lastRead: null, unread: 1 });
    expect(state[CHAT_NO_LASTREAD_CH].unread).toBe(1);
  });
  describe('notification read state', () => {
    const READER = id(5);
    const STRANGER = id(6);
    const N_UNREAD = id(0x500);
    const N_READ = id(0x501);
    const N_FOREIGN = id(0x502);
    const N_UNREAD_2 = id(0x503);
    const N_UNREAD_3 = id(0x504);
    let writable: Pool;

    beforeAll(async () => {
      writable = writerPool(false);
      writable.on('error', () => undefined);
      mockPoolTarget = writable;
      await q(`INSERT INTO notifications ("id", "userId", "read") VALUES
        ($1, $4, false), ($2, $4, true), ($3, $5, false)`, [N_UNREAD, N_READ, N_FOREIGN, READER, STRANGER]);
    });

    afterAll(async () => {
      mockPoolTarget = mockReadOnlyPool;
      await writable.end();
    });

    const row = async (notificationId: string) =>
      (await q(`SELECT "read", "updatedAt" FROM notifications WHERE "id" = $1`, [notificationId])).rows[0];
    const dbNow = async () => (await q(`SELECT now() AS now`)).rows[0].now as Date;

    it('markAsRead changes an unread notification once', async () => {
      const before = await dbNow();
      const first = await notificationHelper.markAsRead(READER, { notificationId: N_UNREAD });
      expect(first.changed).toBe(true);
      const stored = await row(N_UNREAD);
      expect(stored.read).toBe(true);
      expect(first.updatedAt).toBe(stored.updatedAt.toISOString());
      expect(stored.updatedAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 1);

      // second call: found, nothing written
      const second = await notificationHelper.markAsRead(READER, { notificationId: N_UNREAD });
      expect(second).toEqual({ changed: false, updatedAt: null });
      expect((await row(N_UNREAD)).updatedAt.toISOString()).toBe(first.updatedAt);
    });

    it('markAsRead leaves an already read notification alone', async () => {
      await expect(notificationHelper.markAsRead(READER, { notificationId: N_READ }))
        .resolves.toEqual({ changed: false, updatedAt: null });
      expect((await row(N_READ)).updatedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('markAsRead answers NOT_FOUND for unknown and foreign notifications', async () => {
      await expect(notificationHelper.markAsRead(READER, { notificationId: id(0x5ff) })).rejects.toThrow('NOT_FOUND');
      await expect(notificationHelper.markAsRead(READER, { notificationId: N_FOREIGN })).rejects.toThrow('NOT_FOUND');
      expect((await row(N_FOREIGN)).read).toBe(false);
    });

    it('markAllAsRead writes nothing when nothing is unread', async () => {
      await expect(notificationHelper.markAllAsRead(READER)).resolves.toEqual({ changed: 0, updatedAt: null });
      expect((await row(N_READ)).updatedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
    });

    it('markAllAsRead changes exactly the unread notifications of the user', async () => {
      await q(`INSERT INTO notifications ("id", "userId", "read") VALUES ($1, $3, false), ($2, $3, false)`,
        [N_UNREAD_2, N_UNREAD_3, READER]);
      const before = await dbNow();
      const result = await notificationHelper.markAllAsRead(READER);
      expect(result.changed).toBe(2);
      expect(result.updatedAt).not.toBeNull();
      expect(Date.parse(result.updatedAt!)).toBeGreaterThanOrEqual(before.getTime() - 1);
      expect(Date.parse(result.updatedAt!)).toBeLessThanOrEqual((await dbNow()).getTime());
      for (const notificationId of [N_UNREAD_2, N_UNREAD_3]) {
        const stored = await row(notificationId);
        expect(stored.read).toBe(true);
        expect(stored.updatedAt.toISOString()).toBe(result.updatedAt);
      }
      // read rows and other users' rows untouched
      expect((await row(N_READ)).updatedAt.toISOString()).toBe('2026-01-01T00:00:00.000Z');
      expect((await row(N_FOREIGN)).read).toBe(false);
      await expect(notificationHelper.getUnreadCountWithTime(READER)).resolves.toMatchObject({ unreadCount: 0 });
      await expect(notificationHelper.getUnreadCountWithTime(STRANGER)).resolves.toMatchObject({ unreadCount: 1 });
    });
  });
});
