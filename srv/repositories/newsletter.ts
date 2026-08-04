// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import format from "pg-format";
import pool from "../util/postgres";
import eventHelper from "./event";
import { ArticlePermission, CommunityPermission, PredefinedRole } from "../common/enums";

class NewsletterHelper {

    public async getUserSubscriptions(userId: string): Promise<string[]> {
        const result = await pool.query(
            format(`
                SELECT "communityId"
                FROM user_community_state
                WHERE "userId" = %L AND "newsletterJoinedAt" IS NOT NULL AND "newsletterLeftAt" IS NULL
            `, userId)
        );
        return result.rows.map((row) => row.communityId);
    }

    public async subscribeUser(userId: string, communityIds: string[]): Promise<void> {
        const newCommunityState = await pool.query(
            format(`
                UPDATE user_community_state
                SET
                    "newsletterJoinedAt" = NOW(),
                    "newsletterLeftAt" = NULL
                WHERE "userId" = %L AND "communityId" = ANY(ARRAY[${format("%L", communityIds)}]::uuid[])
                RETURNING "newsletterJoinedAt", "newsletterLeftAt"
            `, userId)
        ) as {
            rows: {
                newsletterJoinedAt: Date,
                newsletterLeftAt: Date
            }[]
        };
        if (newCommunityState.rows.length === 0) {
            console.error(`Failed to subscribe user ${userId} to communities ${JSON.stringify(communityIds)} newsletter`);
            throw new Error('Failed to subscribe user to community newsletter');
        } else {
            for (const communityId of communityIds) {
                eventHelper.emit({
                    type: 'cliCommunityEvent',
                    action: 'update',
                    data: {
                        id: communityId,
                        updatedAt: new Date().toISOString(),
                        myNewsletterEnabled: true,
                    }
                }, {
                    userIds: [userId]
                });
            }
        }
    }

    public async unsubscribeUser(userId: string, communityIds: string[]): Promise<void> {
        const newCommunityState = await pool.query(
            format(`
                UPDATE user_community_state
                SET "newsletterLeftAt" = NOW()
                WHERE "userId" = %L AND "communityId" = ANY(ARRAY[${format("%L", communityIds)}]::uuid[])
                RETURNING "newsletterJoinedAt", "newsletterLeftAt"
            `, userId)
        );
        if (newCommunityState.rows.length === 0) {
            console.error(`Failed to unsubscribe user ${userId} from communities ${JSON.stringify(communityIds)} newsletter `);
            throw new Error('Failed to unsubscribe user from community newsletter');
        } else {
            for (const communityId of communityIds) {
                eventHelper.emit({
                    type: 'cliCommunityEvent',
                    action: 'update',
                    data: {
                        id: communityId,
                        updatedAt: new Date().toISOString(),
                        myNewsletterEnabled: false
                    }
                }, {
                    userIds: [userId]
                });
            }
        }
    }

    public async getUsersEligibleForCommunityNewsletter(communityId: string): Promise<{userId: string, email: string}[]>{
        const result = await pool.query(
            format(`
                SELECT u.id, u.email
                FROM users u
                JOIN user_community_state c ON u.id = c."userId"
                WHERE
                    u."emailVerified" = true AND
                    u."deletedAt" IS NULL AND
                    c."communityId" = %L AND
                    c."newsletterJoinedAt" is NOT NULL AND
                    c."newsletterLeftAt" is NULL 
            `, communityId)
        );
        return result.rows.map((row) => {
            return {
                userId: row.id,
                email: row.email
            };
        });
    }

    public async updateSentAtCommunityNewsletterStatus(articleId: string, communityId: string): Promise<void> {
        await pool.query(
            format(`
                UPDATE communities_articles
                SET "sentAsNewsletter" = NOW()
                WHERE "articleId" = %L AND "communityId" = %L
            `, articleId, communityId)
        );
    }

