// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { ArticlePermission, CommunityPermission, CommunityPremiumFeatureName, PredefinedRole, RoleType } from "../common/enums";
import errors from "../common/errors";
import format from "pg-format";
import communityHelper from "./communities";
import emailHelper from "./emails";
import emailUtils from "../api/emails";
import { rolePermissionPresets } from "../common/presets";
import pool from "../util/postgres";
import { type Pool, type PoolClient } from "pg";
import config from "../common/config";

/* Article-list pagination helpers (shared by community + user article lists).
 *
 * The list is ordered by the selected timestamp field (published or updatedAt),
 * so pages must always break ties by articleId in the same direction — otherwise
 * a page boundary inside a group sharing a timestamp duplicates or omits rows.
 * A supplied cursor id turns the matching timestamp bound into a tuple predicate
 * so paging continues strictly after the cursor item. `alias` is the article
 * table alias whose "articleId"/"published"/"updatedAt" columns are used ("ca"
 * for community articles, "ua" for user articles). */

type ArticleListCursorData = {
  orderBy?: 'updatedAt' | 'published';
  order?: 'ASC' | 'DESC';
  publishedBefore?: string;
  publishedAfter?: string;
  updatedBefore?: string;
  updatedAfter?: string;
  beforeId?: string | null;
  afterId?: string | null;
};

function articleListTimeClauses(alias: string, data: ArticleListCursorData): string {
  const orderByPublished = data.orderBy !== 'updatedAt';
  const desc = data.order !== 'ASC';
  const idCol = `${alias}."articleId"`;

  const clause = (col: string, op: '<' | '>', value: string, id: string | null | undefined): string =>
    id
      ? format(`AND (${col} ${op} %L::timestamptz OR (${col} = %L::timestamptz AND ${idCol} ${op} %L::UUID))`, value, value, id)
      : format(`AND ${col} ${op} %L::timestamptz`, value);

  const parts: string[] = [];
  if (data.publishedAfter) {
    parts.push(clause(`${alias}."published"`, '>', data.publishedAfter, orderByPublished && !desc ? data.afterId : null));
  }
  if (data.publishedBefore) {
    parts.push(clause(`${alias}."published"`, '<', data.publishedBefore, orderByPublished && desc ? data.beforeId : null));
  }
  if (data.updatedAfter) {
    parts.push(clause(`${alias}."updatedAt"`, '>', data.updatedAfter, !orderByPublished && !desc ? data.afterId : null));
  }
  if (data.updatedBefore) {
    parts.push(clause(`${alias}."updatedAt"`, '<', data.updatedBefore, !orderByPublished && desc ? data.beforeId : null));
  }
  return parts.join('\n      ');
}

function articleListOrderBy(alias: string, data: { orderBy?: 'updatedAt' | 'published'; order?: 'ASC' | 'DESC' }): string {
  const col = data.orderBy === 'updatedAt' ? `${alias}."updatedAt"` : `${alias}."published"`;
  const dir = data.order === 'ASC' ? 'ASC' : 'DESC';
  return `${col} ${dir}, ${alias}."articleId" ${dir}`;
}

/* Community Content Retrieval */

async function _getCommunityArticleSocialPreviewData(
  db: Pool | PoolClient,
  options:
    ({ communityId: string } | { communityUrl: string }) &
    ({ articleId: string } | { articleUrl: string }),
): Promise<{
  communityId: string,
  articleId: string,
  published: string,
  title: string,
  headerImageId: string,
  thumbnailImageId: string,
  previewText: string,
} | null> {
  const query = `
    SELECT
      ca."communityId",
      ca."articleId",
      ca."published",
      a."title",
      a."headerImageId",
      a."thumbnailImageId",
      a."previewText"
    FROM communities_articles ca
    INNER JOIN communities_articles_roles_permissions carp
      ON ca."communityId" = carp."communityId"
        AND ca."articleId" = carp."articleId"
    INNER JOIN roles r
      ON carp."roleId" = r."id"
    INNER JOIN articles a
      ON carp."articleId" = a."id"
    INNER JOIN communities c
      ON c."id" = ca."communityId"

    WHERE r."title" = ${format("%L", PredefinedRole.Public)}
      AND r."type" = ${format("%L", RoleType.PREDEFINED)}
      AND ca."deletedAt" IS NULL
      AND carp."permissions" @> ${format(
        'ARRAY[%L]::"public"."communities_articles_roles_permissions_permissions_enum"[]',
        ArticlePermission.ARTICLE_PREVIEW
      )}
      AND ca."published" < now()
      ${'communityId' in options
        ? format('AND c."id" = %L::UUID', options.communityId)
        : format('AND c."url" = %L', options.communityUrl)}
      ${'articleId' in options
        ? format('AND ca."articleId" = %L::UUID', options.articleId)
        : format('AND ca."url" = %L', options.articleUrl)}
  `;
  const result = await db.query(query);
  if (result.rows.length === 1) {
    return result.rows[0];
  }
  return null;
}

