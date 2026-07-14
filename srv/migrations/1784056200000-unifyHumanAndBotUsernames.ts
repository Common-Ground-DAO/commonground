// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

export class UnifyHumanAndBotUsernames1784056200000 implements MigrationInterface {
    name = 'UnifyHumanAndBotUsernames1784056200000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "idx_user_accounts_bot_unique_displayName"`);
        await queryRunner.query(`DROP INDEX "idx_user_accounts_cg_unique_displayName"`);

        // Bot accounts were still using free-form display names before launch.
        // Convert them to valid usernames and deterministically suffix any name
        // that conflicts with a human or another normalized bot username.
        await queryRunner.query(`
            DO $$
            DECLARE
                account RECORD;
                base_username text;
                candidate text;
                suffix text;
                attempt integer;
            BEGIN
                FOR account IN
                    SELECT ua."userId", ua."displayName"
                    FROM user_accounts ua
                    WHERE ua.type = 'bot'
                    ORDER BY ua."createdAt", ua."userId"
                LOOP
                    candidate := regexp_replace(account."displayName", '[^a-zA-Z0-9_-]+', '-', 'g');
                    candidate := btrim(candidate, '-_');
                    candidate := left(candidate, 30);
                    IF length(candidate) < 3 THEN
                        candidate := 'bot-' || left(replace(account."userId"::text, '-', ''), 8);
                    END IF;
                    base_username := candidate;
                    attempt := 0;

                    WHILE EXISTS (
                        SELECT 1
                        FROM user_accounts existing
                        WHERE existing.type IN ('cg', 'bot')
                          AND LOWER(existing."displayName") = LOWER(candidate)
                          AND NOT (
                            existing."userId" = account."userId"
                            AND existing.type = 'bot'
                          )
                    ) LOOP
                        attempt := attempt + 1;
                        suffix := '-' || left(md5(account."userId"::text || ':' || attempt::text), 6);
                        candidate := left(base_username, 30 - length(suffix)) || suffix;
                    END LOOP;

                    UPDATE user_accounts
                    SET "displayName" = candidate, "updatedAt" = now()
                    WHERE "userId" = account."userId" AND type = 'bot';
                END LOOP;
            END $$
        `);

        await queryRunner.query(`
            CREATE UNIQUE INDEX "idx_user_accounts_principal_unique_username"
            ON user_accounts (LOWER("displayName"))
            WHERE type IN ('cg', 'bot') AND "displayName" <> ''
        `);
    }

    public async down(queryRunner: QueryRunner): Promise<void> {
        await queryRunner.query(`DROP INDEX "idx_user_accounts_principal_unique_username"`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_user_accounts_cg_unique_displayName" ON user_accounts (
            (CASE WHEN "type" = 'cg' THEN 'cg' ELSE NULL END),
            (CASE WHEN "type" = 'cg' AND "displayName" <> '' THEN LOWER("displayName") ELSE NULL END)
        )`);
        await queryRunner.query(`CREATE UNIQUE INDEX "idx_user_accounts_bot_unique_displayName" ON user_accounts (
            (CASE WHEN "type" = 'bot' THEN 'bot' ELSE NULL END),
            (CASE WHEN "type" = 'bot' AND "displayName" <> '' THEN LOWER("displayName") ELSE NULL END)
        )`);
    }
}
