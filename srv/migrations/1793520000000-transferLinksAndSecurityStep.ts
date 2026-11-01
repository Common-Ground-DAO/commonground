// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

// Transfer links and the account-security step (docs/auth-identity §11):
// - "transfer_tokens": one-time sign-in links from another instance on the
//   same database (the app.cg gateway) to this one; only a SHA-256 hash of the
//   token is stored (entities/transfer-tokens.ts).
// - users."passwordChangeRequired": set when a password that does not meet
//   the password policy signs in; the account then has to choose a new one.
// - security_step_db_required(user, rpId): the database part of the
//   account-security step for the realtime servers (EXECUTE only, no table
//   access for the call server's role).
// - users."verificationCode"/"verificationCodeExpiration" are dropped: login
//   codes and email-verification codes are short-lived, single-use and live
//   in Valkey now (srv/util/emailCodes.ts), bound to the address they were
//   sent to. Codes stored here are discarded.
export class TransferLinksAndSecurityStep1793520000000 implements MigrationInterface {
    name = 'TransferLinksAndSecurityStep1793520000000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`CREATE TABLE "transfer_tokens" (
            "id" uuid NOT NULL DEFAULT gen_random_uuid(),
            "userId" uuid NOT NULL,
            "tokenHash" character(64) NOT NULL,
            "nextPath" character varying(2048),
            "createdAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL DEFAULT now(),
            "expiresAt" TIMESTAMP(3) WITH TIME ZONE NOT NULL,
            "usedAt" TIMESTAMP(3) WITH TIME ZONE,
            CONSTRAINT "PK_transfer_tokens_id" PRIMARY KEY ("id"),
            CONSTRAINT "UQ_transfer_tokens_tokenHash" UNIQUE ("tokenHash")
        )`);
        await queryRunner.query(`ALTER TABLE "transfer_tokens" ADD CONSTRAINT "FK_transfer_tokens_userId" FOREIGN KEY ("userId") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE NO ACTION`);
        await queryRunner.query(`CREATE INDEX "idx_transfer_tokens_userId" ON "transfer_tokens" ("userId")`);
        await queryRunner.query(`CREATE INDEX "idx_transfer_tokens_expiresAt" ON "transfer_tokens" ("expiresAt")`);
        await queryRunner.query(`GRANT ALL PRIVILEGES ON "transfer_tokens" TO writer`);
        await queryRunner.query(`GRANT SELECT ON "transfer_tokens" TO reader`);

        await queryRunner.query(`ALTER TABLE "users" ADD "passwordChangeRequired" boolean NOT NULL DEFAULT false`);

        await queryRunner.query(`DROP INDEX IF EXISTS "idx_users_verification_codes"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "verificationCodeExpiration"`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "verificationCode"`);

        // The realtime servers check the database part of the account-security
        // step (srv/util/securityStep.ts) through this function: the call
        // server's role may not read users, passkeys or wallets, and gets
        // nothing but this yes/no answer. true = the account must finish the
        // step (or does not exist / is a bot / is deleted).
        await queryRunner.query(`
            CREATE FUNCTION security_step_db_required(p_user_id uuid, p_rp_id text)
            RETURNS boolean
            LANGUAGE sql
            STABLE
            SECURITY DEFINER
            SET search_path = pg_catalog, public, pg_temp
            AS $fn$
                SELECT COALESCE((
                    SELECT
                        (
                            (SELECT COUNT(*) FROM public.passkeys p
                              WHERE p."userId" = u."id" AND p."rpId" = p_rp_id AND p."deletedAt" IS NULL)
                            + (CASE WHEN u."password" IS NOT NULL THEN 1 ELSE 0 END)
                            + (SELECT COUNT(*) FROM public.wallets w
                              WHERE w."userId" = u."id" AND w."type" = 'evm' AND w."loginEnabled" = TRUE AND w."deletedAt" IS NULL)
                        ) = 0
                        OR (u."password" IS NOT NULL AND u."passwordChangeRequired")
                    FROM public.users u
                    WHERE u."id" = p_user_id AND u."deletedAt" IS NULL AND u.is_bot = FALSE
                ), TRUE)
            $fn$
        `);
        await queryRunner.query(`REVOKE ALL ON FUNCTION security_step_db_required(uuid, text) FROM PUBLIC`);
        for (const role of ['writer', 'reader', 'mediasoup']) {
            await queryRunner.query(`
                DO $do$ BEGIN
                    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
                        GRANT EXECUTE ON FUNCTION security_step_db_required(uuid, text) TO ${role};
                    END IF;
                END $do$
            `);
        }
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP FUNCTION security_step_db_required(uuid, text)`);
        await queryRunner.query(`ALTER TABLE "users" ADD "verificationCode" character varying(32)`);
        await queryRunner.query(`ALTER TABLE "users" ADD "verificationCodeExpiration" TIMESTAMP(3) WITH TIME ZONE`);
        await queryRunner.query(`CREATE INDEX "idx_users_verification_codes" ON "users" ("verificationCode")`);
        await queryRunner.query(`ALTER TABLE "users" DROP COLUMN "passwordChangeRequired"`);
        await queryRunner.query(`DROP TABLE "transfer_tokens"`);
    }
}
