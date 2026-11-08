// SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md
import { MigrationInterface, QueryRunner } from "typeorm";

export class TransferPasskeySetup1794147976044 implements MigrationInterface {
    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE transfer_tokens ADD COLUMN "passkeySetupRpId" text`);
    }
    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE transfer_tokens DROP COLUMN "passkeySetupRpId"`);
    }
}
