// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

export class AddBotTokens1784040170000 implements MigrationInterface {
    name = 'AddBotTokens1784040170000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "bot_tokens" (
            "id" uuid NOT NULL DEFAULT gen_random_uuid(),
            "botUserId" uuid NOT NULL,
            "tokenHash" char(64) NOT NULL,
            "name" varchar(100),
            "lastUsedAt" TIMESTAMP(3) WITH TIME ZONE,
            "createdAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
            "revokedAt" TIMESTAMP(3) WITH TIME ZONE,
            CONSTRAINT "PK_bot_tokens_id" PRIMARY KEY ("id"),
            CONSTRAINT "UQ_bot_tokens_tokenHash" UNIQUE ("tokenHash")
        )`);
        await queryRunner.query(`CREATE INDEX "idx_bot_tokens_active_bot" ON "bot_tokens" ("botUserId") WHERE "revokedAt" IS NULL`);
        await queryRunner.query(`ALTER TABLE "bot_tokens" ADD CONSTRAINT "FK_bot_tokens_botUserId" FOREIGN KEY ("botUserId") REFERENCES "bots"("userId") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`GRANT ALL PRIVILEGES ON "bot_tokens" TO writer`);
        await queryRunner.query(`GRANT SELECT ON "bot_tokens" TO reader`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "bot_tokens" DROP CONSTRAINT "FK_bot_tokens_botUserId"`);
        await queryRunner.query(`DROP INDEX "public"."idx_bot_tokens_active_bot"`);
        await queryRunner.query(`DROP TABLE "bot_tokens"`);
    }
}
