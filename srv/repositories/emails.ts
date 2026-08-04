// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import format from "pg-format";
import errors from "../common/errors";
import pool from "../util/postgres";
import fileHelper from "./files";
import articleHelper from "./articles";
import urlConfig from '../util/urls';
import { PredefinedRole, RoleType } from "../common/enums";
import { getUrl, getRandomReadableString } from "../common/util";

export type EmailPost = {
    title: string;
    community: string;
    image: string;
    communityImage?: string;
    url: string;
};

const newsletterUsersBaseQuery = ({ select, communityId, roleIds }: {
    select: string;
    communityId: string;
    roleIds: string[];
}) => {
    if (!roleIds || roleIds.length === 0){
        throw new Error(errors.server.INVALID_REQUEST);
    }
    return `
        SELECT ${select}
        FROM users u

        INNER JOIN roles_users_users ruu
            ON u.id = ruu."userId"
            AND ruu.claimed = TRUE
            AND ruu."roleId" = ANY(ARRAY[${format("%L", roleIds)}]::UUID[])

        INNER JOIN roles r
            ON r.id = ruu."roleId"
            AND r."communityId" = ${format("%L", communityId)}
            AND r."deletedAt" IS NULL

        INNER JOIN user_community_state ucs
            ON u.id = ucs."userId"
            AND ucs."communityId" = ${format("%L", communityId)}
            AND ucs."newsletterJoinedAt" IS NOT NULL
            AND ucs."newsletterLeftAt" IS NULL

        WHERE u."emailVerified" = TRUE
            AND u."deletedAt" IS NULL
    `;
}

function getArticleUrl(options: {
    communityUrl: string;
    articleTitle: string;
    articleId: string;
}) {
    const {
        communityUrl,
        articleId,
        articleTitle
    } = options;
    return `${urlConfig.APP_URL}${getUrl({
        type: 'community-article',
        community: {
            url: communityUrl
        },
        article: {
            articleId,
            title: articleTitle
        }
    })}`;
}

class EmailHelper {
    public async getGeneralCommunityPosts(): Promise<EmailPost[]> {
        const articles = await articleHelper.getCommunityArticleListForEmails(undefined, {
            limit: 10,
            publishedAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toDateString(),
        });
        const emailPosts: EmailPost[] = articles.map((article) => ({
            title: article.communityArticle.articleTitle,
            community: article.communityArticle.communityTitle,
            image: article.communityArticle.articleHeaderImageId,
            communityImage: article.communityArticle.communityImageId,
            url: getArticleUrl({
                communityUrl: article.communityArticle.communityUrl,
                articleId: article.communityArticle.id,
                articleTitle: article.communityArticle.articleTitle
            })
        }));
        for (const emailPost of emailPosts) {
            const newImage = await fileHelper.getSignedUrls([emailPost.image]);
            emailPost.image = newImage[0].url;
            const newCommunityImage = await fileHelper.getSignedUrls([emailPost.communityImage || '']);
            emailPost.communityImage = newCommunityImage[0].url;
        }
        return emailPosts;
    }

    public async getPostsFromFollowedCommunities(userId: string): Promise<EmailPost[]> {
        const articles = await articleHelper.getCommunityArticleListForEmails(userId, {
            limit: 10,
            publishedAfter: new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toDateString(),
        });
        const emailPosts: EmailPost[] = articles.map((article) => ({
            title: article.communityArticle.articleTitle,
            community: article.communityArticle.communityTitle,
            image: article.communityArticle.articleHeaderImageId,
            communityImage: article.communityArticle.communityImageId,
            url: getArticleUrl({
                communityUrl: article.communityArticle.communityUrl,
                articleId: article.communityArticle.id,
                articleTitle: article.communityArticle.articleTitle
            })
        }));
        for (const emailPost of emailPosts) {
            const newImage = await fileHelper.getSignedUrls([emailPost.image]);
            emailPost.image = newImage[0].url;
            const newCommunityImage = await fileHelper.getSignedUrls([emailPost.communityImage || '']);
            emailPost.communityImage = newCommunityImage[0].url;
        }
        return emailPosts;
    }

