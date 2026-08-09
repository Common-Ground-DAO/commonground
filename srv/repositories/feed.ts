// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { ArticlePermission, CommunityPermission, CommunityPremiumFeatureName, PredefinedRole, RoleType } from "../common/enums";
import format from "pg-format";
import pool from "../util/postgres";
import { type Pool, type PoolClient } from "pg";
import { normalizePost } from "./feedContent";

/* Unified user/community post feed.
 *
 * A server-side UNION ALL of two publication tables that share the `articles`
 * core: users_articles (user posts) and communities_articles (community posts).
 * Each arm keeps its own authorization predicate — user posts are public by
 * publication; community posts are gated by role/permission (ARTICLE_PREVIEW for
 * the public role, or a role the viewer holds). The arms are ordered and LIMITed
 * independently, unioned, then ordered by one (publishedAt, postId) tuple and
 * LIMITed again — this is the single ordering domain a mixed timeline needs, so
 * the client pages with one cursor instead of merging two.
 *
 * Two-phase: the inner union selects only (kind, articleId, communityId,
 * actorUserId, published) so pagination stays cheap; the outer query enriches
 * just the <=limit selected rows (article body, actor, creator, comment count,
 * viewer permissions). Body/media projection happens in JS (normalizePost). */

type FeedRow = {
  kind: 'user' | 'community';
  articleId: string;
  communityId: string | null;
  published: string;
  editedAt: string | null;
  content: Models.BaseArticle.Content | null;
  headerImageId: string | null;
  thumbnailImageId: string | null;
  // actor
  actorId: string;
  actorName: string | null;
  actorImageId: string | null;
  actorUrl: string | null;
  // creator (community posts only)
  creatorId: string | null;
  creatorName: string | null;
  creatorImageId: string | null;
  commentCount: number;
  canEdit: boolean;
  canDelete: boolean;
  canComment: boolean;
};

// The cursor predicate for one arm's timestamp/id columns. Newest-first only:
// pages walk strictly before the { publishedAt, postId } cursor.
function beforeClause(alias: string, before: { publishedAt: string; postId: string } | undefined): string {
  if (!before) return '';
  return format(
    `AND (${alias}."published" < %L::timestamptz OR (${alias}."published" = %L::timestamptz AND ${alias}."articleId" < %L::uuid))`,
    before.publishedAt, before.publishedAt, before.postId,
  );
}

function topicsClause(before: string[] | undefined): string {
  if (!before || before.length === 0) return '';
  return format('AND a."tags" && ARRAY[%L]::text[]', before);
}

// The user-post arm of the union, or null when it should contribute nothing
// (e.g. following scope with no logged-in user).
//
// NOTE: `verification` does not filter user posts. User-actor verification is
// not currently modeled in the schema (the former Fractal-ID column was
// removed), so there is no signal to gate on — user posts always appear
// regardless of the verification value. The filter is meaningful only for the
// community arm (premium). A client wanting strictly verified actors can pair
// verification:'verified' with actorTypes:['community'].
function buildUserArm(userId: string | undefined, data: API.Feed.getPostList.Request): string | null {
  const following = data.scope === 'following';
  if (following && !userId) return null;

  return `
    SELECT
      'user'::text AS "kind",
      ua."articleId" AS "articleId",
      NULL::uuid AS "communityId",
      ua."userId" AS "actorUserId",
      ua."published" AS "published"
    FROM users_articles ua
    INNER JOIN articles a ON ua."articleId" = a."id"
    ${following ? format(`INNER JOIN followers f ON f."otherUserId" = ua."userId" AND f."userId" = %L::uuid`, userId) : ''}
    WHERE ua."deletedAt" IS NULL
      AND ua."published" < now()
      ${beforeClause('ua', data.before)}
      ${topicsClause(data.topics)}
    ORDER BY ua."published" DESC, ua."articleId" DESC
    LIMIT ${+data.limit}
  `;
}

