// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

// Indexes backing User/getSuggestedUsers (#84). Two hot access paths were
// structurally seq-scan-bound:
//   1. The popular fallback ORDER BY "followerCount" DESC, "id" — ran a full
//      users scan + sort on EVERY request (no matching index). Backed by a
//      partial index over the eligible set (the endpoint's exact filter).
//   2. The shared-community arm looks up members by role, but roles_users_users'
//      PK is ("userId","roleId") — "roleId" is the second column and can't drive
//      a lookup. A ("roleId","userId") composite serves both the lookup and the
//      per-community ORDER BY "userId" the bounded arm uses.
// Purely additive.
export class AddSuggestedUsersIndexes1785900000000 implements MigrationInterface {
    name = 'AddSuggestedUsersIndexes1785900000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_users_suggest_popular"
            ON "users" ("followerCount" DESC, "id")
            WHERE "deletedAt" IS NULL AND "is_bot" = FALSE AND "platformBan" IS NULL
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_roles_users_users_role_user"
            ON "roles_users_users" ("roleId", "userId")
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_roles_users_users_role_user"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_suggest_popular"`);
    }
}
