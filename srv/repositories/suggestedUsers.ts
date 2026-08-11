// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { PredefinedRole, RoleType } from "../common/enums";
import errors from "../common/errors";
import format from "pg-format";
import pool from "../util/postgres";
import { type Pool, type PoolClient } from "pg";

/* Viewer-aware suggested users ("people to discover").
 *
 * A deterministic heuristic, no ML. Candidate pool is bounded (not a full-table
 * score) = union of three sources relative to the viewer:
 *   1. members of the viewer's communities (shared-community signal)
 *   2. follow-of-follows: users followed by the people the viewer follows
 *   3. a globally-popular fallback (top by followerCount) so a viewer with a
 *      thin/empty graph still gets a meaningful, non-empty list
 * Per candidate we compute sharedCommunities + mutualFollows and fold them into
 * one integer score; the reason type is the dominant component. Ordered by
 * (score DESC, userId ASC) with a keyset cursor so pagination can't duplicate or
 * omit. Excludes the viewer, deleted/bot/platform-banned users, and users the
 * viewer already follows.
 *
 * "Shared community" is by definition a community the viewer belongs to, so the
 * reason's communityId reveals nothing the viewer's own membership doesn't
 * already expose. There is no user-to-user block relationship in the schema yet
 * (issue #55), so none is filtered; the community-scoped moderator block is
 * orthogonal to user discovery. */

// Score weights: shared communities dominate follow-of-follows, which dominate
// raw popularity. POPULARITY_CAP bounds the fallback contribution so a viral
// account can never outrank a genuine shared-community match.
const SHARED_COMMUNITY_WEIGHT = 1_000_000;
const MUTUAL_FOLLOW_WEIGHT = 1_000;
const POPULARITY_CAP = 999;
// How many globally-popular users to admit into the candidate pool as fallback.
const POPULAR_POOL_SIZE = 200;

type SuggestedUserRow = {
  userId: string;
  sharedCommunities: number;
  mutualFollows: number;
  sharedCommunityId: string | null;
  score: string; // node-pg returns the bigint score as a string
};

type SuggestedCursor = {
  score: number;
  userId: string;
};

