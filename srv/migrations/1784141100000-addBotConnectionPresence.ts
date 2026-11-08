// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

export class AddBotConnectionPresence1784141100000 implements MigrationInterface {
    name = 'AddBotConnectionPresence1784141100000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "bots" ADD "connectedSocketCount" integer NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "bots" ADD "lastConnectedAt" TIMESTAMP(3) WITH TIME ZONE`);
        await queryRunner.query(`ALTER TABLE "bots" ADD CONSTRAINT "CHK_bots_connectedSocketCount" CHECK ("connectedSocketCount" >= 0)`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "bots" DROP CONSTRAINT "CHK_bots_connectedSocketCount"`);
        await queryRunner.query(`ALTER TABLE "bots" DROP COLUMN "lastConnectedAt"`);
        await queryRunner.query(`ALTER TABLE "bots" DROP COLUMN "connectedSocketCount"`);
    }
}
