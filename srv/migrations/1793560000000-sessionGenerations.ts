// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

// Session generations (docs/auth-identity §2, "Signing out other devices"):
// - "session_generation_seq": one sequence for all generations. A login takes
//   the next value when it starts; signing out the other devices raises
//   users."sessionGeneration" to the next value, in the same transaction as
//   the change that caused it.
// - devices."generation", transfer_tokens."generation": the generation the
//   key or link was created with; valid only while not below the user's.
//   Existing rows get 0 and stay valid until the account's first sign-out of
//   other devices.
// - session_generation_of(user): the user's generation for every backend
//   role (the call server's role may not read users).
export class SessionGenerations1793560000000 implements MigrationInterface {
    name = 'SessionGenerations1793560000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE SEQUENCE "session_generation_seq" AS bigint START WITH 1`);
        await queryRunner.query(`GRANT USAGE, SELECT, UPDATE ON SEQUENCE "session_generation_seq" TO writer`);
        await queryRunner.query(`GRANT SELECT ON SEQUENCE "session_generation_seq" TO reader`);

        await queryRunner.query(`ALTER TABLE "users" ADD "sessionGeneration" bigint NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "devices" ADD "generation" bigint NOT NULL DEFAULT 0`);
        await queryRunner.query(`ALTER TABLE "transfer_tokens" ADD "generation" bigint NOT NULL DEFAULT 0`);
        await queryRunner.query(`CREATE INDEX "idx_users_sessionGeneration" ON "users" ("sessionGeneration") WHERE "sessionGeneration" > 0`);

        await queryRunner.query(`
            CREATE FUNCTION session_generation_of(p_user_id uuid)
            RETURNS bigint
            LANGUAGE sql
            STABLE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $fn$
                SELECT COALESCE((SELECT u."sessionGeneration" FROM public.users u WHERE u."id" = p_user_id), 0)
            $fn$
        `);
        await queryRunner.query(`REVOKE ALL ON FUNCTION session_generation_of(uuid) FROM PUBLIC`);
        for (const role of ['writer', 'reader', 'mediasoup']) {
            await queryRunner.query(`
                DO $do$ BEGIN
                    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
                        GRANT EXECUTE ON FUNCTION session_generation_of(uuid) TO ${role};
                    END IF;
                END $do$
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP FUNCTION session_generation_of(uuid)`);
        await queryRunner.query(`DROP INDEX "idx_users_sessionGeneration"`);
        await queryRunner.query(`ALTER TABLE "transfer_tokens" DROP COLUMN "generation"`);
        await queryRunner.query(`ALTER TABLE "devices" DROP COLUMN "generation"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "sessionGeneration"`);
        await queryRunner.query(`DROP SEQUENCE "session_generation_seq"`);
    }
}