// The community-post arm of the union, or null when it should contribute nothing.
function buildCommunityArm(userId: string | undefined, data: API.Feed.getPostList.Request): string | null {
  const following = data.scope === 'following';
  if (following && !userId) return null;

  const needsPremium = data.verification === 'verified' || data.verification === 'unverified';

  // Membership defines community following (agreed in #74): the viewer holds a
  // claimed Member role in the community.
  const membershipClause = following
    ? `AND EXISTS (
         SELECT 1
         FROM roles r3
         INNER JOIN roles_users_users ruu2 ON ruu2."roleId" = r3."id"
         WHERE r3."communityId" = ca."communityId"
           AND r3."title" = ${format('%L', PredefinedRole.Member)}
           AND r3."type" = ${format('%L', RoleType.PREDEFINED)}
           AND ruu2."userId" = ${format('%L::uuid', userId)}
           AND ruu2.claimed = TRUE
       )`
    : '';

  return `
    SELECT
      'community'::text AS "kind",
      ca."articleId" AS "articleId",
      ca."communityId" AS "communityId",
      NULL::uuid AS "actorUserId",
      ca."published" AS "published"
    FROM communities_articles ca
    INNER JOIN communities_articles_roles_permissions carp
      ON ca."communityId" = carp."communityId" AND ca."articleId" = carp."articleId"
    INNER JOIN roles r ON carp."roleId" = r."id" AND r."deletedAt" IS NULL
    INNER JOIN articles a ON carp."articleId" = a."id"
    ${needsPremium ? `LEFT JOIN LATERAL (
      SELECT "activeUntil"
      FROM communities_premium
      WHERE "featureName" = ANY(ARRAY[${format('%L', [CommunityPremiumFeatureName.BASIC, CommunityPremiumFeatureName.PRO, CommunityPremiumFeatureName.ENTERPRISE])}]::"public"."communities_premium_featurename_enum"[])
        AND "communityId" = ca."communityId"
      ORDER BY "activeUntil" DESC
      LIMIT 1
    ) cpr ON TRUE` : ''}
    ${userId ? `LEFT JOIN roles_users_users ruu ON (r."id" = ruu."roleId" AND ruu.claimed = TRUE)` : ''}
    WHERE (
        ${userId ? format('ruu."userId" = %L::uuid OR', userId) : ''}
        (r."title" = ${format('%L', PredefinedRole.Public)} AND r."type" = ${format('%L', RoleType.PREDEFINED)})
      )
      ${membershipClause}
      ${data.verification === 'verified' ? 'AND cpr."activeUntil" >= now()' : ''}
      ${data.verification === 'unverified' ? 'AND (cpr."activeUntil" < now() OR cpr."activeUntil" IS NULL)' : ''}
      AND ca."deletedAt" IS NULL
      AND ca."published" < now()
      AND carp."permissions" @> ${format(
        'ARRAY[%L]::"public"."communities_articles_roles_permissions_permissions_enum"[]',
        ArticlePermission.ARTICLE_PREVIEW,
      )}
      ${beforeClause('ca', data.before)}
      ${topicsClause(data.topics)}
    GROUP BY ca."articleId", ca."communityId", ca."published"
    ORDER BY ca."published" DESC, ca."articleId" DESC
    LIMIT ${+data.limit}
  `;
}

