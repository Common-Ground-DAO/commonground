// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

/**
 * Drops the never-finished feeds domain (`feeds`, `feeditems`, `communities_feeds`,
 * `communities_feeds_roles_permissions`) together with the `Feed`/`FeedItem`/
 * `CommunityFeed`/`CommunityFeedRolePermissions` entities, which had been fully
 * commented out in `srv/entities/feeds.ts` and `srv/entities/communities-feeds.ts`.
 *
 * Finding while writing this migration: **no migration in `srv/migrations/` ever
 * created these tables** (verified with a case-insensitive grep for "feed" over the
 * whole migration folder, including `1648214442313-initdb`), and the commented
 * entities referenced a `PermissionType` enum that does not exist anywhere in the
 * codebase — i.e. the feature never got past a sketch. On every database that was
 * provisioned through migrations (`synchronize` is and was `false`) the four tables
 * therefore do not exist and this migration is a no-op; the `IF EXISTS` guards exist
 * only for hypothetical legacy instances whose schema was created by hand.
 *
 * `down` is intentionally a no-op: there is no original schema to restore. Since the
 * tables were never created by a migration, re-creating them here would invent a
 * schema (in particular a permissions enum whose values never existed) rather than
 * restore one. The historical entity sketches remain available in git history.
 */
export class DropFeedsDomain1785542400000 implements MigrationInterface {
    name = 'DropFeedsDomain1785542400000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        // FK-safe order: permissions -> community link -> items -> feeds
        await queryRunner.query(`DROP TABLE IF EXISTS "communities_feeds_roles_permissions"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "communities_feeds"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "feeditems"`);
        await queryRunner.query(`DROP TABLE IF EXISTS "feeds"`);
        await queryRunner.query(`DROP TYPE IF EXISTS "public"."communities_feeds_roles_permissions_permissions_enum"`);
    }

    public async down(): Promise<void> {
        // Intentionally empty, see the class comment above.
    }
}
