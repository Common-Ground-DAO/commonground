// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import express from "express";
import validators from "../validators";
import { registerPostRoute } from "./util";
import pool from "../util/postgres";
import format from "pg-format";
import { ArticlePermission } from "../common/enums";

const searchRouter = express.Router();

class SearchHelper {
  public async searchUsers(data: API.Search.searchUsers.Request) {
    let { query, limit, offset, tags } = data;

    let sqlSafeQuery: string | undefined;
    if (query !== null && query.length > 0) {
      sqlSafeQuery = query.replace(/\\/g, '\\\\');  // Escape backslashes first (\ -> \\)
      sqlSafeQuery = sqlSafeQuery.replace(/%/g, '\\%');  // Escape % -> \%
      sqlSafeQuery = sqlSafeQuery.replace(/_/g, '\\_');  // Escape _ -> \_
    }

    // Sanitize tags for use with ILIKE ... ESCAPE '\'
    if (tags) {
      tags = tags.map(tag => tag.replace(/\\/g, '\\\\').replace(/%/g, '\\%').replace(/_/g, '\\_'));
    }

    // Construct patterns for ILIKE
    const patternExact = sqlSafeQuery;
    const patternStartsWith = sqlSafeQuery + '%';
    const patternEndsWith = '%' + sqlSafeQuery;
    const patternContains = '%' + sqlSafeQuery + '%';

    let formatArgs: (string| number | undefined)[] = [];
    if (sqlSafeQuery) {
      formatArgs = [
        patternExact,       // CASE: Exact match
        patternStartsWith,  // CASE: Starts with query
        patternEndsWith,    // CASE: Ends with query
        patternContains,    // CASE: Contains query

        patternExact,       // WHERE: Exact match
        patternStartsWith,  // WHERE: Starts with query
        patternEndsWith,    // WHERE: Ends with query
        patternContains,     // WHERE: Contains query
        limit, offset
      ];
    } else {
      formatArgs = [
        limit, offset
      ];
    }

    const sql = format(`
            SELECT
                u.id
                ${sqlSafeQuery ? `,
                  SUM(account_matches.match_priority) AS "matchPriority",
                  json_agg(account_matches.type) AS "matchedAccountTypes"` : ''}
            FROM
                users u
            ${sqlSafeQuery ? `
            INNER JOIN (
                SELECT
                    ua."userId",
                    ua.type,
                    CASE
                        WHEN ua."displayName" ILIKE %L ESCAPE '\\' THEN 4
                        WHEN ua."displayName" ILIKE %L ESCAPE '\\' THEN 3
                        WHEN ua."displayName" ILIKE %L ESCAPE '\\' THEN 1
                        WHEN ua."displayName" ILIKE %L ESCAPE '\\' THEN 2
                    END AS match_priority
                FROM
                    user_accounts ua
                WHERE
                    (ua."displayName" ILIKE %L ESCAPE '\\' OR
                    ua."displayName" ILIKE %L ESCAPE '\\' OR
                    ua."displayName" ILIKE %L ESCAPE '\\' OR
                    ua."displayName" ILIKE %L ESCAPE '\\') AND
                    ua."deletedAt" IS NULL
            ) AS account_matches ON u.id = account_matches."userId"` : ''}
            WHERE
              u."deletedAt" IS NULL
              ${tags?.length ? `AND u."tags" @> ARRAY[${tags.map(tag => format('%L', tag)).join(', ')}]` : ''}
            GROUP BY
                u.id
            ORDER BY
                ${sqlSafeQuery ? `"matchPriority" DESC,` : ''}
                u.id ASC
            LIMIT %s OFFSET %s;
        `,
        ...formatArgs);
    const result = await pool.query<{
      id: string;
      matchPriority: number;
      matchedAccountTypes: Models.User.ProfileItemType[];
    }>(sql);
    return result.rows;
  }

