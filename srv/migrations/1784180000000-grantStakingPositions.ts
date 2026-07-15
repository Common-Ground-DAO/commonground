// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

export class GrantStakingPositions1784180000000 implements MigrationInterface {
    name = 'GrantStakingPositions1784180000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // 1784170800000-addStakingPositions created the table without the
        // runtime grants the app roles need (api/jobs connect as writer,
        // readers as reader) — every query failed with permission denied.
        await queryRunner.query(`GRANT ALL PRIVILEGES ON "staking_positions" TO writer`);
        await queryRunner.query(`GRANT SELECT ON "staking_positions" TO reader`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`REVOKE ALL PRIVILEGES ON "staking_positions" FROM writer`);
        await queryRunner.query(`REVOKE SELECT ON "staking_positions" FROM reader`);
    }
}