async function _getCommunityArticleList(
  db: Pool | PoolClient,
  userId: string | undefined,
  data: API.Community.getArticleList.Request,
): Promise<{
  communityArticle: Models.Community.CommunityArticle;
  article: Models.BaseArticle.Preview;
}[]> {
  if (!userId && data.verification === 'following') return [];

  const followingSubquery = `
    SELECT ruu2.claimed
    FROM roles r3 INNER JOIN roles_users_users ruu2 on ruu2."roleId" = r3.id
    WHERE
      r3."communityId" = c.id AND
      r3."title" = ${format("%L", PredefinedRole.Member)} AND
      r3."type" = ${format("%L", RoleType.PREDEFINED)} AND
      ${format('ruu2."userId" = %L::UUID', userId)}
  `;

  const query = `
    SELECT
      json_build_object(
        'communityId', ca."communityId",
        'articleId', ca."articleId",
        'url', ca."url",
        'published', ca."published",
        'updatedAt', ca."updatedAt",
        'rolePermissions', (
          SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG("item")), '[]'::JSON)
          FROM (
            SELECT JSON_BUILD_OBJECT(
              'roleId', r2."id",
              'roleTitle', r2."title",
              'permissions', carp2."permissions"
            ) AS "item"
            FROM communities_articles_roles_permissions carp2
            INNER JOIN roles r2
                ON r2."id" = carp2."roleId"
                AND r2."deletedAt" IS NULL
            WHERE ca."communityId" = carp2."communityId"
              AND ca."articleId" = carp2."articleId"
          ) sub
        )
      ) AS "communityArticle",
      json_build_object(
        'articleId', a."id",
        'title', a."title",
        'previewText', a."previewText",
        'thumbnailImageId', a."thumbnailImageId",
        'headerImageId', a."headerImageId",
        'creatorId', a."creatorId",
        'tags', a."tags",
        'commentCount', (
          SELECT COUNT(*)
          FROM messages m
          WHERE m."channelId" = a."channelId" AND m."deletedAt" IS NULL
          LIMIT 11
        ),
        'latestCommentTimestamp', (
          SELECT m."createdAt"
          FROM messages m
          WHERE m."channelId" = a."channelId" AND m."deletedAt" IS NULL
          ORDER BY m."createdAt" DESC
          LIMIT 1
        )
      ) AS "article"
    FROM communities_articles ca
    INNER JOIN communities_articles_roles_permissions carp
      ON ca."communityId" = carp."communityId"
      AND ca."articleId" = carp."articleId"
    INNER JOIN roles r
      ON carp."roleId" = r."id"
      AND r."deletedAt" IS NULL
    INNER JOIN articles a
      ON carp."articleId" = a."id"
    INNER JOIN communities c
      ON c."id" = ca."communityId"
    LEFT JOIN LATERAL (
      SELECT "communityId", "activeUntil"
      FROM communities_premium
      WHERE "featureName" = ANY(ARRAY[${format("%L", [CommunityPremiumFeatureName.BASIC, CommunityPremiumFeatureName.PRO, CommunityPremiumFeatureName.ENTERPRISE])}]::"public"."communities_premium_featurename_enum"[])
        AND "communityId" = ca."communityId"
      ORDER BY "activeUntil" DESC
      LIMIT 1
    ) cpr ON TRUE
    ${!!userId
      ? `LEFT JOIN roles_users_users ruu
           ON (r."id" = ruu."roleId" AND ruu.claimed = TRUE)`
      : ''}
    WHERE (
        (
          ${!!userId
          ? format('ruu."userId" = %L::UUID OR', userId)
          : ''}
          (
            r."title" = ${format("%L", PredefinedRole.Public)}
            AND r."type" = ${format("%L", RoleType.PREDEFINED)}
          )
        )
        ${data.verification === 'following' || data.verification === 'verified' ? `AND (
          (${followingSubquery})
          ${data.verification === "verified"
          ? `OR cpr."activeUntil" >= now()`
          : ''}
        )`: ''}
        ${data.verification === "unverified"
        ? `AND (cpr."activeUntil" < now() OR cpr."activeUntil" IS NULL)`
        : ''}
      ) AND
      ${!!data.drafts
        ? '(ca."published" > now() OR ca."published" IS NULL)'
        : 'ca."published" < now()'}
      AND ca."deletedAt" IS NULL
      ${!!data.communityId
        ? format(' AND ca."communityId" = %L::UUID ', data.communityId)
        : ''}
      AND carp."permissions" @> ${format(
        'ARRAY[%L]::"public"."communities_articles_roles_permissions_permissions_enum"[]',
        ArticlePermission.ARTICLE_PREVIEW
      )}
      ${!!data.tags && data.tags.length > 0
        ? format('AND a."tags" @> ARRAY[%L]::text[]', data.tags)
        : ''}
      ${!!data.anyTags && data.anyTags.length > 0
        ? format('AND a."tags" && ARRAY[%L]::text[]', data.anyTags)
        : ''
      }
      ${!!data.communityTags && data.communityTags.length > 0
        ? format('AND c."tags" @> ARRAY[%L]::varchar[]', data.communityTags)
        : ''}
      ${!!data.anyCommunityTags && data.anyCommunityTags.length > 0
        ? format('AND c."tags" && ARRAY[%L]::varchar[]', data.anyCommunityTags)
        : ''
      }
      ${articleListTimeClauses('ca', data)}
      ${!!data.ids
        ? `AND ca."articleId" = ANY(ARRAY[${format('%L', data.ids)}]::UUID[])`
        : ''}
    GROUP BY ca."articleId", ca."communityId", a."id"
    ORDER BY ${articleListOrderBy('ca', data)}
    LIMIT ${+data.limit}
  `;

  const result = await db.query(query);
  return result.rows;
}

