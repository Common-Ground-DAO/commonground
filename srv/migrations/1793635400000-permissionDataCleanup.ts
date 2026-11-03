// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MigrationInterface, QueryRunner } from "typeorm";

// Data cleanup after the permission rules of the owning community (call and
// event role permissions name live roles of that community; a ban removes
// the membership in the same transaction, docs/backend `/setUserBlockState`):
// rows from before those rules that do not match them are removed.
// docs/database "Important Notes" lists the steps.
//
// 1. callpermissions: rows whose role is not a live role of the call's
//    community (role of another community, or a deleted role). Every read
//    of the table for a permission (permissions.ts, calls.ts) joins the role
//    with `r."deletedAt" IS NULL AND r."communityId" = calls."communityId"`;
//    exactly the rows outside that join go. The Admin row every call gets,
//    and every other row of a live role of the community, stay.
// 2. communities_events_permissions: the same against
//    communities_events."communityId".
// 3. communities_channels_roles_permissions and
//    communities_articles_roles_permissions: rows whose role is not a live
//    role of the row's "communityId". Channel and article writes check the
//    role ids against the community and a role's deletion removes its rows,
//    so these are rows from before those checks, if any.
// 4. Role assignments of users with an active ban (user_community_state:
//    "blockState" = 'BANNED' and "blockStateUntil" NULL or in the future, the
//    rule of `_isBanned`): what the ban's membership removal
//    (`_removeCommunityMembership` and the bot reconciliation after it) does
//    in the database, for every such user and community:
//    - all of the user's roles_users_users rows of the community's roles
//      (claimed or not, predefined or custom, live or deleted);
//    - the community leaves users."communityOrder". The trigger
//      `community_order_validation` (AFTER UPDATE on users) refuses an
//      order that does not hold exactly the user's claimed Member
//      communities, and an order can be out of step with the roles already
//      (that very trigger failing made the old ban's leave give up). So
//      the new order is built to match: the old order without the removed
//      communities, without duplicates and without communities the user
//      holds no claimed Member role of, then the claimed Member communities
//      missing from it (ordered by id). Only orders that contain a removed
//      community are written;
//    - the user's user_channel_settings rows of the community go;
//    - user_community_state."userLeftCommunity" = now();
//    - communities."memberCount" goes down by one per user who held the
//      predefined Member role (the role a join adds and counts), not below
//      0, and "updatedAt" = now();
//    - the same for the live user-owned bots of that user in the community
//      (`reconcileUserBotsForOwner`: a user-owned bot stays only where its
//      owner holds the claimed Member role).
//    `setUserBlockState` refuses to ban the community's creator and holders
//    of its claimed predefined Admin role, so those users (and their bots)
//    are left as they are. Events, socket rooms and the member list follow
//    from the database: the roles_users_users trigger notifies the member
//    list for every removed row; clients reload their communities on the
//    next connect.
//
// Each step logs how many rows it changed. A second run changes nothing.
// Custom roles are not renamed.
//
// Cost: steps 1 to 3 are one pass over their table each (anti join with
// calls/communities_events and roles, or with roles); step 4 starts from the banned rows of
// user_community_state and reaches roles_users_users through roles
// ("communityId" index) and the primary key ("userId", "roleId"). The
// statements take ROW EXCLUSIVE locks (plain writes go on) and row locks on
// what they change; every lock request waits at most LOCK_TIMEOUT, as in
// 1793635200000-chatSyncSeq, and a timeout rolls the whole migration run
// back so it can simply be repeated.
//
// Concurrent membership changes (a leave, a ban, a join after an unban while
// the deploy runs): they delete or insert the same roles_users_users rows
// and wait for this migration's row locks, so each removal is counted once —
// a leave that finds the rows gone changes neither the order nor the member
// count (its updates depend on the rows it deleted), and the member count
// update here works on the latest committed count. The membership advisory
// lock (`_lockMembership`) is not taken: one lock per banned pair, held to
// the end of the migration run, could exhaust the shared lock table on a
// large ban list, and the row locks already order these writers.
//
// Measured on the migrated schema with all triggers, 2.3M roles_users_users
// rows, 1.9M user_community_state rows (15k active bans, 1.8k of the banned
// users with an order out of step), 604k callpermissions, 155k
// communities_events_permissions, 126k channel and 251k article permission
// rows: 0.26 s, 0.06 s, 0.05 s and 2.5 s; the second run 1 s, removing
// nothing.

/** how long one lock request of this migration may wait */
const LOCK_TIMEOUT = '5s';

