// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

// Passkeys on the main origin (docs/auth-identity §7): every credential records
// the WebAuthn relying party (RP ID) it was registered for, and each process
// only offers and accepts credentials of its own RP ID. A NULL "rpId" matches
// no relying party at all.
//
// Backfill: rows that still carry the registration options in
// data.debugData get the RP ID from there. If two rows would end up with the
// same (rpId, credentialID) — the old unique index was keyed on the user
// handle instead — only one is backfilled (owned before ownerless, live before
// deleted, then the most recent); the others keep NULL and stay unusable
// rather than ambiguous.
export class PasskeyRelyingParty1793480000000 implements MigrationInterface {
    name = 'PasskeyRelyingParty1793480000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`ALTER TABLE "passkeys" ADD "rpId" text`);
        await queryRunner.query(`ALTER TABLE "passkeys" ADD "origin" text`);
        await queryRunner.query(`ALTER TABLE "passkeys" ADD "name" text`);
        await queryRunner.query(`ALTER TABLE "passkeys" ADD "lastUsedAt" TIMESTAMP(3) WITH TIME ZONE`);

        await queryRunner.query(`
            UPDATE "passkeys" p
            SET "rpId" = ranked."rpId"
            FROM (
                SELECT
                    "id",
                    "data"#>>'{debugData,registrationOptions,rp,id}' AS "rpId",
                    row_number() OVER (
                        PARTITION BY "data"#>>'{debugData,registrationOptions,rp,id}', "data"->>'credentialID'
                        ORDER BY ("userId" IS NOT NULL) DESC, ("deletedAt" IS NULL) DESC, "updatedAt" DESC, "id"
                    ) AS "rank"
                FROM "passkeys"
            ) ranked
            WHERE p."id" = ranked."id"
              AND ranked."rank" = 1
              AND ranked."rpId" IS NOT NULL
        `);

        await queryRunner.query(`CREATE UNIQUE INDEX "IDX_passkeys_rpId_credentialID" ON "passkeys" ("rpId", ("data"->>'credentialID'))`);
        // the stable per-account user handle is looked up by (userId, rpId)
        await queryRunner.query(`CREATE INDEX "IDX_passkeys_userId_rpId" ON "passkeys" ("userId", "rpId")`);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "IDX_passkeys_userId_rpId"`);
        await queryRunner.query(`DROP INDEX "IDX_passkeys_rpId_credentialID"`);
        await queryRunner.query(`ALTER TABLE "passkeys" DROP COLUMN "lastUsedAt"`);
        await queryRunner.query(`ALTER TABLE "passkeys" DROP COLUMN "name"`);
        await queryRunner.query(`ALTER TABLE "passkeys" DROP COLUMN "origin"`);
        await queryRunner.query(`ALTER TABLE "passkeys" DROP COLUMN "rpId"`);
    }
}