async function _getCommunityArticleListForEmails(
  db: Pool | PoolClient,
  userId: string | undefined,
  data: API.Community.getArticleList.Request,
): Promise<{
  communityArticle: {
    id: string;
    communityUrl: string;
    communityTitle: string;
    communityImageId: string;
    articleTitle: string;
    articleHeaderImageId: string;
  };
}[]> {
  if (!userId && data.verification === 'following') return [];

  const followingSubquery = `
    SELECT ruu2.claimed
    FROM roles r3 INNER JOIN roles_users_users ruu2 on ruu2."roleId" = r3.id
    WHERE
      r3."communityId" = c.id AND
      r3."title" = ${format("%L", PredefinedRole.Member)} AND
      r3."type" = ${format("%L", RoleType.PREDEFINED)} AND
      ${format('ruu2."userId" = %L::UUID', userId)}
  `;

  const query = `
    SELECT
      json_build_object(
        'id', ca."articleId",
        'communityUrl', c."url",
        'communityTitle', c."title",
        'communityImageId', c."logoSmallId", 
        'articleTitle', a."title",
        'articleHeaderImageId', a."headerImageId"
      ) AS "communityArticle"
    FROM communities_articles ca
    INNER JOIN communities_articles_roles_permissions carp
      ON ca."communityId" = carp."communityId"
        AND ca."articleId" = carp."articleId"
    INNER JOIN roles r
      ON carp."roleId" = r."id"
    INNER JOIN articles a
      ON carp."articleId" = a."id"
    INNER JOIN communities c
      ON c."id" = ca."communityId"
    LEFT JOIN LATERAL (
      SELECT "communityId", "activeUntil"
      FROM communities_premium
      WHERE "featureName" = ANY(ARRAY[${format("%L", [CommunityPremiumFeatureName.BASIC, CommunityPremiumFeatureName.PRO, CommunityPremiumFeatureName.ENTERPRISE])}]::"public"."communities_premium_featurename_enum"[])
        AND "communityId" = ca."communityId"
      ORDER BY "activeUntil" DESC
      LIMIT 1
    ) cpr ON TRUE
    ${!!userId
      ? `LEFT JOIN roles_users_users ruu
           ON (r."id" = ruu."roleId" AND ruu.claimed = TRUE)`
      : ''}
    WHERE (
        (
          ${!!userId
          ? format('ruu."userId" = %L::UUID OR', userId)
          : ''}
          (
            r."title" = ${format("%L", PredefinedRole.Public)}
            AND r."type" = ${format("%L", RoleType.PREDEFINED)}
          )
        )
        ${data.verification === 'following' || data.verification === 'verified' ? `AND (
          (${followingSubquery})
          ${data.verification === "verified"
          ? `OR cpr."activeUntil" >= now()`
          : ''}
        )`: ''}
        ${data.verification === "unverified"
        ? `AND (cpr."activeUntil" < now() OR cpr."activeUntil" IS NULL)`
        : ''}
      )
        AND ca."deletedAt" IS NULL
        ${!!data.communityId
        ? format(' AND ca."communityId" = %L::UUID ', data.communityId)
        : ''}
        ${!!data.ids
        ? `AND ca."articleId" = ANY(ARRAY[${format('%L', data.ids)}]::UUID[])`
        : ''}
      AND ca."published" < now()
      AND ca."deletedAt" IS NULL
      AND carp."permissions" @> ${format(
        'ARRAY[%L]::"public"."communities_articles_roles_permissions_permissions_enum"[]',
        ArticlePermission.ARTICLE_READ
      )}
      ${!!data.publishedAfter
        ? format('AND ca."published" > %L::timestamptz', data.publishedAfter)
        : ''}
      ${!!data.publishedBefore
        ? format('AND ca."published" < %L::timestamptz', data.publishedBefore)
        : ''}
      AND c."enablePersonalNewsletter" = TRUE
    GROUP BY ca."articleId", ca."communityId", a."id", c."title", c."logoSmallId", a."headerImageId", c."url"
    ORDER BY ${'orderBy' in data ? format('ca.%I', data.orderBy) : 'ca."published"'} ${data.order === 'ASC' ? 'ASC' : 'DESC'}
    LIMIT ${+data.limit}
  `;
  const result = await db.query(query);
  return result.rows;
}

