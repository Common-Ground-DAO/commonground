// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

// The unified post feed (Feed/getPostList) orders each publication arm by
// (published DESC, articleId DESC) with a LIMIT before the union. These
// composite indexes back that per-arm sort+limit so cursor paging stays cheap
// as the tables grow. Partial on non-deleted rows, which the feed always filters
// to. Purely additive.
export class AddFeedPublishedIndexes1785700000000 implements MigrationInterface {
    name = 'AddFeedPublishedIndexes1785700000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_users_articles_feed"
            ON "users_articles" ("published" DESC, "articleId" DESC)
            WHERE "deletedAt" IS NULL
        `);
        await queryRunner.query(`
            CREATE INDEX IF NOT EXISTS "idx_communities_articles_feed"
            ON "communities_articles" ("published" DESC, "articleId" DESC)
            WHERE "deletedAt" IS NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_communities_articles_feed"`);
        await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_articles_feed"`);
    }
}
