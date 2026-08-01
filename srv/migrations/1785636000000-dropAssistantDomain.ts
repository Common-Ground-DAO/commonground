// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Drops the AI-assistant domain: the two tables `assistant_dialogs` and
 * `assistant_availability` together with the `AssistantDialog`/`AssistantModel`
 * entities, the dedicated `assistant` process, its queue and every route that
 * fed them (see the accompanying commits).
 *
 * Like the Phase-2 wizard drop this is a **real** drop including the stored
 * rows — the maintainer decided on 2026-08-01 to remove the assistant outright
 * (its role will be filled by a bot integration), and database backups cover
 * auditability. No other table is touched: the assistant only ever *read* core
 * tables, and the only foreign keys point *out* of `assistant_dialogs` into
 * `users` and `communities`, so nothing depends on either table.
 *
 * `down()` restores the schema exactly as the three creating migrations left it
 * — `1738856821267-addAssistantDialog`, `1742985062426-assistantDialogModel`
 * and `1743775203719-assistantAvailability` — including the constraint/index
 * names, the two foreign keys with ON DELETE CASCADE and the reader/writer
 * grants. It restores the **schema only**; the rows are gone and have to come
 * from a backup.
 */
export class DropAssistantDomain1785636000000 implements MigrationInterface {
    name = 'DropAssistantDomain1785636000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP TABLE IF EXISTS "assistant_dialogs"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "assistant_availability"`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        // Schema only — the dropped rows have to be restored from a backup.
        await queryRunner.query(`CREATE TABLE "assistant_dialogs" ("id" uuid NOT NULL DEFAULT gen_random_uuid(), "request" jsonb NOT NULL, "userId" uuid NOT NULL, "communityId" uuid, "title" character varying(255), "createdAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "updatedAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(), "model" character varying(255) NOT NULL, CONSTRAINT "PK_e51a2b174abf1d88746f414a6b3" PRIMARY KEY ("id"))`);
        await queryRunner.query(`CREATE INDEX "IDX_2842388c3bdd5dec94a7e61fd0" ON "assistant_dialogs" ("userId") `);
        await queryRunner.query(`CREATE INDEX "IDX_d12afab5acd2a0a4c87ee1dd72" ON "assistant_dialogs" ("communityId") `);
        await queryRunner.query(`ALTER TABLE "assistant_dialogs" ADD CONSTRAINT "FK_2842388c3bdd5dec94a7e61fd09" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`ALTER TABLE "assistant_dialogs" ADD CONSTRAINT "FK_d12afab5acd2a0a4c87ee1dd721" FOREIGN KEY ("communityId") REFERENCES "communities"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);

        await queryRunner.query(`CREATE TABLE "assistant_availability" ("modelName" character varying(255) NOT NULL, "title" character varying(255) NOT NULL, "isAvailable" boolean NOT NULL DEFAULT false, "domain" character varying(255) NOT NULL, "order" integer NOT NULL DEFAULT '0', "extraData" jsonb, CONSTRAINT "PK_3f2808c2ff179095137103203d2" PRIMARY KEY ("modelName"))`);

        await queryRunner.query(`GRANT ALL PRIVILEGES ON "assistant_dialogs" TO writer`);
        await queryRunner.query(`GRANT ALL PRIVILEGES ON "assistant_availability" TO writer`);
        await queryRunner.query(`GRANT SELECT ON "assistant_dialogs" TO reader`);
        await queryRunner.query(`GRANT SELECT ON "assistant_availability" TO reader`);
    }
}
