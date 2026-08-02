// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Drops the investor-wizard domain: the five `wizard*` tables together with the
 * `Wizard`/`WizardRolePermission`/`WizardClaimableCode`/`WizardUserData`/
 * `WizardInvestmentData` entities and every route, repository method and UI that
 * fed them (see the accompanying commit).
 *
 * Unlike the Phase-1 feeds drop this is a **real** drop including the stored rows:
 * exactly one live community had a seeded wizard, and the maintainer decided on
 * 2026-08-01 to drop the domain outright — database backups cover auditability.
 * The `communities` table is deliberately untouched: the only foreign key between
 * the two is `wizards."communityId" -> communities(id)`, nothing points back, so
 * dropping the wizard tables leaves every community intact.
 *
 * `down()` restores the schema exactly as the four creating migrations left it —
 * `1728331452133-addWizardAndReferral`, `1728922885440-addWizardInvestTracking`,
 * `1728999528471-updateWizardInvestedEntity` and `1729016580931-fixWizardUserData`
 * — including the constraint/index names, the reader/writer grants and the fixed
 * `wizard_user_data.wizardId` foreign key. It restores the **schema only**; the
 * rows are gone and have to come from a backup.
 */
export class DropWizardDomain1785628800000 implements MigrationInterface {
    name = 'DropWizardDomain1785628800000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // FK-safe order: dependants first, `wizards` last
        await queryRunner.query(`DROP TABLE IF EXISTS "wizard_investment_data"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "wizard_user_data"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "wizard_claimable_codes"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "wizard_role_permission"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "wizards"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "wizards" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "communityId" uuid NOT NULL, "data" jsonb NOT NULL DEFAULT '{}', "createdAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "deletedAt" TIMESTAMP(3) WITH TIME ZONE, CONSTRAINT "PK_43fa31c5e4373f99c125656d863" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_6914de5d161733e0f394cc57bb" ON "wizards" ("deletedAt") `);
        await queryRunner.query(`CREATE TABLE "wizard_role_permission" ("wizardId" uuid NOT NULL, "roleId" uuid NOT NULL, CONSTRAINT "PK_31ab50af6c10df120fd9cabb83b" PRIMARY KEY ("wizardId", "roleId"))`);
        await queryRunner.query(`CREATE TABLE "wizard_claimable_codes" ("wizardId" uuid NOT NULL, "code" character varying(32) NOT NULL, "claimedBy" uuid, "createdBy" uuid, CONSTRAINT "PK_b42ecf8906d6a01cda3986de2ee" PRIMARY KEY ("wizardId", "code"))`);
        await queryRunner.query(`CREATE TABLE "wizard_user_data" ("userId" uuid NOT NULL, "wizardId" uuid NOT NULL, "data" jsonb NOT NULL, "createdAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "PK_d3c7cbe90709228ed8efa3c61c4" PRIMARY KEY ("userId", "wizardId"))`);
        await queryRunner.query(`CREATE TABLE "wizard_investment_data" ("wizardId" uuid NOT NULL, "userId" uuid NOT NULL, "chain" character varying(32) NOT NULL, "fromAddress" character varying(64) NOT NULL, "toAddress" character varying(64) NOT NULL, "amount" character varying(128) NOT NULL, "txHash" character varying(128) NOT NULL, "createdAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "target" character varying(32) NOT NULL, CONSTRAINT "PK_5db5caf30d198bb315eeca707a8" PRIMARY KEY ("txHash", "target"))`);
        await queryRunner.query(`CREATE INDEX "IDX_5dfd0ffeb5e93665830f24fe8d" ON "wizard_investment_data" ("fromAddress") `);
        await queryRunner.query(`CREATE INDEX "IDX_b53501f55ae589ee2faa2bcaee" ON "wizard_investment_data" ("toAddress") `);

        await queryRunner.query(`ALTER TABLE "wizards" ADD CONSTRAINT "FK_52dd061c36d7817d80e9e33a5d7" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "wizard_role_permission" ADD CONSTRAINT "FK_f33d22aacc87a89202800af813f" FOREIGN KEY ("wizardId") REFERENCES "wizards"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "wizard_role_permission" ADD CONSTRAINT "FK_269010e965f71a327b56eba384e" FOREIGN KEY ("roleId") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "wizard_claimable_codes" ADD CONSTRAINT "FK_1ef11bdc1dcda7934a751178279" FOREIGN KEY ("wizardId") REFERENCES "wizards"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "wizard_claimable_codes" ADD CONSTRAINT "FK_333787d0d6b5fe57ed1544baac8" FOREIGN KEY ("claimedBy") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "wizard_claimable_codes" ADD CONSTRAINT "FK_8dad02df8fd6af248694e010f0c" FOREIGN KEY ("createdBy") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "wizard_user_data" ADD CONSTRAINT "FK_da61af35def417f2960bcd4d16c" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        // note: points at "wizards", as corrected by 1729016580931-fixWizardUserData
        await queryRunner.query(`ALTER TABLE "wizard_user_data" ADD CONSTRAINT "FK_722d0d41ee2342146bf8cbc46b2" FOREIGN KEY ("wizardId") REFERENCES "wizards"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "wizard_investment_data" ADD CONSTRAINT "FK_ac3c3cf733d16d4933c36acaca2" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "wizard_investment_data" ADD CONSTRAINT "FK_2de9f191bfb12d495c958f0cc6d" FOREIGN KEY ("wizardId") REFERENCES "wizards"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        await queryRunner.query(`GRANT ALL PRIVILEGES ON "wizards" TO writer`);
        await queryRunner.query(`GRANT ALL PRIVILEGES ON "wizard_role_permission" TO writer`);
        await queryRunner.query(`GRANT ALL PRIVILEGES ON "wizard_claimable_codes" TO writer`);
        await queryRunner.query(`GRANT ALL PRIVILEGES ON "wizard_user_data" TO writer`);
        await queryRunner.query(`GRANT ALL PRIVILEGES ON "wizard_investment_data" TO writer`);
        await queryRunner.query(`GRANT SELECT ON "wizards" TO reader`);
        await queryRunner.query(`GRANT SELECT ON "wizard_role_permission" TO reader`);
        await queryRunner.query(`GRANT SELECT ON "wizard_claimable_codes" TO reader`);
        await queryRunner.query(`GRANT SELECT ON "wizard_user_data" TO reader`);
        await queryRunner.query(`GRANT SELECT ON "wizard_investment_data" TO reader`);
    }
}
