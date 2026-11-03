// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

// The call server decides who may join a call's room
// (`callHelper.hasPermissionToJoinCall`): the call's community must not be
// deleted, and a join through the community's Public role is refused for
// users banned from the community. Its role `mediasoup` therefore reads, column
// by column, only what that check needs: communities ("id", "deletedAt") and
// user_community_state ("userId", "communityId", "blockState",
// "blockStateUntil"). Skipped where the role does not exist.
const GRANTS: [table: string, columns: string[]][] = [
    ['communities', ['id', 'deletedAt']],
    ['user_community_state', ['userId', 'communityId', 'blockState', 'blockStateUntil']],
];

const columnList = (columns: string[]) => columns.map(c => `"${c}"`).join(', ');

export class MediasoupCallJoinGrants1793635300000 implements MigrationInterface {
    name = 'MediasoupCallJoinGrants1793635300000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        for (const [table, columns] of GRANTS) {
            await queryRunner.query(`
                DO $do$ BEGIN
                    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mediasoup') THEN
                        GRANT SELECT (${columnList(columns)}) ON "${table}" TO mediasoup;
                    END IF;
                END $do$
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        for (const [table, columns] of GRANTS) {
            await queryRunner.query(`
                DO $do$ BEGIN
                    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'mediasoup') THEN
                        REVOKE SELECT (${columnList(columns)}) ON "${table}" FROM mediasoup;
                    END IF;
                END $do$
            `);
        }
    }
}