async function _getPostList(
  db: Pool | PoolClient,
  userId: string | undefined,
  data: API.Feed.getPostList.Request,
): Promise<API.Feed.getPostList.Response> {
  const wantUser = !data.actorTypes || data.actorTypes.includes('user');
  const wantCommunity = !data.actorTypes || data.actorTypes.includes('community');

  const arms = [
    wantUser ? buildUserArm(userId, data) : null,
    wantCommunity ? buildCommunityArm(userId, data) : null,
  ].filter((arm): arm is string => arm !== null);

  if (arms.length === 0) return [];

  const me = userId ? format('%L::uuid', userId) : 'NULL::uuid';

  // Viewer permission expressions, evaluated only over the <=limit page rows.
  const canManage = userId
    ? `EXISTS (
        SELECT 1 FROM roles_users_users ruu_e
        INNER JOIN roles r_e ON r_e."id" = ruu_e."roleId" AND r_e."deletedAt" IS NULL
        WHERE ruu_e."userId" = ${me} AND ruu_e.claimed = TRUE
          AND r_e."communityId" = page."communityId"
          AND r_e."permissions" @> ${format('ARRAY[%L]::"public"."roles_permissions_enum"[]', CommunityPermission.COMMUNITY_MANAGE_ARTICLES)}
      )`
    : 'FALSE';

  const canEditExpr = userId
    ? `CASE WHEN page."kind" = 'user' THEN (page."actorUserId" = ${me}) ELSE ${canManage} END`
    : 'FALSE';

  // Community comment gate: the article grants ARTICLE_READ to the public role or
  // to a role the viewer holds. User posts: any logged-in user may comment.
  const canCommentCommunity = `EXISTS (
      SELECT 1 FROM communities_articles_roles_permissions carp_c
      INNER JOIN roles r_c ON r_c."id" = carp_c."roleId" AND r_c."deletedAt" IS NULL
      LEFT JOIN roles_users_users ruu_c
        ON ruu_c."roleId" = r_c."id" AND ruu_c.claimed = TRUE AND ruu_c."userId" = ${me}
      WHERE carp_c."communityId" = page."communityId" AND carp_c."articleId" = page."articleId"
        AND carp_c."permissions" @> ${format('ARRAY[%L]::"public"."communities_articles_roles_permissions_permissions_enum"[]', ArticlePermission.ARTICLE_READ)}
        AND (
          (r_c."title" = ${format('%L', PredefinedRole.Public)} AND r_c."type" = ${format('%L', RoleType.PREDEFINED)})
          OR ruu_c."userId" IS NOT NULL
        )
    )`;
  const canCommentExpr = `CASE WHEN page."kind" = 'user' THEN ${userId ? 'TRUE' : 'FALSE'} ELSE ${canCommentCommunity} END`;

  const query = `
    WITH page AS (
      SELECT "kind", "articleId", "communityId", "actorUserId", "published"
      FROM (
        ${arms.map(arm => `(${arm})`).join('\n        UNION ALL\n        ')}
      ) unioned
      ORDER BY "published" DESC, "articleId" DESC
      LIMIT ${+data.limit}
    )
    SELECT
      page."kind" AS "kind",
      page."articleId" AS "articleId",
      page."communityId" AS "communityId",
      page."published" AS "published",
      -- Edit tracking is not modeled: article.updatedAt bumps on publish and on
      -- backdated/scheduled publishing, so it can't distinguish an edit from a
      -- normal publish. Reserved as null in v1 rather than emit a misleading
      -- timestamp.
      NULL::timestamptz AS "editedAt",
      a."content" AS "content",
      a."headerImageId" AS "headerImageId",
      a."thumbnailImageId" AS "thumbnailImageId",
      COALESCE(page."communityId", page."actorUserId") AS "actorId",
      CASE WHEN page."kind" = 'community' THEN c."title" ELSE actor_ua."displayName" END AS "actorName",
      CASE WHEN page."kind" = 'community' THEN c."logoSmallId" ELSE actor_ua."imageId" END AS "actorImageId",
      CASE WHEN page."kind" = 'community' THEN c."url" ELSE NULL END AS "actorUrl",
      CASE WHEN page."kind" = 'community' THEN a."creatorId" ELSE NULL END AS "creatorId",
      CASE WHEN page."kind" = 'community' THEN creator_ua."displayName" ELSE NULL END AS "creatorName",
      CASE WHEN page."kind" = 'community' THEN creator_ua."imageId" ELSE NULL END AS "creatorImageId",
      (
        SELECT COUNT(*)::int
        FROM messages m
        WHERE m."channelId" = a."channelId" AND m."deletedAt" IS NULL
      ) AS "commentCount",
      ${canEditExpr} AS "canEdit",
      ${canEditExpr} AS "canDelete",
      ${canCommentExpr} AS "canComment"
    FROM page
    INNER JOIN articles a ON a."id" = page."articleId"
    LEFT JOIN communities c ON page."kind" = 'community' AND c."id" = page."communityId"
    LEFT JOIN users actor_u ON page."kind" = 'user' AND actor_u."id" = page."actorUserId"
    LEFT JOIN user_accounts actor_ua
      ON page."kind" = 'user' AND actor_ua."userId" = page."actorUserId" AND actor_ua."type"::text = actor_u."displayAccount"::text
    LEFT JOIN users creator_u ON page."kind" = 'community' AND creator_u."id" = a."creatorId"
    LEFT JOIN user_accounts creator_ua
      ON page."kind" = 'community' AND creator_ua."userId" = a."creatorId" AND creator_ua."type"::text = creator_u."displayAccount"::text
    ORDER BY page."published" DESC, page."articleId" DESC
  `;

  const result = await db.query<FeedRow>(query);

  return result.rows.map((row): Models.Feed.Post => {
    const { bodyPreview, isTruncated, media } = normalizePost(row.content, row.headerImageId, row.thumbnailImageId);
    return {
      postId: row.articleId,
      kind: row.kind,
      actor: {
        id: row.actorId,
        name: row.actorName ?? '',
        imageId: row.actorImageId,
        url: row.actorUrl,
      },
      creator: row.kind === 'community' && row.creatorId
        ? { userId: row.creatorId, displayName: row.creatorName ?? '', imageId: row.creatorImageId }
        : null,
      publishedAt: row.published,
      editedAt: row.editedAt,
      bodyPreview,
      isTruncated,
      media,
      commentCount: row.commentCount,
      // Deferred for v1: a canonical web permalink follows once post routes are
      // finalized. Clients navigate by postId + kind + actor.id.
      permalink: null,
      viewer: {
        canEdit: row.canEdit,
        canDelete: row.canDelete,
        canComment: row.canComment,
      },
    };
  });
}

class FeedHelper {
  public async getPostList(
    userId: string | undefined,
    data: API.Feed.getPostList.Request,
  ): Promise<API.Feed.getPostList.Response> {
    return _getPostList(pool, userId, data);
  }
}

const feedHelper = new FeedHelper();
export default feedHelper;