/** `work` with lock_timeout = LOCK_TIMEOUT, then the previous value again (both transaction-local) */
async function withLockTimeout(queryRunner: QueryRunner, work: () => Promise<void>): Promise<void> {
    const [{ previous }] = await queryRunner.query(`SELECT current_setting('lock_timeout') AS previous`);
    await queryRunner.query(`SELECT set_config('lock_timeout', $1, true)`, [LOCK_TIMEOUT]);
    await work();
    await queryRunner.query(`SELECT set_config('lock_timeout', $1, true)`, [previous]);
}

/** step 1: call permission rows outside the live roles of the call's community */
const DELETE_CALL_PERMISSIONS = `
    WITH removed AS (
        DELETE FROM "callpermissions" cp
        WHERE NOT EXISTS (
            SELECT 1
            FROM "calls" c
            INNER JOIN "roles" r
                ON  r."communityId" = c."communityId"
                AND r."deletedAt" IS NULL
            WHERE c."id" = cp."callId"
              AND r."id" = cp."roleId"
        )
        RETURNING 1
    )
    SELECT count(*)::int AS "count" FROM removed
`;

/** step 2: event permission rows outside the live roles of the event's community */
const DELETE_EVENT_PERMISSIONS = `
    WITH removed AS (
        DELETE FROM "communities_events_permissions" cep
        WHERE NOT EXISTS (
            SELECT 1
            FROM "communities_events" ce
            INNER JOIN "roles" r
                ON  r."communityId" = ce."communityId"
                AND r."deletedAt" IS NULL
            WHERE ce."id" = cep."communityEventId"
              AND r."id" = cep."roleId"
        )
        RETURNING 1
    )
    SELECT count(*)::int AS "count" FROM removed
`;

/** step 3: channel and article permission rows outside the live roles of their community */
const DELETE_CHANNEL_ARTICLE_PERMISSIONS = `
    WITH channels_removed AS (
        DELETE FROM "communities_channels_roles_permissions" ccrp
        WHERE NOT EXISTS (
            SELECT 1 FROM "roles" r
            WHERE r."id" = ccrp."roleId"
              AND r."communityId" = ccrp."communityId"
              AND r."deletedAt" IS NULL
        )
        RETURNING 1
    ),
    articles_removed AS (
        DELETE FROM "communities_articles_roles_permissions" carp
        WHERE NOT EXISTS (
            SELECT 1 FROM "roles" r
            WHERE r."id" = carp."roleId"
              AND r."communityId" = carp."communityId"
              AND r."deletedAt" IS NULL
        )
        RETURNING 1
    )
    SELECT
        (SELECT count(*)::int FROM channels_removed) AS "channels",
        (SELECT count(*)::int FROM articles_removed) AS "articles"
`;

/**
 * step 4: the memberships of users with an active ban, and of their
 * user-owned bots, in the community of the ban
 */
