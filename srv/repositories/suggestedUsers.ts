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
 * A deterministic heuristic, no ML. Candidate pool is PROVABLY BOUNDED (not a
 * full-table score, and not an unbounded aggregation over the viewer's graph)
 * = union of three sources relative to the viewer:
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
 * SCALE BOUNDING (#84): the two graph-driven arms are hard-capped BEFORE scoring
 * so a viewer in a huge community — or following broad-graph accounts — can't
 * make a small request process a large intermediate set:
 *   - only the viewer's MAX_VIEWER_COMMUNITIES smallest communities are
 *     considered (small shared communities are also higher-signal than a
 *     100k-member one), and at most MAX_MEMBERS_PER_COMMUNITY members are
 *     sampled from each (deterministically, by userId);
 *   - only MAX_VIEWER_FOLLOWS of the viewer's follows are considered, and at
 *     most MAX_FOLLOWS_PER_FOLLOWEE follows are sampled from each;
 *   - each arm's grouped output is then capped to CANDIDATE_CAP.
 * So the scored pool is <= 2*CANDIDATE_CAP + POPULAR_POOL_SIZE rows regardless
 * of graph size. Every cap has a deterministic ORDER BY, so the keyset-paged
 * sequence stays stable. The trade-off — the arms SAMPLE rather than exhaust a
 * very large community/follow graph — is acceptable for discovery and invisible
 * within normal graph sizes.
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
// Per-arm input bounds (see SCALE BOUNDING above). Products bound the rows each
// arm feeds into aggregation: shared <= 50*100, fof <= 100*100.
const MAX_VIEWER_COMMUNITIES = 50;
const MAX_MEMBERS_PER_COMMUNITY = 100;
const MAX_VIEWER_FOLLOWS = 100;
const MAX_FOLLOWS_PER_FOLLOWEE = 100;
// Cap on each graph arm's grouped candidate output before the union.
const CANDIDATE_CAP = 500;

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
      -- The viewer's smallest communities, capped. Small shared communities are
      -- both cheaper and higher-signal than a huge one everyone is in.
      SELECT r."communityId"
      FROM roles_users_users ruu
      INNER JOIN roles r ON r."id" = ruu."roleId"
      INNER JOIN communities c ON c."id" = r."communityId"
      WHERE ruu."userId" = ${format('%L::uuid', userId)}
        AND ruu.claimed = TRUE
        AND ${memberRole}
        AND c."deletedAt" IS NULL
      ORDER BY c."memberCount" ASC, r."communityId" ASC
      LIMIT ${MAX_VIEWER_COMMUNITIES}
    ),
    -- Bounded per-community member sample (deterministic by userId), so one huge
    -- community can't blow up the shared aggregation input.
    shared_raw AS (
      SELECT vc."communityId", m."userId"
      FROM viewer_communities vc
      CROSS JOIN LATERAL (
        SELECT ruu2."userId"
        FROM roles_users_users ruu2
        INNER JOIN roles r2 ON r2."id" = ruu2."roleId"
        WHERE r2."communityId" = vc."communityId"
          AND ruu2.claimed = TRUE
          AND r2."title" = ${format('%L', PredefinedRole.Member)}
          AND r2."type" = ${format('%L', RoleType.PREDEFINED)}
          AND r2."deletedAt" IS NULL
        ORDER BY ruu2."userId" ASC
        LIMIT ${MAX_MEMBERS_PER_COMMUNITY}
      ) m
    ),
    -- 1. Shared-community candidates: members of the viewer's communities, with
    -- how many communities they share and one representative shared community.
    shared AS (
      SELECT "userId",
        COUNT(DISTINCT "communityId")::int AS "sharedCommunities",
        MIN("communityId"::text) AS "sharedCommunityId"
      FROM shared_raw
      GROUP BY "userId"
      ORDER BY COUNT(DISTINCT "communityId") DESC, "userId" ASC
      LIMIT ${CANDIDATE_CAP}
    ),
    viewer_follows AS (
      SELECT f."otherUserId" AS "userId"
      FROM followers f
      WHERE f."userId" = ${format('%L::uuid', userId)}
        AND f."deletedAt" IS NULL
      ORDER BY f."otherUserId" ASC
      LIMIT ${MAX_VIEWER_FOLLOWS}
    ),
    -- Bounded per-followee sample so a followed broad-graph account can't blow
    -- up the follow-of-follows input.
    fof_raw AS (
      SELECT vf."userId" AS "viaUserId", ff."userId"
      FROM viewer_follows vf
      CROSS JOIN LATERAL (
        SELECT f2."otherUserId" AS "userId"
        FROM followers f2
        WHERE f2."userId" = vf."userId"
          AND f2."deletedAt" IS NULL
        ORDER BY f2."otherUserId" ASC
        LIMIT ${MAX_FOLLOWS_PER_FOLLOWEE}
      ) ff
    ),
    -- 2. Follow-of-follows: users followed by the people the viewer follows,
    -- and by how many of them.
    fof AS (
      SELECT "userId",
        COUNT(DISTINCT "viaUserId")::int AS "mutualFollows"
      FROM fof_raw
      GROUP BY "userId"
      ORDER BY COUNT(DISTINCT "viaUserId") DESC, "userId" ASC
      LIMIT ${CANDIDATE_CAP}
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
