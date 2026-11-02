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
// Indexes need no GRANT (the roles' table privileges cover them).
export class SyncStateIndexes1793660400000 implements MigrationInterface {
    name = 'SyncStateIndexes1793660400000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX "idx_notifications_userId_unread" ON "notifications" ("userId") WHERE "read" = FALSE`);
        await queryRunner.query(`CREATE INDEX "idx_chats_userIds_gin" ON "chats" USING GIN ("userIds")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "idx_chats_userIds_gin"`);
        await queryRunner.query(`DROP INDEX "idx_notifications_userId_unread"`);
    }
}