async function _getCommunityArticleDetailView(
  db: Pool | PoolClient,
  userId: string | undefined,
  data: API.Community.getArticleDetailView.Request,
): Promise<{
  communityArticle: Models.Community.CommunityArticle;
  article: Models.BaseArticle.DetailView;
}> {
  const query = `
    SELECT
      json_build_object(
        'communityId', ca."communityId",
        'articleId', ca."articleId",
        'url', ca."url",
        'published', ca."published",
        'updatedAt', ca."updatedAt",
        'sentAsNewsletter', ca."sentAsNewsletter",
        'markAsNewsletter', ca."markAsNewsletter",
        'rolePermissions', (
          SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG("item")), '[]'::JSON)
          FROM (
            SELECT JSON_BUILD_OBJECT(
              'roleId', r2."id",
              'roleTitle', r2."title",
              'permissions', carp2."permissions"
            ) AS "item"
            FROM communities_articles_roles_permissions carp2
            INNER JOIN roles r2
                ON r2."id" = carp2."roleId"
                AND r2."deletedAt" IS NULL
            WHERE ca."communityId" = carp2."communityId"
              AND ca."articleId" = carp2."articleId"
          ) sub
        )
      ) AS "communityArticle",
      json_build_object(
        'articleId', a."id",
        'title', a."title",
        'previewText', a."previewText",
        'thumbnailImageId', a."thumbnailImageId",
        'headerImageId', a."headerImageId",
        'creatorId', a."creatorId",
        'tags', a."tags",
        'content', a."content",
        'channelId', a."channelId",
        'commentCount', (
          SELECT COUNT(*)
          FROM messages m
          WHERE m."channelId" = a."channelId" AND m."deletedAt" IS NULL
        ),
        'latestCommentTimestamp', (
          SELECT m."createdAt"
          FROM messages m
          WHERE m."channelId" = a."channelId" AND m."deletedAt" IS NULL
          ORDER BY m."createdAt" DESC
          LIMIT 1
        )
      ) AS "article"
    FROM communities_articles ca
    INNER JOIN communities_articles_roles_permissions carp
      ON ca."communityId" = carp."communityId"
        AND ca."articleId" = carp."articleId"
    INNER JOIN roles r
      ON carp."roleId" = r."id"
      AND r."deletedAt" IS NULL
    INNER JOIN articles a
      ON carp."articleId" = a."id"
    ${!!userId
      ? `LEFT JOIN roles_users_users ruu
          ON (r."id" = ruu."roleId" AND ruu.claimed = TRUE)`
      : ''}
    WHERE (
        ${!!userId
          ? format('ruu."userId" = %L::UUID OR', userId)
          : ''}
        r."title" = ${format("%L", PredefinedRole.Public)}
      )
      AND ca."deletedAt" IS NULL
      AND ca."communityId" = $1
      ${'articleId' in data
        ? format('AND ca."articleId" = %L::uuid', data.articleId)
        : format('AND ca."url" = %L', data.url)
      }
      AND (
        (
          carp."permissions" @> ${format('ARRAY[%L]::"public"."communities_articles_roles_permissions_permissions_enum"[]', ArticlePermission.ARTICLE_READ)}
          AND ca."published" < now()
        )
        OR r."permissions" @> ${format('ARRAY[%L]::"public"."roles_permissions_enum"[]', CommunityPermission.COMMUNITY_MANAGE_ARTICLES)}
      )
    GROUP BY ca."articleId", ca."communityId", a."id"
    LIMIT 1
  `;
  const params: any[] = [data.communityId];
  const result = await db.query(query, params);
  if (result.rows.length === 1) {
    return result.rows[0] as {
      communityArticle: {
        communityId: string;
        articleId: string;
        url: string | null;
        published: string | null;
        updatedAt: string;
        rolePermissions: Models.Community.CommunityArticlePermission[];
        sentAsNewsletter: string | null;
        markAsNewsletter: boolean;
      }
      article: {
        articleId: string;
        title: string;
        previewText: string | null; // max length = 150 in validator
        thumbnailImageId: string | null;
        headerImageId: string | null;
        creatorId: string;
        tags: string[];
        content: Models.BaseArticle.Content;
        channelId: string;
        commentCount: number;
        latestCommentTimestamp: string | null; // ISO 8601 format, nullable
      };
    };
  }
  throw new Error(errors.server.NOT_ALLOWED)
}

async function _createCommunityArticle(
  db: PoolClient,
  userId: string,
  data: API.Community.createArticle.Request
) {
  const { communityArticle, article } = data;
  const query = `
    WITH insert_channel AS (
      INSERT INTO channels
      DEFAULT VALUES
      RETURNING "id"
    ),
    insert_article AS (
      INSERT INTO articles (
        "creatorId",
        "headerImageId",
        "thumbnailImageId",
        "title",
        "content",
        "previewText",
        "tags",
        "channelId"
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7, (SELECT "id" FROM insert_channel))
      RETURNING "id"
    )
    INSERT INTO communities_articles (
      "communityId",
      "articleId",
      "url",
      "published"
    ) VALUES ($8, (SELECT "id" FROM insert_article), $9, $10)
    RETURNING "updatedAt", "articleId", "published", (SELECT "id" FROM insert_channel) AS "channelId"
  `;
  const result = await db.query(query, [
    userId,
    article.headerImageId,
    article.thumbnailImageId,
    article.title,
    article.content,
    article.previewText,
    article.tags,
    communityArticle.communityId,
    communityArticle.url,
    // honor the requested publish state on create: null -> draft, a timestamp
    // -> published/scheduled (the validator already constrains it). The INSERT
    // used to drop this, so every create produced a draft regardless.
    communityArticle.published ?? null
  ]);
  if (result.rows.length === 1) {
    const row: { updatedAt: string, articleId: string; channelId: string; published: string | null; } = result.rows[0];
    const communityRoles = await communityHelper.getCommunityRoles(communityArticle.communityId, db);
    const existingRoleIds = new Set(communityRoles.map(r => r.id));
    const adminId = communityRoles.filter(r => r.title === PredefinedRole.Admin)[0].id;
    // check if all roleIds really belong to this community
    for (const rolePermission of communityArticle.rolePermissions) {
      if (!existingRoleIds.has(rolePermission.roleId) || rolePermission.roleId === adminId) {
        throw new Error(errors.server.NOT_ALLOWED);
      }
    }
    const rolePermissions: typeof communityArticle.rolePermissions = [
      {
        roleId: adminId,
        roleTitle: PredefinedRole.Admin,
        permissions: rolePermissionPresets.Article.Visible
      },
      ...communityArticle.rolePermissions.filter(rp => rp.roleId !== adminId),
    ];
    const query = `
      INSERT INTO communities_articles_roles_permissions
        ("communityId", "articleId", "roleId", "permissions")
      VALUES
        ${rolePermissions.map(
          rp => format(
            '(%L::UUID, %L::UUID, %L::UUID, ARRAY[%L]::"public"."communities_articles_roles_permissions_permissions_enum"[])',
            communityArticle.communityId,
            row.articleId,
            rp.roleId,
            rp.permissions
          )
        ).join(',')}
    `;
    const caaResult = await db.query(query);
    if ((caaResult.rowCount ?? 0) > 0) {
      return row;
    }
  }
  throw new Error("Error adding article");
}

