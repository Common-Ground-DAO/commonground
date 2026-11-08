// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

// Per-channel, commit-ordered change sequence for messages (chat-sync,
// docs/database "Message sync sequence"):
// - "channel_sync_state": one row per channel that has had a message write
//   since this migration, "seq" = the channel's last assigned sequence. A
//   channel without a row has seq 0.
// - messages."syncSeq": the sequence of the row's last write. Nullable, no
//   default and no backfill, so adding it is a catalog-only change; rows not
//   written since this migration keep NULL until their next write.
// - "idx_messages_channelId_syncSeq": partial (only rows with a sequence),
//   for `syncSeq > cursor` scans per channel. While every row is NULL the
//   build is one sequential scan of messages with nothing to sort.
// - "idx_messages_channelId_createdAt_live": ("channelId", "createdAt")
//   INCLUDE ("creatorId") WHERE "deletedAt" IS NULL, so the capped unread
//   counts (setChannelLastRead, getSyncState: other users' live messages
//   after lastRead) are index-only scans. Build measured on 6.5M messages:
//   2.3 s.
// - trigger "messages_sync_seq" (BEFORE INSERT OR UPDATE, FOR EACH ROW):
//   increments the channel's row in channel_sync_state and writes the new
//   value into NEW."syncSeq". The upsert keeps that row locked until the
//   writing transaction ends, so writers of one channel are serialised and
//   commit in sequence order: a snapshot that sees seq S sees every message
//   row with syncSeq <= S. On UPDATE it fires only when the row changed.
//   Cost per write: one primary-key upsert on a small table.
// The function runs with the privileges of the writing role (no SECURITY
// DEFINER): the api processes' role `writer` gets SELECT, INSERT, UPDATE on
// channel_sync_state, and the function names its table schema-qualified.
//
// LOCKS ON A LIVE DEPLOY: TypeORM runs all pending migrations in one
// transaction (mode "all") and refuses a per-migration `transaction =
// false`, so CREATE INDEX CONCURRENTLY is not possible and every lock below
// is held until the whole migration run commits. The order keeps the time
// in which reads of `messages` wait short:
// 1. the createdAt_live index first: its SHARE lock makes writes of
//    `messages` wait, reads go on;
// 2. then the ALTER TABLE: ACCESS EXCLUSIVE, reads wait too. The change is
//    catalog-only, but the lock has to wait for every open transaction that
//    has touched `messages`;
// 3. then what needs the column: the syncSeq index (one sequential scan)
//    and the triggers.
// Every lock request of this migration waits at most LOCK_TIMEOUT instead of
// queueing (with every later request on the table queued behind it). On a
// timeout the statement fails ("canceling statement due to lock timeout",
// SQLSTATE 55P03), the whole migration run rolls back, migrateDb exits 1 and
// the run can simply be repeated (selfhost compose: `restart: on-failure:3`;
// dev compose: `restart_policy.max_attempts: 2`). The same
// holds when PostgreSQL resolves a deadlock by aborting the migration —
// possible in step 2 with a transaction that read `messages` and then waits
// for its own write (whichever of the two detects the deadlock is aborted).
// The runtime on the production dump is timed in the cg.box dress rehearsal.

/** how long one lock request of this migration may wait */
const LOCK_TIMEOUT = '5s';

/** `work` with lock_timeout = LOCK_TIMEOUT, then the previous value again (both transaction-local) */
async function withLockTimeout(queryRunner: QueryRunner, work: () => Promise<void>): Promise<void> {
    const [{ previous }] = await queryRunner.query(`SELECT current_setting('lock_timeout') AS previous`);
    await queryRunner.query(`SELECT set_config('lock_timeout', $1, true)`, [LOCK_TIMEOUT]);
    await work();
    await queryRunner.query(`SELECT set_config('lock_timeout', $1, true)`, [previous]);
}

export class ChatSyncSeq1793635200000 implements MigrationInterface {
    name = 'ChatSyncSeq1793635200000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await withLockTimeout(queryRunner, async () => {
            await queryRunner.query(`
                CREATE TABLE "channel_sync_state" (
                    "channelId" uuid NOT NULL,
                    "seq" bigint NOT NULL,
                    CONSTRAINT "PK_channel_sync_state" PRIMARY KEY ("channelId")
                )
            `);
            await queryRunner.query(`GRANT SELECT, INSERT, UPDATE ON "channel_sync_state" TO writer`);
            await queryRunner.query(`GRANT SELECT ON "channel_sync_state" TO reader`);
            await queryRunner.query(`
                CREATE FUNCTION messages_set_sync_seq()
                RETURNS trigger
                LANGUAGE plpgsql
                AS $fn$
                BEGIN
                    INSERT INTO public.channel_sync_state AS s ("channelId", "seq")
                    VALUES (NEW."channelId", 1)
                    ON CONFLICT ("channelId") DO UPDATE SET "seq" = s."seq" + 1
                    RETURNING s."seq" INTO NEW."syncSeq";
                    RETURN NEW;
                END
                $fn$
            `);

            // 1. SHARE lock: writes of messages wait from here on, reads do not
            await queryRunner.query(`CREATE INDEX "idx_messages_channelId_createdAt_live" ON "messages" ("channelId", "createdAt") INCLUDE ("creatorId") WHERE "deletedAt" IS NULL`);
            // 2. ACCESS EXCLUSIVE: reads wait too. Nullable without a default:
            //    catalog-only, no table rewrite
            await queryRunner.query(`ALTER TABLE "messages" ADD "syncSeq" bigint`);
            // 3. what needs the column
            await queryRunner.query(`CREATE INDEX "idx_messages_channelId_syncSeq" ON "messages" ("channelId", "syncSeq") WHERE "syncSeq" IS NOT NULL`);
            await queryRunner.query(`
                CREATE TRIGGER "messages_sync_seq_insert"
                BEFORE INSERT ON "messages"
                FOR EACH ROW
                EXECUTE FUNCTION messages_set_sync_seq()
            `);
            await queryRunner.query(`
                CREATE TRIGGER "messages_sync_seq_update"
                BEFORE UPDATE ON "messages"
                FOR EACH ROW
                WHEN (OLD.* IS DISTINCT FROM NEW.*)
                EXECUTE FUNCTION messages_set_sync_seq()
            `);
        });
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await withLockTimeout(queryRunner, async () => {
            await queryRunner.query(`DROP TRIGGER "messages_sync_seq_update" ON "messages"`);
            await queryRunner.query(`DROP TRIGGER "messages_sync_seq_insert" ON "messages"`);
            await queryRunner.query(`DROP FUNCTION messages_set_sync_seq()`);
            await queryRunner.query(`DROP INDEX "idx_messages_channelId_createdAt_live"`);
            await queryRunner.query(`DROP INDEX "idx_messages_channelId_syncSeq"`);
            await queryRunner.query(`ALTER TABLE "messages" DROP COLUMN "syncSeq"`);
            await queryRunner.query(`DROP TABLE "channel_sync_state"`);
        });
    }
}
