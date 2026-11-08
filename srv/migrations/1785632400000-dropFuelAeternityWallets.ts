// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Eradicates the Fuel and Aeternity wallet types.
 *
 * Phase 3 of the core-slimming roadmap removed the two login/connect flows but
 * deliberately kept the stored rows and the enum values. On 2026-08-01 the
 * maintainer reversed that: nothing in the codebase can read, write, verify or
 * display a `fuel`/`aeternity` wallet anymore, so the rows are deleted and the
 * values leave `wallets_type_enum`.
 *
 * Order matters — `wallet_balances` references `wallets` with ON DELETE CASCADE,
 * so its rows go with their wallet; the enum can only be recreated once no row
 * carries a dropped value. The `wallet_update_notify` trigger fires on INSERT and
 * UPDATE only, so the deletes raise no notifications.
 *
 * `down()` restores the enum exactly as `1709302144464-addContractWallets` left
 * it, including the default and the two unique constraints that reference the
 * column. It restores the **type only**: the deleted rows are not recoverable
 * from the migration and have to come from a backup (same call as the Phase-2
 * wizard drop — the maintainer accepts this, database backups cover it).
 */
export class DropFuelAeternityWallets1785632400000 implements MigrationInterface {
    name = 'DropFuelAeternityWallets1785632400000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DELETE FROM "wallets" WHERE "type" IN ('fuel', 'aeternity')`);

        await queryRunner.query(`ALTER TABLE "wallets" DROP CONSTRAINT "UQ_275edb0f56444cba7f583a30387"`);
        await queryRunner.query(`ALTER TABLE "wallets" DROP CONSTRAINT "UQ_7e6f9c225f82ece575c20b13223"`);
        await queryRunner.query(`ALTER TYPE "public"."wallets_type_enum" RENAME TO "wallets_type_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."wallets_type_enum" AS ENUM('cg_evm', 'evm', 'contract_evm')`);
        await queryRunner.query(`ALTER TABLE "wallets" ALTER COLUMN "type" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "wallets" ALTER COLUMN "type" TYPE "public"."wallets_type_enum" USING "type"::"text"::"public"."wallets_type_enum"`);
        await queryRunner.query(`ALTER TABLE "wallets" ALTER COLUMN "type" SET DEFAULT 'evm'`);
        await queryRunner.query(`DROP TYPE "public"."wallets_type_enum_old"`);
        await queryRunner.query(`ALTER TABLE "wallets" ADD CONSTRAINT "UQ_275edb0f56444cba7f583a30387" UNIQUE ("type", "walletIdentifier", "chain")`);
        await queryRunner.query(`ALTER TABLE "wallets" ADD CONSTRAINT "UQ_7e6f9c225f82ece575c20b13223" UNIQUE ("type", "walletIdentifier")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Schema only — the deleted `fuel`/`aeternity` rows are gone for good and
        // have to be restored from a database backup.
        await queryRunner.query(`ALTER TABLE "wallets" DROP CONSTRAINT "UQ_275edb0f56444cba7f583a30387"`);
        await queryRunner.query(`ALTER TABLE "wallets" DROP CONSTRAINT "UQ_7e6f9c225f82ece575c20b13223"`);
        await queryRunner.query(`ALTER TYPE "public"."wallets_type_enum" RENAME TO "wallets_type_enum_old"`);
        await queryRunner.query(`CREATE TYPE "public"."wallets_type_enum" AS ENUM('cg_evm', 'evm', 'fuel', 'aeternity', 'contract_evm')`);
        await queryRunner.query(`ALTER TABLE "wallets" ALTER COLUMN "type" DROP DEFAULT`);
        await queryRunner.query(`ALTER TABLE "wallets" ALTER COLUMN "type" TYPE "public"."wallets_type_enum" USING "type"::"text"::"public"."wallets_type_enum"`);
        await queryRunner.query(`ALTER TABLE "wallets" ALTER COLUMN "type" SET DEFAULT 'evm'`);
        await queryRunner.query(`DROP TYPE "public"."wallets_type_enum_old"`);
        await queryRunner.query(`ALTER TABLE "wallets" ADD CONSTRAINT "UQ_275edb0f56444cba7f583a30387" UNIQUE ("type", "walletIdentifier", "chain")`);
        await queryRunner.query(`ALTER TABLE "wallets" ADD CONSTRAINT "UQ_7e6f9c225f82ece575c20b13223" UNIQUE ("type", "walletIdentifier")`);
    }
}