async function _updateCommunityArticle(
  db: PoolClient,
  data: API.Community.updateArticle.Request
): Promise<void> {
  const { communityArticle, article } = data;
  const setCommunityArticle: string[] = [];
  const setArticle: string[] = [];
  const params: any[] = [communityArticle.communityId, communityArticle.articleId];
  let i = 3;
  if (communityArticle.published !== undefined) {
    setCommunityArticle.push(`"published" = $${i++}`);
    params.push(communityArticle.published);
  }
  if (communityArticle.url !== undefined) {
    setCommunityArticle.push(`"url" = $${i++}`);
    params.push(communityArticle.url);
  }
  if (!!article) {
    if (article.content !== undefined) {
      setArticle.push(`"content" = $${i++}`);
      params.push(article.content);
    }
    if (article.headerImageId !== undefined) {
      setArticle.push(`"headerImageId" = $${i++}`);
      params.push(article.headerImageId);
    }
    if (article.thumbnailImageId !== undefined) {
      setArticle.push(`"thumbnailImageId" = $${i++}`);
      params.push(article.thumbnailImageId);
    }
    if (article.tags !== undefined) {
      setArticle.push(`"tags" = $${i++}`);
      params.push(article.tags);
    }
    if (article.title !== undefined) {
      setArticle.push(`"title" = $${i++}`);
      params.push(article.title);
    }
    if (article.previewText !== undefined) {
      setArticle.push(`"previewText" = $${i++}`);
      params.push(article.previewText);
    }
  }
  if (setCommunityArticle.length === 0 && setArticle.length === 0 && !communityArticle.rolePermissions) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  if (setCommunityArticle.length > 0 || setArticle.length > 0) {
    const query = `
      ${setArticle.length > 0
        ? `
          WITH valid_article_id AS (
            SELECT "articleId"
            FROM communities_articles
            WHERE "communityId" = $1 AND "articleId" = $2
          ), update_article AS (
            UPDATE articles a
            SET ${setArticle.join(',')}, "updatedAt" = NOW()
            WHERE a."id" = (SELECT "articleId" FROM valid_article_id)
          )`
        : ''}
      UPDATE communities_articles
      SET ${setCommunityArticle.length > 0
        ? `${setCommunityArticle.join(',')},`
        : ''}
        "updatedAt" = NOW()
      WHERE "communityId" = $1 AND "articleId" = $2
      RETURNING "updatedAt"
    `
    const result = await db.query(query, params);
    if (result.rowCount !== 1) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
  }

  if (communityArticle.rolePermissions !== undefined && communityArticle.rolePermissions.length > 0) {
    const communityRoles = await communityHelper.getCommunityRoles(communityArticle.communityId, db);
    const existingRoleIds = new Set(communityRoles.map(r => r.id));
    const adminId = communityRoles.filter(r => r.title === PredefinedRole.Admin)[0].id;
    // check if all roleIds really belong to this community
    for (const rolePermission of communityArticle.rolePermissions) {
      if (!existingRoleIds.has(rolePermission.roleId) || rolePermission.roleId === adminId) {
        throw new Error(errors.server.NOT_ALLOWED);
      }
    }
    const query = `
      INSERT INTO communities_articles_roles_permissions
        ("communityId", "articleId", "roleId", "permissions")
      VALUES 
        ${communityArticle.rolePermissions.map(
          rp => format(
            '(%L::uuid, %L::uuid, %L::uuid, ARRAY[%L]::"public"."communities_articles_roles_permissions_permissions_enum"[])',
            communityArticle.communityId,
            communityArticle.articleId,
            rp.roleId,
            rp.permissions
          )
        ).join(',')}
      ON CONFLICT ("communityId", "articleId", "roleId")
        DO UPDATE SET "permissions" = EXCLUDED."permissions"
    `;
    await db.query(query);
  }
}

async function _deleteCommunityArticle(
  db: Pool | PoolClient,
  data: API.Community.deleteArticle.Request
): Promise<void> {
  const query = `
    UPDATE communities_articles
    SET "updatedAt" = NOW(), "deletedAt" = NOW()
    WHERE "communityId" = $1 AND "articleId" = $2
  `;
  const params = [
    data.communityId,
    data.articleId
  ];
  const result = await db.query(query, params);
  if (result.rowCount !== 1) {
    throw new Error(errors.server.NOT_FOUND);
  }
}

// USER ARTICLES