  public async searchArticles(data: API.Search.searchArticles.Request, userId?: string) {
    const { query, limit, offset, tags } = data;

    const whereArray: string[] = [];
    if (query !== null && query.length > 0) {
      let sqlSafeQuery = query.replace(/\\/g, '\\\\');  // Escape backslashes first (\ -> \\)
      sqlSafeQuery = sqlSafeQuery.replace(/%/g, '\\%');  // Escape % -> \%
      sqlSafeQuery = sqlSafeQuery.replace(/_/g, '\\_');  // Escape _ -> \_
      whereArray.push(`(
        LOWER(a.title) ILIKE ${format('%L', `%${sqlSafeQuery}%`)} ESCAPE '\\'
      )`);
    }
    if (!!tags && tags.length > 0) {
      const lowerTagArray = tags.map(t => format('%L', t.toLowerCase())).join(',');
      const tagArrayString = `ARRAY[${lowerTagArray}]`;

      whereArray.push(`(
        SELECT ARRAY_AGG(LOWER(tag)) FROM UNNEST(a."tags") AS tag
      ) @> ${tagArrayString}::text[]`);
    }

    const sqlQuery = `
      SELECT
        json_build_object(
          'articleId', a."id",
          'title', a."title",
          'tags', a."tags",
          'previewText', a."previewText",
          'thumbnailImageId', a."thumbnailImageId",
          'headerImageId', a."headerImageId",
          'creatorId', a."creatorId"
        ) AS article,
        CASE
          WHEN ca."communityId" IS NOT NULL THEN
            json_build_object(
              'communityId', ca."communityId",
              'articleId', ca."articleId",
              'url', ca."url",
              'published', ca."published",
              'updatedAt', ca."updatedAt",
              'sentAsNewsletter', ca."sentAsNewsletter",
              'markAsNewsletter', ca."markAsNewsletter",
              'rolePermissions', (
                SELECT COALESCE(JSON_AGG(
                  JSON_BUILD_OBJECT(
                    'roleId', r2."id",
                    'roleTitle', r2."title",
                    'roleType', r2."type",
                    'permissions', carp2."permissions"
                  )
                ), '[]'::json)
                FROM communities_articles_roles_permissions carp2
                INNER JOIN roles r2
                  ON r2."id" = carp2."roleId" AND r2."deletedAt" IS NULL
                WHERE carp2."communityId" = ca."communityId" AND carp2."articleId" = ca."articleId"
              )
            )
          ELSE NULL
        END AS "communityArticle",
        CASE
          WHEN ua."userId" IS NOT NULL THEN
            json_build_object(
              'userId', ua."userId",
              'articleId', ua."articleId",
              'url', ua."url",
              'published', ua."published",
              'updatedAt', ua."updatedAt"
            )
          ELSE NULL
        END AS "userArticle"
      FROM articles a
      LEFT JOIN communities_articles ca
        ON a."id" = ca."articleId" AND ca."deletedAt" IS NULL
      LEFT JOIN communities_articles_roles_permissions carp
        ON ca."communityId" = carp."communityId" AND ca."articleId" = carp."articleId"
      LEFT JOIN roles r
        ON r."id" = carp."roleId" AND r."deletedAt" IS NULL
      ${!!userId ? `LEFT JOIN roles_users_users ruu
        ON r."id" = ruu."roleId" AND ruu."claimed" = TRUE` : ''}
      LEFT JOIN users_articles ua
        ON a."id" = ua."articleId" AND ua."deletedAt" IS NULL
      WHERE a."deletedAt" IS NULL
      ${whereArray.length > 0 ? `AND (${whereArray.join(' AND ')})` : ''}
      -- community article requirement only
      AND (ua."userId" IS NOT NULL OR (
        (
          ${!!userId
            ? format('ruu."userId" = %L::UUID OR', userId)
            : ''}
          (
            r.title = 'Public' AND r.type = 'PREDEFINED'
          )
        )
        AND carp."permissions" @> ${format(
          'ARRAY[%L]::"public"."communities_articles_roles_permissions_permissions_enum"[]',
          ArticlePermission.ARTICLE_PREVIEW
        )}
      ))
      -- check if published
      AND (ua."userId" IS NOT NULL OR ca."published" IS NOT NULL)
      AND (ca."communityId" IS NOT NULL OR ua."published" < now())
      ORDER BY COALESCE(ca."published", ua."published") DESC
      LIMIT $1 OFFSET $2
    `;

    const result = await pool.query<{
      article: {
        articleId: string;
        title: string;
        tags: string[];
        previewText: string | null;
        thumbnailImageId: string | null;
        headerImageId: string | null;
        creatorId: string;
      };
      communityArticle: {
        communityId: string;
        articleId: string;
        url: string;
        published: string;
        updatedAt: string;
        sentAsNewsletter: string | null;
        markAsNewsletter: boolean;
        rolePermissions: {
          roleId: string;
          roleTitle: string;
          permissions: ArticlePermission[];
        }[];
      } | null;
      userArticle: {
        userId: string;
        articleId: string;
        url: string;
        published: string;
        updatedAt: string;
      } | null;
    }>(sqlQuery, [limit, offset]);

    return result.rows.map(row => {
      const article = row.article;
      const communityArticle = row.communityArticle;
      const userArticle = row.userArticle;

      if (communityArticle) {
        return {
          article,
          communityArticle
        } as API.Community.getArticleList.Response[number];
      } else if (userArticle) {
        return {
          article,
          userArticle
        } as API.User.getArticleList.Response[number]
      }

      throw new Error('No community or user article found for the given search criteria.');
    });
  }
}

const searchHelper = new SearchHelper();
registerPostRoute<
  API.Search.searchUsers.Request,
  API.Search.searchUsers.Response
>(
  searchRouter,
  '/searchUsers',
  validators.API.Search.searchUsers,
  async (request, response, data) => {
    const users = await searchHelper.searchUsers(data);
    return users;
  }
);


registerPostRoute<
  API.Search.searchArticles.Request,
  API.Search.searchArticles.Response
>(
  searchRouter,
  '/searchArticles',
  validators.API.Search.searchArticles,
  async (request, response, data) => {
    const articles = await searchHelper.searchArticles(data);
    return articles;
  }
);

export default searchRouter;