const REMOVE_BANNED_MEMBERSHIPS = `
    WITH banned AS (
        SELECT ucs."userId", ucs."communityId"
        FROM "user_community_state" ucs
        WHERE ucs."blockState" = 'BANNED'
          AND (ucs."blockStateUntil" > now() OR ucs."blockStateUntil" IS NULL)
          AND NOT EXISTS (
              SELECT 1 FROM "communities" c
              WHERE c."id" = ucs."communityId"
                AND c."creatorId" = ucs."userId"
          )
          AND NOT EXISTS (
              SELECT 1
              FROM "roles_users_users" ruu
              INNER JOIN "roles" r ON r."id" = ruu."roleId"
              WHERE ruu."userId" = ucs."userId"
                AND r."communityId" = ucs."communityId"
                AND r."title" = 'Admin'
                AND r."type" = 'PREDEFINED'
                AND ruu."claimed" = TRUE
          )
    ),
    targets AS (
        SELECT "userId", "communityId" FROM banned
        UNION
        SELECT b."userId", banned."communityId"
        FROM banned
        INNER JOIN "bots" b
            ON  b."ownerType" = 'user'
            AND b."ownerId" = banned."userId"
            AND b."deletedAt" IS NULL
    ),
    deleted AS (
        DELETE FROM "roles_users_users" ruu
        USING "roles" r, targets t
        WHERE r."id" = ruu."roleId"
          AND r."communityId" = t."communityId"
          AND ruu."userId" = t."userId"
        RETURNING ruu."userId", r."communityId",
            (r."type" = 'PREDEFINED' AND r."title" = 'Member') AS "memberRole"
    ),
    removed AS (
        SELECT "userId", "communityId", bool_or("memberRole") AS "wasMember"
        FROM deleted
        GROUP BY "userId", "communityId"
    ),
    order_update AS (
        UPDATE "users" u
        SET "communityOrder" = ARRAY(
            SELECT k.id
            FROM (
                -- kept: first position of each remaining Member community
                SELECT o.id, min(o.n) AS pos
                FROM unnest(u."communityOrder") WITH ORDINALITY AS o(id, n)
                WHERE o.id = ANY (p."memberOf")
                GROUP BY o.id
                UNION ALL
                -- missing: remaining Member communities not in the order
                SELECT x.id, NULL::bigint
                FROM unnest(p."memberOf") AS x(id)
                WHERE NOT EXISTS (
                    SELECT 1 FROM unnest(u."communityOrder") AS e(id) WHERE e.id = x.id
                )
            ) k
            ORDER BY k.pos NULLS LAST, k.id
        )
        FROM (
            SELECT g."userId", g."communityIds",
                -- the claimed Member communities left after this statement,
                -- as community_order_validation reads them
                ARRAY(
                    SELECT DISTINCT r."communityId"
                    FROM "roles_users_users" ruu
                    INNER JOIN "roles" r ON r."id" = ruu."roleId"
                    WHERE ruu."userId" = g."userId"
                      AND ruu."claimed" = TRUE
                      AND r."title" = 'Member'
                      AND r."type" = 'PREDEFINED'
                      AND r."communityId" <> ALL (g."communityIds")
                ) AS "memberOf"
            FROM (
                SELECT "userId", array_agg("communityId") AS "communityIds"
                FROM removed
                GROUP BY "userId"
            ) g
        ) p
        WHERE u."id" = p."userId"
          AND u."communityOrder" && p."communityIds"
        RETURNING 1
    ),
    settings_delete AS (
        DELETE FROM "user_channel_settings" s
        USING removed rm
        WHERE s."userId" = rm."userId"
          AND s."communityId" = rm."communityId"
        RETURNING 1
    ),
    state_update AS (
        UPDATE "user_community_state" s
        SET "userLeftCommunity" = now()
        FROM removed rm
        WHERE s."userId" = rm."userId"
          AND s."communityId" = rm."communityId"
        RETURNING 1
    ),
    community_update AS (
        UPDATE "communities" c
        SET "memberCount" = GREATEST(c."memberCount" - p."members", 0), "updatedAt" = now()
        FROM (
            SELECT "communityId", count(*) FILTER (WHERE "wasMember") AS "members"
            FROM removed
            GROUP BY "communityId"
        ) p
        WHERE c."id" = p."communityId"
        RETURNING 1
    )
    SELECT
        (SELECT count(*)::int FROM deleted) AS "roleAssignments",
        (SELECT count(*)::int FROM removed) AS "memberships",
        (SELECT count(*)::int FROM removed rm
            WHERE NOT EXISTS (
                SELECT 1 FROM banned bn
                WHERE bn."userId" = rm."userId" AND bn."communityId" = rm."communityId"
            )) AS "botMemberships",
        (SELECT count(*)::int FROM order_update) AS "communityOrders",
        (SELECT count(*)::int FROM settings_delete) AS "channelSettings",
        (SELECT count(*)::int FROM state_update) AS "communityStates",
        (SELECT count(*)::int FROM community_update) AS "communities"
`;

export class PermissionDataCleanup1793635400000 implements MigrationInterface {
    name = 'PermissionDataCleanup1793635400000'

    public async up(queryRunner: QueryRunner): Promise<void> {
        await withLockTimeout(queryRunner, async () => {
            const [calls] = await queryRunner.query(DELETE_CALL_PERMISSIONS);
            console.log(`PermissionDataCleanup: removed ${calls.count} callpermissions rows of roles outside the call's community or deleted roles`);
            const [events] = await queryRunner.query(DELETE_EVENT_PERMISSIONS);
            console.log(`PermissionDataCleanup: removed ${events.count} communities_events_permissions rows of roles outside the event's community or deleted roles`);
            const [channelsArticles] = await queryRunner.query(DELETE_CHANNEL_ARTICLE_PERMISSIONS);
            console.log(`PermissionDataCleanup: removed ${channelsArticles.channels} communities_channels_roles_permissions and ${channelsArticles.articles} communities_articles_roles_permissions rows of roles outside the row's community or deleted roles`);
            const [bans] = await queryRunner.query(REMOVE_BANNED_MEMBERSHIPS);
            console.log(
                `PermissionDataCleanup: removed ${bans.roleAssignments} role assignments of banned users`
                + ` (${bans.memberships} memberships, ${bans.botMemberships} of them bots of banned owners;`
                + ` ${bans.communityOrders} community orders, ${bans.channelSettings} channel settings,`
                + ` ${bans.communityStates} community states, ${bans.communities} member counts updated)`
            );
        });
    }

    public async down(_queryRunner: QueryRunner): Promise<void> {
        // Intentionally a no-op: the removed rows are not kept anywhere (a
        // restore needs a backup from before the migration), and they do not
        // match the current rules, so nothing depends on getting them back.
    }
}