async function _getUserArticleSocialPreviewData(
  db: Pool | PoolClient,
  options: 
    ({ userId: string } | { userAlias: string }) &
    ({ articleId: string } | { articleUrl: string }),
): Promise<{
  userId: string;
  articleId: string;
  published: string;
  title: string;
  headerImageId: string;
  thumbnailImageId: string;
  previewText: string;
} | null> {
  console.error("Not implemented");
  throw new Error("Not implemented");
  /*
  const query = `
    SELECT
      ua."userId",
      ua."articleId",
      ua."published",
      a."title",
      a."headerImageId",
      a."thumbnailImageId",
      a."previewText"
    FROM users_articles ua
    INNER JOIN articles a
      ON ua."articleId" = a."id"
    INNER JOIN users u
      ON ua."userId" = u."id"

    WHERE ua."deletedAt" IS NULL
      AND ua."published" < now()
      ${'userId' in options
        ? format('AND u."id" = %L::UUID', options.userId) 
        : format('AND u."alias" = %L', options.userAlias || '') FIXME}
      ${'articleId' in options
        ? format('AND ua."articleId" = %L::UUID', options.articleId)
        : format('AND ua."url" = %L', options.articleUrl || '')}
  `;
  const result = await db.query(query);
  if (result.rows.length === 1) {
    return result.rows[0];
  }
  return null;
  */
}

async function _getUserArticleList(
  db: Pool | PoolClient,
  userId: string | undefined,
  data: API.User.getArticleList.Request
): Promise<API.User.getArticleList.Response> {
  // Take care!
  // Here, userId references the logged in user, whereas
  // data.userId references the user who published the articles
  const query = `
    SELECT
      json_build_object(
        'userId', ua."userId",
        'articleId', ua."articleId",
        'url', ua."url",
        'published', ua."published",
        'updatedAt', ua."updatedAt"
      ) AS "userArticle",
      json_build_object(
        'articleId', a."id",
        'title', a."title",
        'previewText', a."previewText",
        'thumbnailImageId', a."thumbnailImageId",
        'headerImageId', a."headerImageId",
        'creatorId', a."creatorId",
        'tags', a."tags",
        'commentCount', (
          SELECT COUNT(*)
          FROM messages m
          WHERE m."channelId" = a."channelId" AND m."deletedAt" IS NULL
          LIMIT 11
        ),
        'latestCommentTimestamp', (
          SELECT m."createdAt"
          FROM messages m
          WHERE m."channelId" = a."channelId" AND m."deletedAt" IS NULL
          ORDER BY m."createdAt" DESC
          LIMIT 1
        )
      ) AS "article"
    FROM users_articles ua
    INNER JOIN articles a
      ON ua."articleId" = a."id"
    ${data.verification !== "both"
      ? `INNER JOIN users u
           ON ua."userId" = u."id"`
      : ''}
    ${!!userId && data.followingOnly
      ? format(`
          INNER JOIN followers f
            ON f."otherUserId" = ua."userId"
            AND f."userId" = %L::UUID`
        , userId) 
      : ''}
    WHERE
      ua."deletedAt" IS NULL
      ${!!data.drafts
        ? 'AND (ua."published" > now() OR ua."published" IS NULL)'
        : 'AND ua."published" < now()'}
      ${!!data.userId
        ?  format('AND ua."userId" = %L::UUID', data.userId)
        : ''}
      ${!!data.tags && data.tags.length > 0
        ? format('AND a."tags" @> ARRAY[%L]', data.tags) 
        : ''}
      ${articleListTimeClauses('ua', data)}
      ${data.verification === "verified"
        ? 'AND u."fractalId" IS NOT NULL'
        : data.verification === "unverified"
        ? 'AND u."fractalId" IS NULL'
        : ''}
      ${!!data.ids
        ? `AND ua."articleId" = ANY(ARRAY[${format('%L', data.ids)}]::UUID[])`
        : ''}
    ORDER BY ${articleListOrderBy('ua', data)}
    LIMIT ${+data.limit}
  `;
  const result = await db.query(query);
  return result.rows as {
    userArticle: {
      userId: string;
      articleId: string;
      url: string | null;
      published: string | null;
      updatedAt: string;
    }
    article: {
      articleId: string;
      title: string;
      previewText: string;
      thumbnailImageId: string | null;
      headerImageId: string | null;
      creatorId: string;
      tags: string[];
      commentCount: number;
      latestCommentTimestamp: string | null; // ISO 8601 format, nullable
    }
  }[];
}

async function _getUserArticleDetailView(
  db: Pool | PoolClient,
  userId: string | undefined,
  data: API.User.getArticleDetailView.Request
): Promise<(Models.User.UserArticle & { article: Models.BaseArticle.DetailView })> {
  // Take care!
  // Here, userId references the logged in user, whereas
  // data.userId references the user who published the articles
  const query = `
    SELECT
      ua."userId",
      ua."articleId",
      ua."url",
      ua."published",
      ua."updatedAt",
      json_build_object(
        'articleId', a."id",
        'title', a."title",
        'previewText', a."previewText",
        'thumbnailImageId', a."thumbnailImageId",
        'headerImageId', a."headerImageId",
        'creatorId', a."creatorId",
        'tags', a."tags",
        'content', a."content",
        'channelId', a."channelId",
        'commentCount', (
          SELECT COUNT(*)
          FROM messages m
          WHERE m."channelId" = a."channelId" AND m."deletedAt" IS NULL
        ),
        'latestCommentTimestamp', (
          SELECT m."createdAt"
          FROM messages m
          WHERE m."channelId" = a."channelId" AND m."deletedAt" IS NULL
          ORDER BY m."createdAt" DESC
          LIMIT 1
        )
      ) AS "article"
    FROM users_articles ua
    INNER JOIN articles a
      ON ua."articleId" = a."id"
    WHERE
      ${'articleId' in data
        ? format('ua."articleId" = %L::uuid', data.articleId)
        : format('ua."url" = %L', data.url)
      }
      AND ua."deletedAt" IS NULL
      AND ua."userId" = $1
      AND (ua."userId" = $1 OR ua."published" < now())
    ORDER BY ua."published" DESC
  `;
  const result = await db.query(query, [
    data.userId
  ]);
  if (result.rows.length === 1) {
    return result.rows[0] as {
      userId: string;
      articleId: string;
      url: string | null;
      published: string | null;
      updatedAt: string;
      article: {
        articleId: string;
        title: string;
        previewText: string;
        thumbnailImageId: string | null;
        headerImageId: string | null;
        creatorId: string;
        tags: string[];
        content: Models.BaseArticle.Content;
        channelId: string;
        commentCount: number;
        latestCommentTimestamp: string | null; // ISO 8601 format, nullable
      }
    };
  }
  throw new Error(errors.server.NOT_FOUND);
}

