// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The message sync sequence (migration 1793635200000-chatSyncSeq) against a
 * real, throwaway PostgreSQL (skipped unless CG_TEST_PG_HOST is set). The
 * test creates and drops its own database `cg_chat_sync_test` and the
 * cluster-wide roles `writer`/`reader` if missing — never point it at a
 * server with data:
 *
 *   docker run -d --name pg-test -e POSTGRES_PASSWORD=pw postgres:18
 *   CG_TEST_PG_HOST=<host> CG_TEST_PG_PASSWORD=pw yarn jest tests/chatSyncSeqDb.spec.ts
 *
 * - the migration up / down / up, with its GRANTs;
 * - the trigger under the api's role `writer`: inserts, real and no-op
 *   updates, soft deletes (tombstones);
 * - commit order: concurrent writers of one channel are serialised, and
 *   every snapshot that shows channel seq S holds exactly the rows with
 *   syncSeq <= S;
 * - repositories/messages against the real schema: idempotent create,
 *   getChanges, setChannelLastRead.
 */

import { Pool, type PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { ChatSyncSeq1793635200000 as Migration } from '../migrations/1793635200000-chatSyncSeq';

const HOST = process.env.CG_TEST_PG_HOST;
const ADMIN_PASSWORD = process.env.CG_TEST_PG_PASSWORD || 'pw';
const WRITER_PASSWORD = 'writer-test';
const DATABASE = 'cg_chat_sync_test';
const describeDb = HOST ? describe : describe.skip;

// repositories/messages runs on this pool (the api's role); set in beforeAll
let mockWriterPool: Pool | undefined;
jest.mock('../util/postgres', () => ({
  __esModule: true,
  default: {
    query: (...args: any[]) => (mockWriterPool as any).query(...args),
    connect: () => (mockWriterPool as Pool).connect(),
  },
}));
jest.mock('../repositories/files', () => ({ __esModule: true, default: { getFileData: jest.fn().mockResolvedValue([]) } }));

import messageHelper from '../repositories/messages';

describeDb('message sync sequence on PostgreSQL', () => {
  let server: Pool;
  let admin: Pool;
  let writer: Pool;
  const q = (sql: string, params?: unknown[]) => admin.query(sql, params);
  const runner = { query: (sql: string, params?: unknown[]) => q(sql, params) } as any;

  let me: string;
  let other: string;
  /** distinct createdAt per insert: (channelId, createdAt) is unique */
  let clock = 0;
  const nextCreatedAt = () => new Date(Date.UTC(2026, 0, 1) + (clock++) * 1000).toISOString();

  async function newChannel() {
    return (await q(`INSERT INTO channels DEFAULT VALUES RETURNING id`)).rows[0].id as string;
  }
  async function insertAs(db: Pool | PoolClient, channelId: string, creatorId = me) {
    const result = await db.query(
      `INSERT INTO messages ("creatorId", "channelId", body, "createdAt") VALUES ($1, $2, '{"version":"1","content":[]}', $3) RETURNING id, "syncSeq"`,
      [creatorId, channelId, nextCreatedAt()],
    );
    return { id: result.rows[0].id as string, syncSeq: Number(result.rows[0].syncSeq) };
  }
  async function seqOf(messageId: string) {
    const value = (await q(`SELECT "syncSeq" FROM messages WHERE id = $1`, [messageId])).rows[0].syncSeq;
    return value === null ? null : Number(value);
  }
  async function channelSeq(channelId: string) {
    const rows = (await q(`SELECT seq FROM channel_sync_state WHERE "channelId" = $1`, [channelId])).rows;
    return rows.length === 0 ? 0 : Number(rows[0].seq);
  }

  let preMigrationMessage: { id: string; channelId: string };

  let warn: jest.SpyInstance;
  beforeAll(async () => {
    warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
    server = new Pool({ host: HOST, user: 'postgres', password: ADMIN_PASSWORD, database: 'postgres', max: 2 });
    await server.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server.query(`CREATE DATABASE ${DATABASE}`);
    for (const role of ['writer', 'reader']) {
      await server.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role}; END IF; END $$`);
    }
    await server.query(`ALTER ROLE writer LOGIN PASSWORD '${WRITER_PASSWORD}'`);

    admin = new Pool({ host: HOST, user: 'postgres', password: ADMIN_PASSWORD, database: DATABASE, max: 30 });
    // the parts of the schema the message statements touch, as before the
    // migration (owned by the migrating superuser; writer has table rights)
    await q(`CREATE TABLE channels (id uuid PRIMARY KEY DEFAULT gen_random_uuid())`);
    await q(`CREATE TABLE users (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), "displayAccount" text)`);
    await q(`CREATE TABLE user_accounts ("userId" uuid, type text, "displayName" text, "imageId" text)`);
    await q(`CREATE TABLE messages (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      "creatorId" uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      "channelId" uuid NOT NULL REFERENCES channels(id) ON DELETE CASCADE,
      body jsonb NOT NULL, attachments jsonb, "parentMessageId" uuid REFERENCES messages(id) ON DELETE SET NULL,
      reactions jsonb, tsv_tags tsvector DEFAULT to_tsvector('simple', ''), "editedAt" timestamptz(3),
      "createdAt" timestamptz(3) NOT NULL DEFAULT now(), "updatedAt" timestamptz(3) NOT NULL DEFAULT now(),
      "deletedAt" timestamptz(3),
      CONSTRAINT "UQ_6df0905b0802e8402e6570c6505" UNIQUE ("channelId", "createdAt"))`);
    await q(`CREATE INDEX ON messages ("channelId")`);
    await q(`CREATE TABLE channelreadstate (
      "channelId" uuid NOT NULL REFERENCES channels(id), "userId" uuid NOT NULL REFERENCES users(id),
      "lastRead" timestamptz(3) NOT NULL DEFAULT now(), PRIMARY KEY ("channelId", "userId"))`);
    await q(`CREATE TABLE reactions (
      "userId" uuid NOT NULL, "itemId" uuid NOT NULL, reaction text NOT NULL,
      "createdAt" timestamptz(3) DEFAULT now(), "updatedAt" timestamptz(3) DEFAULT now(), "deletedAt" timestamptz(3),
      PRIMARY KEY ("userId", "itemId"))`);
    await q(`GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO writer`);
    await q(`GRANT SELECT ON ALL TABLES IN SCHEMA public TO reader`);

    me = (await q(`INSERT INTO users DEFAULT VALUES RETURNING id`)).rows[0].id;
    other = (await q(`INSERT INTO users DEFAULT VALUES RETURNING id`)).rows[0].id;
    await q(`INSERT INTO user_accounts ("userId", type, "displayName") VALUES ($1, 'cg', 'Me')`, [me]);
    await q(`UPDATE users SET "displayAccount" = 'cg' WHERE id = $1`, [me]);

    const migration = new Migration();
    await migration.up(runner);
    await migration.down(runner);
    // a message from before the migration
    const channelId = await newChannel();
    const inserted = await q(`INSERT INTO messages ("creatorId", "channelId", body, "createdAt") VALUES ($1, $2, '{"version":"1","content":[]}', $3) RETURNING id`, [other, channelId, nextCreatedAt()]);
    preMigrationMessage = { id: inserted.rows[0].id, channelId };
    await migration.up(runner);

    writer = new Pool({ host: HOST, user: 'writer', password: WRITER_PASSWORD, database: DATABASE, max: 30 });
    mockWriterPool = writer;
    // the final DROP DATABASE ... WITH (FORCE) may still meet a closing connection
    for (const pool of [server, admin, writer]) {
      pool.on('error', () => undefined);
    }
  }, 60000);

  afterAll(async () => {
    warn?.mockRestore();
    await writer?.end();
    await admin?.end();
    await server?.query(`DROP DATABASE IF EXISTS ${DATABASE} WITH (FORCE)`);
    await server?.end();
  });

  it('the migration: table, column, partial index, triggers and grants', async () => {
    const column = (await q(`SELECT data_type, is_nullable, column_default FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'syncSeq'`)).rows[0];
    expect(column).toEqual({ data_type: 'bigint', is_nullable: 'YES', column_default: null });
    const index = (await q(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_messages_channelId_syncSeq'`)).rows[0].indexdef;
    expect(index).toContain('("channelId", "syncSeq") WHERE ("syncSeq" IS NOT NULL)');
    const live = (await q(`SELECT indexdef FROM pg_indexes WHERE indexname = 'idx_messages_channelId_createdAt_live'`)).rows[0].indexdef;
    expect(live).toContain('("channelId", "createdAt") INCLUDE ("creatorId") WHERE ("deletedAt" IS NULL)');
    const triggers = (await q(`SELECT tgname FROM pg_trigger WHERE tgrelid = 'messages'::regclass AND NOT tgisinternal ORDER BY tgname`)).rows.map(r => r.tgname);
    expect(triggers).toEqual(['messages_sync_seq_insert', 'messages_sync_seq_update']);
    const privileges = (await q(`SELECT
      has_table_privilege('writer', 'channel_sync_state', 'SELECT') AS w_select,
      has_table_privilege('writer', 'channel_sync_state', 'INSERT') AS w_insert,
      has_table_privilege('writer', 'channel_sync_state', 'UPDATE') AS w_update,
      has_table_privilege('writer', 'channel_sync_state', 'DELETE') AS w_delete,
      has_table_privilege('reader', 'channel_sync_state', 'SELECT') AS r_select,
      has_table_privilege('reader', 'channel_sync_state', 'UPDATE') AS r_update`)).rows[0];
    expect(privileges).toEqual({ w_select: true, w_insert: true, w_update: true, w_delete: false, r_select: true, r_update: false });
    // the function runs as the writing role, not as its owner
    const fn = (await q(`SELECT prosecdef FROM pg_proc WHERE proname = 'messages_set_sync_seq'`)).rows[0];
    expect(fn.prosecdef).toBe(false);
  });

  it('down removes everything up created', async () => {
    const migration = new Migration();
    await migration.down(runner);
    try {
      const left = (await q(`SELECT
        to_regclass('public.channel_sync_state') AS "table",
        to_regclass('public."idx_messages_channelId_syncSeq"') AS "index",
        to_regclass('public."idx_messages_channelId_createdAt_live"') AS "liveIndex",
        (SELECT count(*)::int FROM pg_proc WHERE proname = 'messages_set_sync_seq') AS "function",
        (SELECT count(*)::int FROM pg_trigger WHERE tgrelid = 'messages'::regclass AND NOT tgisinternal) AS "triggers",
        (SELECT count(*)::int FROM information_schema.columns WHERE table_name = 'messages' AND column_name = 'syncSeq') AS "column"`)).rows[0];
      expect(left).toEqual({ table: null, index: null, liveIndex: null, function: 0, triggers: 0, column: 0 });
    }
    finally {
      await migration.up(runner);
    }
  });

  it('rows from before the migration have no seq until their next write', async () => {
    expect(await seqOf(preMigrationMessage.id)).toBeNull();
    expect(await channelSeq(preMigrationMessage.channelId)).toBe(0);
    await writer.query(`UPDATE messages SET reactions = '{"a":1}' WHERE id = $1`, [preMigrationMessage.id]);
    expect(await seqOf(preMigrationMessage.id)).toBe(1);
    expect(await channelSeq(preMigrationMessage.channelId)).toBe(1);
  });

  it('inserts by the writer role count up per channel', async () => {
    const a = await newChannel();
    const b = await newChannel();
    expect((await insertAs(writer, a)).syncSeq).toBe(1);
    expect((await insertAs(writer, a)).syncSeq).toBe(2);
    expect((await insertAs(writer, b)).syncSeq).toBe(1);
    expect((await insertAs(writer, a)).syncSeq).toBe(3);
    expect(await channelSeq(a)).toBe(3);
    expect(await channelSeq(b)).toBe(1);
    // an explicit value is overwritten
    const forced = await writer.query(`INSERT INTO messages ("creatorId", "channelId", body, "createdAt", "syncSeq") VALUES ($1, $2, '{}', $3, 999) RETURNING "syncSeq"`, [me, b, nextCreatedAt()]);
    expect(Number(forced.rows[0].syncSeq)).toBe(2);
  });

  it('real updates bump the seq, no-op updates do not', async () => {
    const channel = await newChannel();
    const { id } = await insertAs(writer, channel);
    await writer.query(`UPDATE messages SET body = '{"version":"1","content":[{"type":"text","value":"x"}]}', "updatedAt" = now() WHERE id = $1`, [id]);
    expect(await seqOf(id)).toBe(2);
    await writer.query(`UPDATE messages SET body = body, reactions = reactions WHERE id = $1`, [id]);
    expect(await seqOf(id)).toBe(2);
    expect(await channelSeq(channel)).toBe(2);
    await writer.query(`UPDATE messages SET "updatedAt" = "updatedAt" + interval '1 ms' WHERE id = $1`, [id]);
    expect(await seqOf(id)).toBe(3);
  });

  it('soft deletes leave tombstones with a seq; replies of a deleted parent get one too', async () => {
    const channel = await newChannel();
    const parent = await insertAs(writer, channel);
    const reply = (await writer.query(
      `INSERT INTO messages ("creatorId", "channelId", body, "createdAt", "parentMessageId") VALUES ($1, $2, '{}', $3, $4) RETURNING id`,
      [other, channel, nextCreatedAt(), parent.id],
    )).rows[0].id as string;
    const result = await messageHelper.deleteMessage({ messageId: parent.id, channelId: channel, creatorId: me });
    expect(result.deletedIds).toEqual([parent.id]);
    expect(result.deletedSyncSeqs).toHaveLength(1);
    expect(result.updatedParents).toEqual([{ id: reply, syncSeq: expect.any(Number) }]);
    // seqs 3 and 4 in some order: one statement, two rows
    expect([result.deletedSyncSeqs[0], result.updatedParents[0].syncSeq].sort()).toEqual([3, 4]);
    expect(await seqOf(parent.id)).toBe(result.deletedSyncSeqs[0]);
    expect(await channelSeq(channel)).toBe(4);

    // deleting all of a user's messages bumps once per row
    const more = [await insertAs(writer, channel, other), await insertAs(writer, channel, other)];
    const all = await messageHelper.deleteAllUserMessages({ access: { communityId: me, channelId: channel }, creatorId: other });
    expect(all.deletedIds.sort()).toEqual([reply, ...more.map(m => m.id)].sort());
    expect(all.deletedSyncSeqs.sort()).toEqual([7, 8, 9]);
    // nothing left to delete: no write, no bump
    const none = await messageHelper.deleteAllUserMessages({ access: { communityId: me, channelId: channel }, creatorId: other });
    expect(none.deletedIds).toEqual([]);
    expect(await channelSeq(channel)).toBe(9);
  });

  it('a second writer of the channel waits for the first to commit', async () => {
    const channel = await newChannel();
    const first = await writer.connect();
    const second = await writer.connect();
    try {
      await first.query('BEGIN');
      const a = await insertAs(first, channel);
      expect(a.syncSeq).toBe(1);
      await second.query('BEGIN');
      let secondDone = false;
      const secondInsert = insertAs(second, channel).then(result => { secondDone = true; return result; });
      // the second insert is blocked on the channel's sequence row
      for (let i = 0; i < 100; i++) {
        const waiting = (await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [DATABASE])).rows[0].n;
        if (waiting === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      expect(secondDone).toBe(false);
      expect(await channelSeq(channel)).toBe(0);
      await first.query('COMMIT');
      const b = await secondInsert;
      expect(b.syncSeq).toBe(2);
      // before the second commits, a reader sees seq 1 and exactly row 1
      const before = (await q(`SELECT (SELECT seq FROM channel_sync_state WHERE "channelId" = $1) AS seq, (SELECT array_agg("syncSeq" ORDER BY "syncSeq") FROM messages WHERE "channelId" = $1) AS seqs`, [channel])).rows[0];
      expect(Number(before.seq)).toBe(1);
      expect(before.seqs.map(Number)).toEqual([1]);
      await second.query('COMMIT');
      expect(await channelSeq(channel)).toBe(2);
    }
    finally {
      first.release();
      second.release();
    }
  });

  it('a delete with replies does not deadlock with a concurrent write on a reply', async () => {
    const channel = await newChannel();
    const parent = await insertAs(writer, channel);
    const reply = (await writer.query(
      `INSERT INTO messages ("creatorId", "channelId", body, "createdAt", "parentMessageId") VALUES ($1, $2, '{}', $3, $4) RETURNING id`,
      [other, channel, nextCreatedAt(), parent.id],
    )).rows[0].id as string;
    // a single-row writer that holds the reply's row lock but not yet the
    // channel's sequence row (like an UPDATE between finding and changing it)
    const replyWriter = await writer.connect();
    try {
      await replyWriter.query('BEGIN');
      await replyWriter.query(`SELECT 1 FROM messages WHERE id = $1 FOR UPDATE`, [reply]);
      const deleting = messageHelper.deleteMessage({ messageId: parent.id, channelId: channel, creatorId: me });
      for (let i = 0; i < 100; i++) {
        const waiting = (await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [DATABASE])).rows[0].n;
        if (waiting === 1) break;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      // the delete waits on the reply's row without holding the sequence row
      await replyWriter.query(`UPDATE messages SET reactions = '{"a":1}' WHERE id = $1`, [reply]);
      await replyWriter.query('COMMIT');
      const result = await deleting;
      expect(result.deletedIds).toEqual([parent.id]);
      expect(result.updatedParents.map(p => p.id)).toEqual([reply]);
      expect(await channelSeq(channel)).toBe(5);
    }
    finally {
      replyWriter.release();
    }
  });

  /** resolves with the promise's value, rejects if it takes longer than `ms` (a blocked writer) */
  const within = <T,>(promise: Promise<T>, ms: number, label: string) => Promise.race([
    promise,
    new Promise<never>((_, reject) => setTimeout(() => reject(new Error(`${label} still blocked after ${ms} ms`)), ms)),
  ]);
  async function waitForLockWaiters(n: number) {
    for (let i = 0; i < 150; i++) {
      const waiting = (await q(`SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = $1 AND wait_event_type = 'Lock'`, [DATABASE])).rows[0].n;
      if (waiting >= n) return;
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error(`fewer than ${n} lock waiters`);
  }

  /**
   * A parent and an existing reply with a larger id; a third transaction
   * holds the reply's row, so the delete stops after locking the parent
   * (its locks run in id order) — the moment a reference to the parent
   * meets the delete's lock.
   */
  async function deleteHeldAfterParentLock(reference: (channel: string, parent: string) => Promise<unknown>) {
    const channel = await newChannel();
    // uuid order is the order of the lowercase hex strings
    const [parent, reply] = [randomUUID(), randomUUID()].sort();
    await writer.query(`INSERT INTO messages (id, "creatorId", "channelId", body, "createdAt") VALUES ($1, $2, $3, '{}', $4)`, [parent, me, channel, nextCreatedAt()]);
    await writer.query(`INSERT INTO messages (id, "creatorId", "channelId", body, "createdAt", "parentMessageId") VALUES ($1, $2, $3, '{}', $4, $5)`, [reply, other, channel, nextCreatedAt(), parent]);
    const holder = await writer.connect();
    try {
      await holder.query('BEGIN');
      await holder.query(`SELECT 1 FROM messages WHERE id = $1 FOR UPDATE`, [reply]);
      const deleting = messageHelper.deleteMessage({ messageId: parent, channelId: channel, creatorId: me });
      await waitForLockWaiters(1);
      // takes the channel's sequence row first, then KEY SHARE on the parent
      const referenced = await within(reference(channel, parent), 3000, 'the reference to the parent');
      await holder.query('COMMIT');
      const result = await within(deleting, 3000, 'the delete');
      return { channel, parent, reply, result, referenced };
    }
    finally {
      await holder.query('ROLLBACK').catch(() => undefined);
      holder.release();
    }
  }

  it('a reply inserted while its parent is being deleted does not deadlock', async () => {
    let newReply = '';
    const { parent, reply, result } = await deleteHeldAfterParentLock(async (channel, parentId) => {
      newReply = (await writer.query(
        `INSERT INTO messages ("creatorId", "channelId", body, "createdAt", "parentMessageId") VALUES ($1, $2, '{}', $3, $4) RETURNING id`,
        [other, channel, nextCreatedAt(), parentId],
      )).rows[0].id;
    });
    expect(result.deletedIds).toEqual([parent]);
    // only the reply locked before the write is cleaned; the late one keeps
    // its parent, as if it had been committed after the delete
    expect(result.updatedParents.map(p => p.id)).toEqual([reply]);
    expect((await q(`SELECT "parentMessageId" FROM messages WHERE id = $1`, [newReply])).rows[0].parentMessageId).toBe(parent);
  });

  it('a message re-parented to a message being deleted does not deadlock', async () => {
    let moved = '';
    const { parent, result } = await deleteHeldAfterParentLock(async (channel, parentId) => {
      moved = (await insertAs(writer, channel, other)).id;
      await writer.query(`UPDATE messages SET "parentMessageId" = $2 WHERE id = $1`, [moved, parentId]);
    });
    expect(result.deletedIds).toEqual([parent]);
    expect((await q(`SELECT "parentMessageId" FROM messages WHERE id = $1`, [moved])).rows[0].parentMessageId).toBe(parent);
  });

  it('a delete does not deadlock with a reaction change on the deleted message', async () => {
    const channel = await newChannel();
    const target = await insertAs(writer, channel);
    await writer.query(`INSERT INTO reactions ("userId", "itemId", reaction) VALUES ($1, $2, 'a')`, [other, target.id]);
    await writer.query(`UPDATE messages SET reactions = '{"a":1}' WHERE id = $1`, [target.id]);
    // what set/unsetReaction do: the reaction row first, then the message row
    const reactor = await writer.connect();
    try {
      await reactor.query('BEGIN');
      await reactor.query(`UPDATE reactions SET reaction = 'b', "updatedAt" = now() WHERE "userId" = $1 AND "itemId" = $2`, [other, target.id]);
      const deleting = messageHelper.deleteMessage({ messageId: target.id, channelId: channel, creatorId: me });
      await waitForLockWaiters(1);
      await within(reactor.query(`UPDATE messages SET reactions = '{"b":1}', "updatedAt" = now() WHERE id = $1`, [target.id]), 3000, 'the reaction');
      await reactor.query('COMMIT');
      const result = await within(deleting, 3000, 'the delete');
      expect(result.deletedIds).toEqual([target.id]);
      expect((await q(`SELECT "deletedAt" IS NOT NULL AS gone FROM reactions WHERE "itemId" = $1`, [target.id])).rows[0].gone).toBe(true);
    }
    finally {
      await reactor.query('ROLLBACK').catch(() => undefined);
      reactor.release();
    }
  });

  it('the unread count of setChannelLastRead is an index-only scan', async () => {
    const channel = await newChannel();
    await q(`
      INSERT INTO messages ("creatorId", "channelId", body, "createdAt", "deletedAt")
      SELECT CASE WHEN i % 3 = 0 THEN $1::uuid ELSE $2::uuid END, $3, '{}',
        '2025-01-01'::timestamptz + i * interval '1 second',
        CASE WHEN i % 10 = 0 THEN now() ELSE NULL END
      FROM generate_series(1, 20000) i
    `, [me, other, channel]);
    await q(`VACUUM ANALYZE messages`);
    const spy = jest.spyOn(writer, 'query');
    await messageHelper.setChannelLastRead(me, { access: { communityId: me, channelId: channel }, lastRead: '2025-01-01T01:00:00.000Z' });
    const [sql, params] = spy.mock.calls[0] as unknown as [string, unknown[]];
    spy.mockRestore();
    const client = await admin.connect();
    try {
      await client.query('BEGIN');
      const plan = (await client.query(`EXPLAIN (FORMAT JSON) ${sql}`, params)).rows[0]['QUERY PLAN'][0].Plan;
      await client.query('ROLLBACK');
      const nodes: { 'Node Type': string, 'Index Name'?: string, 'Relation Name'?: string }[] = [];
      const walk = (node: any) => { nodes.push(node); (node.Plans ?? []).forEach(walk); };
      walk(plan);
      const messageScans = nodes.filter(node => node['Relation Name'] === 'messages');
      // the count; the other scan is the messageId lookup (primary key)
      expect(messageScans).toContainEqual(expect.objectContaining({
        'Node Type': 'Index Only Scan',
        'Index Name': 'idx_messages_channelId_createdAt_live',
      }));
      expect(messageScans.every(node => node['Node Type'] !== 'Seq Scan')).toBe(true);
    }
    finally {
      client.release();
    }
  }, 30000);

  it('a rolled-back write leaves no gap', async () => {
    const channel = await newChannel();
    const client = await writer.connect();
    try {
      await client.query('BEGIN');
      await insertAs(client, channel);
      await client.query('ROLLBACK');
    }
    finally {
      client.release();
    }
    expect(await channelSeq(channel)).toBe(0);
    expect((await insertAs(writer, channel)).syncSeq).toBe(1);
  });

  it('under concurrent writers every snapshot with seq S holds exactly the rows 1..S', async () => {
    const channel = await newChannel();
    const WRITERS = 8;
    const WRITES = 15;
    let running = true;
    const snapshots: { seq: number; seqs: number[] }[] = [];
    const reader = (async () => {
      while (running) {
        const row = (await q(`
          SELECT COALESCE((SELECT seq FROM channel_sync_state WHERE "channelId" = $1), 0) AS seq,
            COALESCE((SELECT array_agg("syncSeq" ORDER BY "syncSeq") FROM messages WHERE "channelId" = $1), '{}') AS seqs
        `, [channel])).rows[0];
        snapshots.push({ seq: Number(row.seq), seqs: row.seqs.map(Number) });
      }
    })();
    const writers = Array.from({ length: WRITERS }, async (_, w) => {
      const client = await writer.connect();
      try {
        for (let i = 0; i < WRITES; i++) {
          await client.query('BEGIN');
          const { id } = await insertAs(client, channel);
          if (i % 3 === 0) {
            // an edit in the same transaction: a second bump of the same row
            await client.query(`UPDATE messages SET body = '{"version":"1","content":[],"e":${w}}', "updatedAt" = now() WHERE id = $1`, [id]);
          }
          // hold the lock a moment, so others queue up behind it
          await new Promise(resolve => setTimeout(resolve, Math.random() * 3));
          await client.query('COMMIT');
        }
      }
      finally {
        client.release();
      }
    });
    await Promise.all(writers);
    running = false;
    await reader;

    const total = WRITERS * WRITES + WRITERS * Math.ceil(WRITES / 3);
    expect(await channelSeq(channel)).toBe(total);
    expect(snapshots.length).toBeGreaterThan(5);
    for (const snapshot of snapshots) {
      // each row shows its last seq; an edited row skipped its insert seq
      expect(snapshot.seqs.every(seq => seq <= snapshot.seq)).toBe(true);
      expect(new Set(snapshot.seqs).size).toBe(snapshot.seqs.length);
    }
    // seq order = commit order: rows visible at S are all rows whose last seq is <= S
    const finalSeqs = (await q(`SELECT "syncSeq" FROM messages WHERE "channelId" = $1`, [channel])).rows.map(r => Number(r.syncSeq));
    for (const snapshot of snapshots) {
      expect(snapshot.seqs).toEqual(finalSeqs.filter(seq => seq <= snapshot.seq).sort((x, y) => x - y));
    }
  }, 60000);

  describe('repositories/messages on the real schema', () => {
    const accessFor = (channelId: string) => ({ communityId: me, channelId });
    const body = { version: '1' as const, content: [] };

    it('createMessage is idempotent on the id', async () => {
      const channel = await newChannel();
      const id = '00000000-0000-4000-8000-00000000c0de';
      const request = { id, access: accessFor(channel), body, parentMessageId: null, attachments: [] };
      const first = await messageHelper.createMessage(me, request);
      expect(first).toEqual(expect.objectContaining({ created: true, userAlias: 'Me' }));
      expect(first.message.syncSeq).toBe(1);
      const readState = (await q(`SELECT "lastRead" FROM channelreadstate WHERE "channelId" = $1 AND "userId" = $2`, [channel, me])).rows[0].lastRead;

      const retry = await messageHelper.createMessage(me, request);
      expect(retry.created).toBe(false);
      expect(retry.message).toEqual(expect.objectContaining({ id, creatorId: me, channelId: channel, syncSeq: 1 }));
      expect(new Date(retry.message.createdAt).getTime()).toBe(new Date(first.message.createdAt).getTime());
      expect((await q(`SELECT count(*)::int AS n FROM messages WHERE id = $1`, [id])).rows[0].n).toBe(1);
      // the retry wrote no read state
      expect((await q(`SELECT "lastRead" FROM channelreadstate WHERE "channelId" = $1 AND "userId" = $2`, [channel, me])).rows[0].lastRead).toEqual(readState);

      await expect(messageHelper.createMessage(other, request)).rejects.toThrow('NOT_ALLOWED');
      const elsewhere = await newChannel();
      await expect(messageHelper.createMessage(me, { ...request, access: accessFor(elsewhere) })).rejects.toThrow('NOT_ALLOWED');
      // the refused attempts bumped no seq of the original row
      expect(await seqOf(id)).toBe(1);
      // and neither the retry nor the refused clashes took a channel seq (no false gap)
      expect(await channelSeq(channel)).toBe(1);
      expect(await channelSeq(elsewhere)).toBe(0);
      // the next real message continues without a gap
      const next = await messageHelper.createMessage(me, { ...request, id: '00000000-0000-4000-8000-00000000c0df' });
      expect(next.message.syncSeq).toBe(2);
    });

    it('a same-millisecond insert into the channel raises what the create retry looks for', async () => {
      const channel = await newChannel();
      const client = await writer.connect();
      try {
        // one transaction = one now(): the second insert takes the same createdAt
        await client.query('BEGIN');
        await client.query(`INSERT INTO messages ("creatorId", "channelId", body) VALUES ($1, $2, '{}')`, [other, channel]);
        const collide = client.query(`INSERT INTO messages ("creatorId", "channelId", body) VALUES ($1, $2, '{}') ON CONFLICT ("id") DO NOTHING`, [me, channel]);
        await expect(collide).rejects.toMatchObject({ code: '23505', table: 'messages', constraint: 'UQ_6df0905b0802e8402e6570c6505' });
        await client.query('ROLLBACK');
      }
      finally {
        client.release();
      }
    });

    it('getChanges: reset, change list with tombstones, paging, resets for bad cursors', async () => {
      const channel = await newChannel();
      const empty = await messageHelper.getChanges(me, { access: accessFor(channel), cursor: null });
      expect(empty).toEqual(expect.objectContaining({ cursor: '1:0', syncSeq: 0, reset: true, hasMore: false, messages: [], deletedIds: [] }));

      const ids: string[] = [];
      for (let i = 0; i < 5; i++) {
        ids.push((await insertAs(writer, channel, i % 2 ? other : me)).id);
      }
      const reset = await messageHelper.getChanges(me, { access: accessFor(channel), cursor: null });
      expect(reset).toEqual(expect.objectContaining({ cursor: '1:5', syncSeq: 5, reset: true, hasMore: false, deletedIds: [] }));
      expect(reset.messages.map(m => m.id)).toEqual([...ids].reverse());
      expect(typeof reset.serverTime).toBe('string');

      // an edit (seq 6), a reaction (7) and a delete (8)
      await messageHelper.editMessage(me, { access: accessFor(channel), id: ids[0], body: { version: '1', content: [{ type: 'text', value: 'edited' }] } } as any);
      await messageHelper.setReaction(me, { access: accessFor(channel), messageId: ids[1], reaction: '👍' });
      await messageHelper.deleteMessage({ messageId: ids[2], channelId: channel, creatorId: me });
      const changes = await messageHelper.getChanges(me, { access: accessFor(channel), cursor: '1:5' });
      expect(changes).toEqual(expect.objectContaining({ cursor: '1:8', syncSeq: 8, reset: false, hasMore: false, deletedIds: [ids[2]] }));
      expect(changes.messages.map(m => [m.id, m.syncSeq])).toEqual([[ids[0], 6], [ids[1], 7]]);
      expect(changes.messages[1].ownReaction).toBe('👍');
      expect(changes.messages[1].reactions).toEqual({ '👍': 1 });

      const page = await messageHelper.getChanges(me, { access: accessFor(channel), cursor: '1:5', limit: 2 });
      expect(page).toEqual(expect.objectContaining({ cursor: '1:7', syncSeq: 7, hasMore: true }));
      const rest = await messageHelper.getChanges(me, { access: accessFor(channel), cursor: page.cursor, limit: 2 });
      expect(rest).toEqual(expect.objectContaining({ cursor: '1:8', hasMore: false, deletedIds: [ids[2]], messages: [] }));

      const ahead = await messageHelper.getChanges(me, { access: accessFor(channel), cursor: '1:99' });
      expect(ahead).toEqual(expect.objectContaining({ reset: true, cursor: '1:8' }));
      // the reset page has no deleted messages
      expect(ahead.messages.map(m => m.id)).toEqual([ids[4], ids[3], ids[1], ids[0]]);
      await expect(messageHelper.getChanges(me, { access: accessFor(channel), cursor: '7:1' as any })).resolves.toEqual(expect.objectContaining({ reset: true }));

      // more than 500 changes behind
      for (let i = 0; i < 501; i++) {
        await writer.query(`UPDATE messages SET reactions = jsonb_build_object('n', $2::int) WHERE id = $1`, [ids[4], i]);
      }
      const behind = await messageHelper.getChanges(me, { access: accessFor(channel), cursor: '1:8' });
      expect(behind).toEqual(expect.objectContaining({ reset: true, cursor: '1:509', syncSeq: 509 }));
      const justInside = await messageHelper.getChanges(me, { access: accessFor(channel), cursor: '1:9' });
      expect(justInside).toEqual(expect.objectContaining({ reset: false, cursor: '1:509', messages: [expect.objectContaining({ id: ids[4], syncSeq: 509 })] }));
    }, 30000);

    it('setChannelLastRead: stored value, unread of others, channel seq; messageId uses its createdAt', async () => {
      const channel = await newChannel();
      const mine = await insertAs(writer, channel, me);
      const theirs = [await insertAs(writer, channel, other), await insertAs(writer, channel, other), await insertAs(writer, channel, other)];
      const createdAt = async (id: string) => (await q(`SELECT "createdAt" FROM messages WHERE id = $1`, [id])).rows[0].createdAt as Date;

      const atFirst = await messageHelper.setChannelLastRead(me, {
        access: accessFor(channel), lastRead: new Date(0).toISOString(), messageId: theirs[0].id,
      });
      expect(atFirst).toEqual({ lastRead: (await createdAt(theirs[0].id)).toISOString(), unread: 2, syncSeq: 4 });

      // an older value does not move it back
      const older = await messageHelper.setChannelLastRead(me, { access: accessFor(channel), lastRead: new Date(0).toISOString() });
      expect(older).toEqual(atFirst);

      // a message of another channel is ignored: the posted time counts
      const foreign = await insertAs(writer, await newChannel(), other);
      const viaForeign = await messageHelper.setChannelLastRead(me, {
        access: accessFor(channel), lastRead: (await createdAt(theirs[1].id)).toISOString(), messageId: foreign.id,
      });
      expect(viaForeign.unread).toBe(1);

      // a future time is clamped to now(); own messages never count
      const future = await messageHelper.setChannelLastRead(me, { access: accessFor(channel), lastRead: '2999-01-01T00:00:00.000Z' });
      expect(new Date(future.lastRead).getTime()).toBeLessThanOrEqual(Date.now() + 1000);
      expect(future.unread).toBe(0);
      expect(mine.syncSeq).toBe(1);

      const otherView = await messageHelper.setChannelLastRead(other, { access: accessFor(channel), lastRead: new Date(0).toISOString() });
      expect(otherView.unread).toBe(1);
    });
  });
});
