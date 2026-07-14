// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

export class AddBotAccountsFoundation1784037142000 implements MigrationInterface {
    name = 'AddBotAccountsFoundation1784037142000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "users" ADD "is_bot" boolean NOT NULL DEFAULT false`);

        // Follow the existing account-enum migration pattern. Recreating the
        // enums lets this migration use 'bot' in an index in the same transaction.
        await queryRunner.query(`DROP INDEX "idx_user_accounts_type_id"`);
        await queryRunner.query(`DROP INDEX "idx_user_accounts_type_lower_id"`);
        await queryRunner.query(`DROP INDEX "idx_user_accounts_cg_unique_displayName"`);
        await queryRunner.query(`ALTER TYPE "public"."user_accounts_type_enum" RENAME TO "user_accounts_type_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."user_accounts_type_enum" AS ENUM('twitter', 'lukso', 'cg', 'farcaster', 'bot')`);
        await queryRunner.query(`ALTER TABLE "user_accounts" ALTER COLUMN "type" TYPE "public"."user_accounts_type_enum" USING "type"::"text"::"public"."user_accounts_type_enum"`);
        await queryRunner.query(`DROP TYPE "public"."user_accounts_type_enum_old"`);
        await queryRunner.query(`ALTER TYPE "public"."users_displayaccount_enum" RENAME TO "users_displayaccount_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."users_displayaccount_enum" AS ENUM('twitter', 'lukso', 'cg', 'farcaster', 'bot')`);
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "displayAccount" TYPE "public"."users_displayaccount_enum" USING "displayAccount"::"text"::"public"."users_displayaccount_enum"`);
        await queryRunner.query(`DROP TYPE "public"."users_displayaccount_enum_old"`);
        await queryRunner.query(`CREATE INDEX "idx_user_accounts_type_id" ON "user_accounts" ("type", (data->>'id'))`);
        await queryRunner.query(`CREATE INDEX "idx_user_accounts_type_lower_id" ON "user_accounts" ("type", LOWER("data"->>'id'))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_user_accounts_cg_unique_displayName" ON user_accounts (
            (CASE WHEN "type" = 'cg' THEN 'cg' ELSE NULL END),
            (CASE WHEN "type" = 'cg' AND "displayName" <> '' THEN LOWER("displayName") ELSE NULL END)
        )`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_user_accounts_bot_unique_displayName" ON user_accounts (
            (CASE WHEN "type" = 'bot' THEN 'bot' ELSE NULL END),
            (CASE WHEN "type" = 'bot' AND "displayName" <> '' THEN LOWER("displayName") ELSE NULL END)
        )`);

        await queryRunner.query(`CREATE TYPE "public"."bots_ownertype_enum" AS ENUM('community', 'user', 'platform')`);
        await queryRunner.query(`CREATE TABLE "bots" (
            "userId" uuid NOT NULL,
            "deviceId" uuid NOT NULL,
            "ownerType" "public"."bots_ownertype_enum" NOT NULL,
            "ownerId" uuid,
            "description" text,
            "createdAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
            "updatedAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
            "deletedAt" TIMESTAMP(3) WITH TIME ZONE,
            CONSTRAINT "PK_bots_userId" PRIMARY KEY ("userId"),
            CONSTRAINT "UQ_bots_deviceId" UNIQUE ("deviceId"),
            CONSTRAINT "CHK_bots_owner" CHECK (
                ("ownerType" = 'platform' AND "ownerId" IS NULL)
                OR ("ownerType" IN ('community', 'user') AND "ownerId" IS NOT NULL)
            )
        )`);
        await queryRunner.query(`CREATE INDEX "idx_bots_active_owner" ON "bots" ("ownerType", "ownerId") WHERE "deletedAt" IS NULL`);
        await queryRunner.query(`CREATE INDEX "IDX_bots_deletedAt" ON "bots" ("deletedAt")`);
        await queryRunner.query(`ALTER TABLE "bots" ADD CONSTRAINT "FK_bots_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "bots" ADD CONSTRAINT "FK_bots_deviceId" FOREIGN KEY ("deviceId") REFERENCES "devices"("id") ON DELETE NO ACTION ON UPDATE NO ACTION`);

        await queryRunner.query(`GRANT ALL PRIVILEGES ON "bots" TO writer`);
        await queryRunner.query(`GRANT SELECT ON "bots" TO reader`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "bots" DROP CONSTRAINT "FK_bots_deviceId"`);
        await queryRunner.query(`ALTER TABLE "bots" DROP CONSTRAINT "FK_bots_userId"`);
        await queryRunner.query(`DROP INDEX "public"."IDX_bots_deletedAt"`);
        await queryRunner.query(`DROP INDEX "public"."idx_bots_active_owner"`);
        await queryRunner.query(`DROP TABLE "bots"`);
        await queryRunner.query(`DROP TYPE "public"."bots_ownertype_enum"`);

        await queryRunner.query(`DROP INDEX "idx_user_accounts_bot_unique_displayName"`);
        await queryRunner.query(`DROP INDEX "idx_user_accounts_type_id"`);
        await queryRunner.query(`DROP INDEX "idx_user_accounts_type_lower_id"`);
        await queryRunner.query(`DROP INDEX "idx_user_accounts_cg_unique_displayName"`);
        await queryRunner.query(`CREATE TYPE "public"."users_displayaccount_enum_old" AS ENUM('twitter', 'lukso', 'cg', 'farcaster')`);
        await queryRunner.query(`ALTER TABLE "users" ALTER COLUMN "displayAccount" TYPE "public"."users_displayaccount_enum_old" USING "displayAccount"::"text"::"public"."users_displayaccount_enum_old"`);
        await queryRunner.query(`DROP TYPE "public"."users_displayaccount_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."users_displayaccount_enum_old" RENAME TO "users_displayaccount_enum"`);
        await queryRunner.query(`CREATE TYPE "public"."user_accounts_type_enum_old" AS ENUM('twitter', 'lukso', 'cg', 'farcaster')`);
        await queryRunner.query(`ALTER TABLE "user_accounts" ALTER COLUMN "type" TYPE "public"."user_accounts_type_enum_old" USING "type"::"text"::"public"."user_accounts_type_enum_old"`);
        await queryRunner.query(`DROP TYPE "public"."user_accounts_type_enum"`);
        await queryRunner.query(`ALTER TYPE "public"."user_accounts_type_enum_old" RENAME TO "user_accounts_type_enum"`);
        await queryRunner.query(`CREATE INDEX "idx_user_accounts_type_id" ON "user_accounts" ("type", (data->>'id'))`);
        await queryRunner.query(`CREATE INDEX "idx_user_accounts_type_lower_id" ON "user_accounts" ("type", LOWER("data"->>'id'))`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_user_accounts_cg_unique_displayName" ON user_accounts (
            (CASE WHEN "type" = 'cg' THEN 'cg' ELSE NULL END),
            (CASE WHEN "type" = 'cg' AND "displayName" <> '' THEN LOWER("displayName") ELSE NULL END)
        )`);

        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "is_bot"`);
    }
}