async function _createUserArticle(
  db: Pool | PoolClient,
  userId: string,
  data: API.User.createArticle.Request
) {
  const { userArticle, article } = data;
  const query = `
  WITH insert_channel AS (
      INSERT INTO channels
      DEFAULT VALUES
      RETURNING "id"
    ),
    insert_article AS (
      INSERT INTO articles (
        "creatorId",
        "headerImageId",
        "thumbnailImageId",
        "title",
        "content",
        "previewText",
        "tags",
        "channelId"
      )
      VALUES ($1,$2,$3,$4,$5,$6,$7, (SELECT "id" FROM insert_channel))
      RETURNING "id"
    )
    INSERT INTO users_articles (
      "userId",
      "articleId",
      "url",
      "published"
    ) VALUES ($1, (SELECT "id" FROM insert_article), $8, $9)
    RETURNING "updatedAt", "articleId", "published", (SELECT "id" FROM insert_channel) AS "channelId"
  `;
  const result = await db.query(query, [
    userId,
    article.headerImageId,
    article.thumbnailImageId,
    article.title,
    article.content,
    article.previewText,
    article.tags,
    userArticle.url,
    // honor the requested publish state on create (see _createCommunityArticle)
    userArticle.published ?? null
  ]);
  if (result.rows.length === 1) {
    return result.rows[0] as { updatedAt: string, articleId: string, channelId: string, published: string | null };
  }
  throw new Error("Error adding article");
}

async function _updateUserArticle(
  db: Pool | PoolClient,
  userId: string,
  data: API.User.updateArticle.Request
) {
  const { userArticle, article } = data;
  const setUserArticle: string[] = [];
  const setArticle: string[] = [];
  const params: any[] = [userId, userArticle.articleId];
  let i = 3;
  if (userArticle.published !== undefined) {
    setUserArticle.push(`"published" = $${i++}`);
    params.push(userArticle.published);
  }
  if (userArticle.url !== undefined) {
    setUserArticle.push(`"url" = $${i++}`);
    params.push(userArticle.url);
  }
  if (!!article) {
    if (article.content !== undefined) {
      setArticle.push(`"content" = $${i++}`);
      params.push(article.content);
    }
    if (article.headerImageId !== undefined) {
      setArticle.push(`"headerImageId" = $${i++}`);
      params.push(article.headerImageId);
    }
    if (article.thumbnailImageId !== undefined) {
      setArticle.push(`"thumbnailImageId" = $${i++}`);
      params.push(article.thumbnailImageId);
    }
    if (article.tags !== undefined) {
      setArticle.push(`"tags" = $${i++}`);
      params.push(article.tags);
    }
    if (article.title !== undefined) {
      setArticle.push(`"title" = $${i++}`);
      params.push(article.title);
    }
    if (article.previewText !== undefined) {
      setArticle.push(`"previewText" = $${i++}`);
      params.push(article.previewText);
    }
  }
  if (setUserArticle.length === 0 && setArticle.length === 0) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  if (setUserArticle.length > 0 || setArticle.length > 0) {
    const query = `
      ${setArticle.length > 0
        ? `
          WITH valid_article_id AS (
            SELECT "articleId"
            FROM users_articles
            WHERE "userId" = $1 AND "articleId" = $2
          ), update_article AS (
            UPDATE articles a
            SET ${setArticle.join(',')}, "updatedAt" = NOW()
            WHERE a."id" = (SELECT "articleId" FROM valid_article_id)
          )`
        : ''}
      UPDATE users_articles
      SET ${setUserArticle.length > 0
        ? `${setUserArticle.join(',')},`
        : ''}
        "updatedAt" = NOW()
      WHERE "userId" = $1 AND "articleId" = $2
      RETURNING "updatedAt"
    `
    const result = await db.query(query, params);
    if (result.rows.length === 1) {
      return result.rows[0] as { updatedAt: string };
    }
  }
  throw new Error(errors.server.NOT_ALLOWED);
}

async function _deleteUserArticle(
  runner: Pool | PoolClient,
  userId: string,
  data: API.User.deleteArticle.Request
): Promise<void> {
  const query = `
    UPDATE users_articles
    SET "updatedAt" = NOW(), "deletedAt" = NOW()
    WHERE "userId" = $1 AND "articleId" = $2
  `;
  const params = [
    userId,
    data.articleId
  ];
  const result = await runner.query(query, params);
  if (result.rowCount !== 1) {
    throw new Error(errors.server.NOT_ALLOWED);
  }
}

/* HELPER */
class ArticleHelper {
  public async getCommunityArticleList(
    userId: string | undefined,
    data: API.Community.getArticleList.Request
  ): Promise<API.Community.getArticleList.Response> {
    return await _getCommunityArticleList(pool, userId, data);
  }

