// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

// Permanent bounces reported by the selfhost mail relay (entities/email-bounces.ts,
// docs/email-notifications "Bounces").
export class AddEmailBounces1793453486482 implements MigrationInterface {
    name = 'AddEmailBounces1793453486482'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "email_bounces" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "address" character varying(320) NOT NULL, "reportId" character varying(255) NOT NULL, "status" character varying(16) NOT NULL, "diagnostic" character varying(500), "senderSide" boolean NOT NULL DEFAULT false, "createdAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), CONSTRAINT "UQ_email_bounces_report_address" UNIQUE ("reportId", "address"), CONSTRAINT "PK_405bc9e9551cb7ec8f04204a100" PRIMARY KEY ("id"))`);
        // per-address history (bounce policy) and time-window scans (burst
        // detection, retention cleanup)
        await queryRunner.query(`CREATE INDEX "idx_email_bounces_address_createdAt" ON "email_bounces" ("address", "createdAt")`);
        await queryRunner.query(`CREATE INDEX "idx_email_bounces_createdAt" ON "email_bounces" ("createdAt")`);

        await queryRunner.query(`GRANT ALL PRIVILEGES ON "email_bounces" TO writer`);
        await queryRunner.query(`GRANT SELECT ON "email_bounces" TO reader`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE "email_bounces"`);
    }
}
