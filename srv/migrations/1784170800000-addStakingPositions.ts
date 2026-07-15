// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

export class AddStakingPositions1784170800000 implements MigrationInterface {
    name = 'AddStakingPositions1784170800000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`
            CREATE TABLE "staking_positions" (
                "id" uuid NOT NULL DEFAULT gen_random_uuid(),
                "chain" character varying(64) NOT NULL,
                "contractAddress" character varying(50) NOT NULL,
                "walletAddress" character varying(50) NOT NULL,
                "positionId" bigint NOT NULL,
                "userId" uuid,
                "amount" numeric(39,0) NOT NULL,
                "stakedAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
                "unlockAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
                "unstakedAt" TIMESTAMP(3) WITH TIME ZONE,
                "stakeTxHash" character varying(80) NOT NULL,
                "stakeLogIndex" integer NOT NULL,
                "unstakeTxHash" character varying(80),
                "accruedThroughDay" date,
                "accruedSpark" bigint NOT NULL DEFAULT 0,
                "createdAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
                "updatedAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
                CONSTRAINT "PK_staking_positions" PRIMARY KEY ("id"),
                CONSTRAINT "UQ_staking_positions_onchain_identity"
                    UNIQUE ("chain", "contractAddress", "walletAddress", "positionId"),
                CONSTRAINT "UQ_staking_positions_stake_log"
                    UNIQUE ("chain", "stakeTxHash", "stakeLogIndex"),
                CONSTRAINT "FK_staking_positions_user"
                    FOREIGN KEY ("userId") REFERENCES users(id)
                    ON DELETE SET NULL ON UPDATE NO ACTION,
                CONSTRAINT "CHK_staking_positions_amount" CHECK ("amount" > 0)
            )
        `);
        await queryRunner.query(`
            CREATE INDEX "idx_staking_positions_userId"
            ON "staking_positions" ("userId") WHERE "userId" IS NOT NULL
        `);
        await queryRunner.query(`
            CREATE INDEX "idx_staking_positions_unclaimed_wallet"
            ON "staking_positions" ("walletAddress") WHERE "userId" IS NULL
        `);
        await queryRunner.query(`
            CREATE INDEX "idx_staking_positions_accrual_scan"
            ON "staking_positions" ("accruedThroughDay")
            WHERE "userId" IS NOT NULL
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "staking_positions"`);
    }
}