  public async getCommunityArticleListForEmails(
    userId: string | undefined,
    data: API.Community.getArticleList.Request
  ) {
    return await _getCommunityArticleListForEmails(pool, userId, data);
  }

  public async getCommunityArticleDetailView(
    userId: string | undefined,
    data: API.Community.getArticleDetailView.Request
  ): Promise<API.Community.getArticleDetailView.Response> {
    return await _getCommunityArticleDetailView(pool, userId, data);
  }

  public async createCommunityArticle(
    userId: string,
    data: API.Community.createArticle.Request
  ) {
    const client = await pool.connect();
    let result: Awaited<ReturnType<typeof _createCommunityArticle>>;
    await client.query("BEGIN");
    try {
      result = await _createCommunityArticle(client, userId, data);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    return result;
  }

  public async updateCommunityArticle(
    data: API.Community.updateArticle.Request
  ) {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      await _updateCommunityArticle(client, data);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
  }

  public async deleteCommunityArticle(
    data: API.Community.deleteArticle.Request
  ) {
    await _deleteCommunityArticle(pool, data);
  }

  // USER

  public async getUserArticleList(
    userId: string | undefined,
    data: API.User.getArticleList.Request
  ): Promise<API.User.getArticleList.Response> {
    return _getUserArticleList(pool, userId, data);
  }

  public async getUserArticleDetailView(
    userId: string | undefined,
    data: API.User.getArticleDetailView.Request
  ) {
    return _getUserArticleDetailView(pool, userId, data);
  }

  public async createUserArticle(
    userId: string,
    data: API.User.createArticle.Request
  ) {
    return await _createUserArticle(pool, userId, data);
  }

  public async updateUserArticle(
    userId: string,
    data: API.User.updateArticle.Request
  ) {
    return await _updateUserArticle(pool, userId, data);
  }

  public async deleteUserArticle(
    userId: string,
    data: API.User.deleteArticle.Request
  ) {
    return await _deleteUserArticle(pool, userId, data);
  }

  public async getCommunityArticleSocialPreviewData(options:
    ({ communityId: string } | { communityUrl: string }) &
    ({ articleId: string } | { articleUrl: string })
  ) {
    return _getCommunityArticleSocialPreviewData(pool, options);
  }

  public async getUserArticleSocialPreviewData(options: 
    ({ userId: string } | { userAlias: string }) &
    ({ articleId: string } | { articleUrl: string })    
  ) {
    return _getUserArticleSocialPreviewData(pool, options);
  }

  public async getCommunityArticleForEmailsList(): Promise<{articleId: string, communityId: string}[]> {
      const client = await pool.connect();
      try {
          await client.query('BEGIN');
  
          const query = `
            SELECT DISTINCT ON ("communityId") "articleId", "communityId"
            FROM communities_articles
            WHERE "markAsNewsletter" = true AND "sentAsNewsletter" IS NULL AND "published" < now()
            ORDER BY "communityId", "published" DESC
          `;
          const result = await client.query(query);
  
          const updateQuery = `
            UPDATE communities_articles
            SET "markAsNewsletter" = FALSE
            WHERE "communityId" = $1 AND "articleId" != $2 AND "markAsNewsletter" = TRUE AND "sentAsNewsletter" IS NULL AND "published" < now()
          `;
          for (const row of result.rows) {
              await client.query(updateQuery, [row.communityId, row.articleId]);
          }
  
          await client.query('COMMIT');
          return result.rows;
      } catch (error) {
          await client.query('ROLLBACK');
          throw error;
      } finally {
          client.release();
      }
  }

  public async registerCommunityArticleForEmails(
    articleId: string,
    communityId: string
  ) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      const checkQuery = `
            SELECT "articleId"
            FROM communities_articles
            WHERE "communityId" = $1 AND "markAsNewsletter" = TRUE AND "articleId" != $2 AND "sentAsNewsletter" IS NULL
          `;
      const checkResult = await client.query(checkQuery, [communityId, articleId]);

      if (checkResult.rows.length > 0) {
        throw new Error(errors.server.SEND_ARTICLE_LIMIT_EXCEEDED);
      }

      const latestSentQuery = `
            SELECT MAX("sentAsNewsletter") AS "latestSent"
            FROM communities_articles
            WHERE "communityId" = $1 AND "sentAsNewsletter" IS NOT NULL
          `;
      const latestSentResult = await client.query(latestSentQuery, [communityId]);

      const latestSent = latestSentResult.rows[0].latestSent;
      const interval = config.DEPLOYMENT === 'prod' ? '6 days' : '1 minute';
      if (latestSent && new Date(latestSent) > new Date(Date.now() - (interval === '6 days' ? 6 * 24 * 60 * 60 * 1000 : 60 * 1000))) {
        throw new Error(errors.server.SEND_ARTICLE_LIMIT_EXCEEDED);
      }

      const updateQuery = `
          UPDATE communities_articles
          SET "markAsNewsletter" = TRUE
          WHERE "articleId" = $1 AND "communityId" = $2
        `;
      await client.query(updateQuery, [articleId, communityId]);

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async markCommunityArticleForEmailsAsSent(
    articleId: string,
    communityId: string
  ) {
    const query = `
      UPDATE communities_articles
      SET "sentAsNewsletter" = NOW()
      WHERE "articleId" = $1 AND "communityId" = $2
    `;
    await pool.query(query, [articleId, communityId]);
  }
}

const articleHelper = new ArticleHelper();
export default articleHelper;