    public async prepareArticleToSendViaEmail(articleId: string, communityId: string): Promise<{
        recipients: string[];
        emailPost: EmailPost | null;
    }> {
        const result = await pool.query<{
            roleId: string;
            roleTitle: string;
            roleType: RoleType;
            permissions: Common.ArticlePermission[] | null;
        }>(`
            SELECT
                r.id AS "roleId",
                r.title AS "roleTitle",
                r."type" AS "roleType",
                carp.permissions
            FROM roles r
            LEFT JOIN communities_articles_roles_permissions carp
                ON carp."roleId" = r.id
                AND carp."articleId" = ${format("%L", articleId)}
            WHERE r."communityId" = ${format("%L", communityId)}
        `);

        let memberRole: typeof result.rows[number] | undefined;
        let addMemberRole = false;
        const roleIdSet = new Set<string>();

        for (const roleData of result.rows) {
            if (roleData.roleType === RoleType.PREDEFINED) {
                if (roleData.roleTitle === PredefinedRole.Admin) {
                    continue;
                }
                else if (roleData.roleTitle === PredefinedRole.Member) {
                    memberRole = roleData;
                    if (roleData.permissions?.includes("ARTICLE_READ")) {
                        roleIdSet.add(roleData.roleId);
                    }
                }
                else if (roleData.roleTitle === PredefinedRole.Public && roleData.permissions?.includes("ARTICLE_READ")) {
                    addMemberRole = true;
                }
            }
            else if (roleData.permissions?.includes("ARTICLE_READ")) {
                roleIdSet.add(roleData.roleId);
            }
        }

        if (addMemberRole && !!memberRole) {
            roleIdSet.add(memberRole.roleId);
        }

        if (roleIdSet.size === 0) {
            return {
                recipients: [],
                emailPost: null,
            };
        }        

        const query = newsletterUsersBaseQuery({
            select: `DISTINCT u.email, u.id`,
            communityId,
            roleIds: Array.from(roleIdSet),
        });

        const usersEmailsToSent = await pool.query<{ email: string, id: string }>(query);
        console.log('found users to send email: ', usersEmailsToSent.rows.length);
        if (usersEmailsToSent.rowCount === 0) {
            throw new Error(errors.server.NO_USERS_TO_SEND_EMAIL);
        }

        console.log('fetching article to send to user: ', usersEmailsToSent.rows[0].id);
        const article = await articleHelper.getCommunityArticleListForEmails(usersEmailsToSent.rows[0].id, {
            limit: 1,
            communityId: communityId,
            ids: [articleId],
        });

        if (article.length === 0) {
            throw new Error(errors.server.NOT_FOUND);
        }
        const recipients = usersEmailsToSent.rows.map((user) => user.email);
        const emailPost: EmailPost = {
            title: article[0].communityArticle.articleTitle,
            community: article[0].communityArticle.communityTitle,
            image: article[0].communityArticle.articleHeaderImageId,
            communityImage: article[0].communityArticle.communityImageId,
            url: getArticleUrl({
                communityUrl: article[0].communityArticle.communityUrl,
                articleId: article[0].communityArticle.id,
                articleTitle: article[0].communityArticle.articleTitle
            })
        };

        const newImage = await fileHelper.getSignedUrls([emailPost.image]);
        emailPost.image = newImage[0].url;
        const newCommunityImage = await fileHelper.getSignedUrls([emailPost.communityImage || '']);
        emailPost.communityImage = newCommunityImage[0].url;

        return { recipients, emailPost };
    }

    public async getMembersCountForNewsletter({ communityId, roleIds }: { communityId: string, roleIds: string[] }): Promise<number> {
        if (roleIds.length === 0) return 0;
        const query = newsletterUsersBaseQuery({
            select: `COUNT(DISTINCT u.id) as "count"`,
            communityId,
            roleIds,
        });
        const result = await pool.query<{ count: number }>(query);
        return Number(result.rows[0]?.count) || 0;
    }

    public async updateVerifiedStatusesFromBouncedEmails(bouncedEmails: string[]): Promise<void> {
        await pool.query(
            format(`
                UPDATE users
                SET email_verified = false
                WHERE email = ANY(%L)
            `, bouncedEmails)
        );
    }

    public async generateVerificationEmailToken(userId: string): Promise<string> {
        let query = `
            SELECT "verificationCode"
            FROM users
            WHERE id = $1 AND "verificationCodeExpiration" > NOW()
        `;
        let result = await pool.query(query, [userId]);

        if ((result.rowCount ?? 0) > 0) {
            return result.rows[0].verificationCode;
        }

        const expireDate = new Date(Date.now() + 48 * 60 * 60 * 1000);
        const token = getRandomReadableString(10);
        query = `
            UPDATE users
            SET "verificationCode" = $2, "verificationCodeExpiration" = $3
            WHERE id = $1
            RETURNING "verificationCode"
        `;
        result = await pool.query(query, [userId, token, expireDate]);

        if (result.rowCount === 0) {
            throw new Error(errors.server.VERIFY_EMAIL_TOKEN_GENERATION_FAILED);
        }

        return token;
    }

    public async verifyEmail(email: string, verificationToken: string): Promise<string> {
        const query = `
            SELECT id, "verificationCodeExpiration"
            FROM users
            WHERE "verificationCode" = $1 AND "email" = $2
        `;
        const values = [verificationToken, email];

        const result = await pool.query(query, values);
        if (result.rowCount === 0) {
            throw new Error(errors.server.VERIFY_EMAIL_INVALID_TOKEN);
        } else {
            const userId = result.rows[0].id;
            const expirationDate = result.rows[0].verificationCodeExpiration;
            if (expirationDate <= new Date()) {
                throw new Error(errors.server.VERIFY_EMAIL_EXPIRED_TOKEN);
            }
            const userUpdated = await pool.query<{ userId: string }>(
                format(`
                    UPDATE users
                    SET "emailVerified" = true, "verificationCode" = NULL, "verificationCodeExpiration" = NULL
                    WHERE id = %L
                    RETURNING id as "userId"
                `, userId)
            );
            return userUpdated.rows[0].userId;
        }
    }
}

const emailHelper = new EmailHelper();
export default emailHelper;