    //go through user_newsletter_status and check if the user has been sent a newsletter in the last 7 days
    public async getNewsletterStatus(userId: string): Promise<boolean> {
        const result = await pool.query(
            format(`
                SELECT id
                FROM user_newsletter_status
                WHERE "userId" = %L AND "sentAt" > NOW() - INTERVAL '7 days'
            `, userId)
        );
        return (result.rowCount ?? 0) > 0;
    }

    public async createNewsletterEntries(newsletterId: number): Promise<{userId: string, email: string}[]> {
        const query = `
            WITH eligible_users AS (
                SELECT id, email
                FROM users u 
                WHERE u."weeklyNewsletter" = true AND u."emailVerified" = true AND u."deletedAt" IS NULL
            )
            INSERT INTO user_newsletter_status ("userId", "newsletterId")
            SELECT eu.id, $1
            FROM eligible_users eu
            WHERE eu.id NOT IN (
                SELECT "userId"
                FROM user_newsletter_status
                WHERE "newsletterId" = $1
            )
            RETURNING "userId", (
                SELECT email
                FROM users
                WHERE id = user_newsletter_status."userId"
            )
        `;
        const entries = await pool.query<{userId: string, email: string}>(query, [newsletterId]);
        return entries.rows;
    }

    public async getNewsletterEntries(newsletterId: number): Promise<{userId: string, email: string}[]> {
        const result = await pool.query(
            format(`
                SELECT "userId", (
                    SELECT email
                    FROM users
                    WHERE id = user_newsletter_status."userId"
                ) as email
                FROM user_newsletter_status
                WHERE "newsletterId" = %L
            `, newsletterId)
        );
        return result.rows.map((row) => {
            return {
                userId: row.userId,
                email: row.email
            };
        });
    }

    public async updateSentAtNewsletterStatus(newsletterId: number, userId: string): Promise<void> {
        await pool.query(
            format(`
                UPDATE user_newsletter_status
                SET "sentAt" = NOW()
                WHERE "newsletterId" = %L AND "userId" = %L
            `, newsletterId, userId)
        );
    }

    public async getLatestCommunityNewsletterSentDate(communityId: string): Promise<string | null> {
        const result = await pool.query(
            format(`
                SELECT MAX("sentAsNewsletter") as "sentAsNewsletter"
                FROM communities_articles
                WHERE "communityId" = %L
            `, communityId)
        );
        return result.rows[0].sentAsNewsletter;
    }

    public async getNewsletterHistory(userId: string, communityId: string, cutDate: string): Promise<Models.Community.NewsletterHistory[]> {
        const result = await pool.query<{
            id: string;
            title: string;
            creatorId: string;
            markAsNewsletter: boolean;
            sentAsNewsletter: string | null;
            url: string | null;
        }>(`
            SELECT
                a."id",
                a."title",
                a."creatorId",
                ca."markAsNewsletter",
                ca."sentAsNewsletter",
                ca."url"
            FROM communities_articles ca
            INNER JOIN articles a
                ON ca."articleId" = a."id"
            INNER JOIN communities_articles_roles_permissions carp
                ON ca."communityId" = carp."communityId"
                    AND ca."articleId" = carp."articleId"
            INNER JOIN roles r
                ON carp."roleId" = r."id"
                AND r."deletedAt" IS NULL
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
            AND ca."markAsNewsletter" = true
            AND (
                ca."sentAsNewsletter" IS NULL
                OR ${format('ca."sentAsNewsletter" > %L::timestamptz', cutDate)}
            )
            AND (
                (
                    carp."permissions" @> ${format('ARRAY[%L]::"public"."communities_articles_roles_permissions_permissions_enum"[]', ArticlePermission.ARTICLE_READ)}
                    AND ca."published" < now()
                )
                OR r."permissions" @> ${format('ARRAY[%L]::"public"."roles_permissions_enum"[]', CommunityPermission.COMMUNITY_MANAGE_ARTICLES)}
            )
            GROUP BY a."id", ca."markAsNewsletter", ca."sentAsNewsletter", ca."url"
            ORDER BY ca."sentAsNewsletter" DESC
        `, [communityId]);
        return result.rows;
    }
}

const newsletterHelper = new NewsletterHelper();
export default newsletterHelper;