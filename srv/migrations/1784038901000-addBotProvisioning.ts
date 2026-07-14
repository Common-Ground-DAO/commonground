// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

export class AddBotProvisioning1784038901000 implements MigrationInterface {
    name = 'AddBotProvisioning1784038901000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "communities" ADD "allowUserBots" boolean NOT NULL DEFAULT false`);
        await queryRunner.query(`CREATE TYPE "public"."bots_platformpresencemode_enum" AS ENUM('all', 'selected')`);
        await queryRunner.query(`ALTER TABLE "bots" ADD "platformPresenceMode" "public"."bots_platformpresencemode_enum"`);
        await queryRunner.query(`UPDATE "bots" SET "platformPresenceMode" = 'selected' WHERE "ownerType" = 'platform'`);
        await queryRunner.query(`ALTER TABLE "bots" DROP CONSTRAINT "CHK_bots_owner"`);
        await queryRunner.query(`ALTER TABLE "bots" ADD CONSTRAINT "CHK_bots_owner" CHECK (
            ("ownerType" = 'platform' AND "ownerId" IS NULL AND "platformPresenceMode" IS NOT NULL)
            OR ("ownerType" IN ('community', 'user') AND "ownerId" IS NOT NULL AND "platformPresenceMode" IS NULL)
        )`);
        await queryRunner.query(`CREATE TABLE "bots_platform_communities" (
            "botUserId" uuid NOT NULL,
            "communityId" uuid NOT NULL,
            CONSTRAINT "PK_bots_platform_communities" PRIMARY KEY ("botUserId", "communityId")
        )`);
        await queryRunner.query(`CREATE INDEX "idx_bots_platform_communities_community" ON "bots_platform_communities" ("communityId", "botUserId")`);
        await queryRunner.query(`ALTER TABLE "bots_platform_communities" ADD CONSTRAINT "FK_bots_platform_communities_bot" FOREIGN KEY ("botUserId") REFERENCES "bots"("userId") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "bots_platform_communities" ADD CONSTRAINT "FK_bots_platform_communities_community" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`GRANT ALL PRIVILEGES ON "bots_platform_communities" TO writer`);
        await queryRunner.query(`GRANT SELECT ON "bots_platform_communities" TO reader`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "bots_platform_communities" DROP CONSTRAINT "FK_bots_platform_communities_community"`);
        await queryRunner.query(`ALTER TABLE "bots_platform_communities" DROP CONSTRAINT "FK_bots_platform_communities_bot"`);
        await queryRunner.query(`DROP INDEX "public"."idx_bots_platform_communities_community"`);
        await queryRunner.query(`DROP TABLE "bots_platform_communities"`);
        await queryRunner.query(`ALTER TABLE "bots" DROP CONSTRAINT "CHK_bots_owner"`);
        await queryRunner.query(`ALTER TABLE "bots" ADD CONSTRAINT "CHK_bots_owner" CHECK (
            ("ownerType" = 'platform' AND "ownerId" IS NULL)
            OR ("ownerType" IN ('community', 'user') AND "ownerId" IS NOT NULL)
        )`);
        await queryRunner.query(`ALTER TABLE "bots" DROP COLUMN "platformPresenceMode"`);
        await queryRunner.query(`DROP TYPE "public"."bots_platformpresencemode_enum"`);
        await queryRunner.query(`ALTER TABLE "communities" DROP COLUMN "allowUserBots"`);
    }
}