function encodeCursor(cursor: SuggestedCursor): string {
  return Buffer.from(JSON.stringify(cursor), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function decodeCursor(value: string | undefined): SuggestedCursor | null {
  if (!value) return null;
  try {
    const padded = value.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(value.length / 4) * 4, '=');
    const parsed = JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as Partial<SuggestedCursor>;
    if (typeof parsed.score !== 'number' || !Number.isFinite(parsed.score) || typeof parsed.userId !== 'string') {
      throw new Error('invalid cursor');
    }
    return { score: parsed.score, userId: parsed.userId };
  } catch {
    throw new Error(errors.server.INVALID_REQUEST);
  }
}

async function _getSuggestedUsers(
  db: Pool | PoolClient,
  userId: string,
  data: API.User.getSuggestedUsers.Request,
): Promise<API.User.getSuggestedUsers.Response> {
  const cursor = decodeCursor(data.cursor);
  const limit = +data.limit;

  // A confirmed-member row: the predefined Member role of a community, claimed.
  const memberRole = `
    r."title" = ${format('%L', PredefinedRole.Member)}
    AND r."type" = ${format('%L', RoleType.PREDEFINED)}
    AND r."deletedAt" IS NULL
  `;

  const query = `
    WITH viewer_communities AS (
      SELECT DISTINCT r."communityId"
      FROM roles_users_users ruu
      INNER JOIN roles r ON r."id" = ruu."roleId"
      WHERE ruu."userId" = ${format('%L::uuid', userId)}
        AND ruu.claimed = TRUE
        AND ${memberRole}
    ),
    viewer_follows AS (
      SELECT f."otherUserId" AS "userId"
      FROM followers f
      WHERE f."userId" = ${format('%L::uuid', userId)}
        AND f."deletedAt" IS NULL
    ),
    -- 1. Shared-community candidates: members of the viewer's communities, with
    -- how many communities they share and one representative shared community.
    shared AS (
      SELECT ruu."userId" AS "userId",
        COUNT(DISTINCT r."communityId")::int AS "sharedCommunities",
        MIN(r."communityId"::text) AS "sharedCommunityId"
      FROM roles_users_users ruu
      INNER JOIN roles r ON r."id" = ruu."roleId"
      INNER JOIN viewer_communities vc ON vc."communityId" = r."communityId"
      WHERE ruu.claimed = TRUE
        AND ${memberRole}
      GROUP BY ruu."userId"
    ),
    -- 2. Follow-of-follows: users followed by the people the viewer follows,
    -- and by how many of them.
    fof AS (
      SELECT f2."otherUserId" AS "userId",
        COUNT(DISTINCT f2."userId")::int AS "mutualFollows"
      FROM followers f2
      INNER JOIN viewer_follows vf ON vf."userId" = f2."userId"
      WHERE f2."deletedAt" IS NULL
      GROUP BY f2."otherUserId"
    ),
    -- 3. Globally-popular fallback pool.
    popular AS (
      SELECT u."id" AS "userId"
      FROM users u
      WHERE u."deletedAt" IS NULL
        AND u."is_bot" = FALSE
        AND u."platformBan" IS NULL
      ORDER BY u."followerCount" DESC, u."id" ASC
      LIMIT ${POPULAR_POOL_SIZE}
    ),
    candidates AS (
      SELECT "userId" FROM shared
      UNION
      SELECT "userId" FROM fof
      UNION
      SELECT "userId" FROM popular
    ),
    scored AS (
      SELECT
        c."userId" AS "userId",
        COALESCE(s."sharedCommunities", 0) AS "sharedCommunities",
        COALESCE(fo."mutualFollows", 0) AS "mutualFollows",
        s."sharedCommunityId" AS "sharedCommunityId",
        (
          COALESCE(s."sharedCommunities", 0)::bigint * ${SHARED_COMMUNITY_WEIGHT}
          + COALESCE(fo."mutualFollows", 0)::bigint * ${MUTUAL_FOLLOW_WEIGHT}
          + LEAST(u."followerCount", ${POPULARITY_CAP})
        ) AS "score"
      FROM candidates c
      INNER JOIN users u ON u."id" = c."userId"
      LEFT JOIN shared s ON s."userId" = c."userId"
      LEFT JOIN fof fo ON fo."userId" = c."userId"
      WHERE c."userId" <> ${format('%L::uuid', userId)}
        AND u."deletedAt" IS NULL
        AND u."is_bot" = FALSE
        AND u."platformBan" IS NULL
        -- Don't re-suggest people the viewer already follows.
        AND NOT EXISTS (
          SELECT 1 FROM followers f3
          WHERE f3."userId" = ${format('%L::uuid', userId)}
            AND f3."otherUserId" = c."userId"
            AND f3."deletedAt" IS NULL
        )
    )
    SELECT "userId", "sharedCommunities", "mutualFollows", "sharedCommunityId", "score"
    FROM scored
    ${cursor
      // Mixed-direction keyset: score DESC, userId ASC. A row-value tuple
      // comparison would be wrong here (it assumes both columns sort the same
      // way), so spell out the tiebreak: strictly-lower score, or same score
      // and a later userId.
      ? format(
          'WHERE ("score" < %L::bigint OR ("score" = %L::bigint AND "userId" > %L::uuid))',
          cursor.score, cursor.score, cursor.userId,
        )
      : ''}
    ORDER BY "score" DESC, "userId" ASC
    LIMIT ${limit + 1}
  `;

  const result = await db.query<SuggestedUserRow>(query);
  const rows = result.rows;
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;

  const users = page.map((row): API.User.getSuggestedUsers.SuggestedUser => {
    let reason: API.User.getSuggestedUsers.SuggestionReason;
    if (row.sharedCommunities > 0) {
      reason = {
        type: 'sharedCommunity',
        mutualCount: row.sharedCommunities,
        ...(row.sharedCommunityId ? { communityId: row.sharedCommunityId } : {}),
      };
    } else if (row.mutualFollows > 0) {
      reason = { type: 'followedByFollowing', mutualCount: row.mutualFollows };
    } else {
      reason = { type: 'popular' };
    }
    return { userId: row.userId, reason };
  });

  const last = page[page.length - 1];
  const nextCursor = hasMore && last
    ? encodeCursor({ score: Number(last.score), userId: last.userId })
    : null;

  return { users, nextCursor };
}

class SuggestedUsersHelper {
  public async getSuggestedUsers(
    userId: string,
    data: API.User.getSuggestedUsers.Request,
  ): Promise<API.User.getSuggestedUsers.Response> {
    return _getSuggestedUsers(pool, userId, data);
  }
}

const suggestedUsersHelper = new SuggestedUsersHelper();
export default suggestedUsersHelper;
