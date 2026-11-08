// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

// Partial index over the open calls ("endedAt" IS NULL). The jobs process
// filters on open calls every second (`endEmptyCalls`) and every 15 s
// (`endCallsOfGoneCallServers`), and the community and home page call lists
// do on every request; without it each of these scans the whole call history.
// Measured with 200,000 ended and 20 open calls (5 memberships each):
// `endEmptyCalls` 14.2 ms -> 0.13 ms, `endCallsOfGoneCallServers`
// 6.2 ms -> 0.08 ms. Keyed on "communityId" for the community call list.
// An index needs no GRANT (the roles' table privileges cover it).
export class OpenCallsIndex1793600000000 implements MigrationInterface {
    name = 'OpenCallsIndex1793600000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE INDEX "idx_calls_communityId_open" ON "calls" ("communityId") WHERE "endedAt" IS NULL`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "idx_calls_communityId_open"`);
    }
}
