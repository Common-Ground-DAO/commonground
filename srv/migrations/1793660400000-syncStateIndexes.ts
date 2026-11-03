// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

// Indexes for the read-state snapshot (`Message/getSyncState`) and the
// unread notification count.
//
// - Partial index over the unread notifications ("read" = FALSE), keyed on
//   "userId". The count is read at login, by `Notification/getUnreadCount`
//   and `getSyncState`, and with every notification event (`new`, `update`,
//   `allread` carry `unreadCount`); without it the count visits every
//   notification of the user or ANDs with the index on "read", which grows
//   with the unread notifications of all users. Measured with 2,030,000
//   notifications and a user with 30,000 of which 40 are unread:
//   5.0 ms -> 0.04 ms (index-only scan); 1.3 MB next to 18 MB for the full
//   "userId" index.
// - GIN index on chats."userIds" for the membership test
//   ("userIds" @> ARRAY[user]) of `getSyncState` and `Chat/getChats`; the
//   existing btree on the column cannot serve it, so both scan every chat.
//   Measured with 100,000 chats, a user in 10 communities and 10 chats:
//   `getSyncState` 8.1 ms -> 1.2 ms (the chats scan was 6.5 ms of it).
//
// Both are built with a plain CREATE INDEX (CREATE INDEX CONCURRENTLY cannot
// run inside a transaction, and the migration runner uses transaction mode
// "all"). Its SHARE lock makes writes to notifications and chats wait, reads
// go on, until the whole migration run commits. When this migration runs in
// one run with 1793635200000-chatSyncSeq, that one holds ACCESS EXCLUSIVE on
// `messages`, so reads of messages wait through these builds as well. Each
// lock request waits at most LOCK_TIMEOUT; on a timeout the run rolls back,
// migrateDb exits 1 and the run can be repeated (see
// 1793635200000-chatSyncSeq). The build time on the production data is
// measured in the dress rehearsal.
//
// Indexes need no GRANT (the roles' table privileges cover them).

/** how long one lock request of this migration may wait */
const LOCK_TIMEOUT = '5s';

/** `work` with lock_timeout = LOCK_TIMEOUT, then the previous value again (both transaction-local) */
async function withLockTimeout(queryRunner: QueryRunner, work: () => Promise<void>): Promise<void> {
    const [{ previous }] = await queryRunner.query(`SELECT current_setting('lock_timeout') AS previous`);
    await queryRunner.query(`SELECT set_config('lock_timeout', $1, true)`, [LOCK_TIMEOUT]);
    await work();
    await queryRunner.query(`SELECT set_config('lock_timeout', $1, true)`, [previous]);
}

export class SyncStateIndexes1793660400000 implements MigrationInterface {
    name = 'SyncStateIndexes1793660400000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await withLockTimeout(queryRunner, async () => {
            await queryRunner.query(`CREATE INDEX "idx_notifications_userId_unread" ON "notifications" ("userId") WHERE "read" = FALSE`);
            await queryRunner.query(`CREATE INDEX "idx_chats_userIds_gin" ON "chats" USING GIN ("userIds")`);
        });
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await withLockTimeout(queryRunner, async () => {
            await queryRunner.query(`DROP INDEX "idx_chats_userIds_gin"`);
            await queryRunner.query(`DROP INDEX "idx_notifications_userId_unread"`);
        });
    }
}
