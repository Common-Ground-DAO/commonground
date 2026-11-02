// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { CommunityPermission, ChannelPermission, ArticlePermission, PredefinedRole, RoleType, CallPermission, CommunityEventPermission } from "../common/enums";
import format from "pg-format";
import errors from "../common/errors";
import pool from "../util/postgres";

type RolePermission<T extends ChannelPermission | ArticlePermission | CommunityPermission | CallPermission | CommunityEventPermission> = {
  title: string;
  id: string;
  type: RoleType,
  permissions: T[],
}

class PermissionHelper {
  public async getRolePermissions(options: { communityId: string, channelId: string }): Promise<RolePermission<ChannelPermission>[]>
  public async getRolePermissions(options: { callId: string, channelId: string }): Promise<RolePermission<CallPermission>[]>
  public async getRolePermissions(options: { communityEventId: string }): Promise<RolePermission<CommunityEventPermission>[]>
  public async getRolePermissions(options: { communityId: string, articleId: string }): Promise<RolePermission<ArticlePermission>[]>
  public async getRolePermissions(options: { communityId: string }): Promise<RolePermission<CommunityPermission>[]>
  public async getRolePermissions(options: { communityId?: string, callId?: string, channelId?: string, articleId?: string, communityEventId?: string }): Promise<any> {
    let query: string, params: any[];
    if (!!options.channelId) {
      if (!!options.callId) {
        query = `
          SELECT
            r."title",
            r."id",
            r."type",
            array_to_json(cp."permissions") as "permissions"
          FROM callpermissions cp
          INNER JOIN roles r
            ON r."id" = cp."roleId"
            AND r."deletedAt" IS NULL
          INNER JOIN calls c
            ON cp."callId" = c."id"
          WHERE
            cp."callId" = $1 AND
            c."channelId" = $2
        `;
        params = [
          options.callId,
          options.channelId,
        ];
      }
      else if (!!options.communityId) {
        query = `
          SELECT
            r."title",
            r."id",
            r."type",
            array_to_json(ccrp."permissions") as "permissions"
          FROM communities_channels_roles_permissions ccrp
          INNER JOIN roles r
            ON r."id" = ccrp."roleId"
            AND r."deletedAt" IS NULL
          WHERE
            ccrp."communityId" = $1 AND
            ccrp."channelId" = $2
        `;
        params = [
          options.communityId,
          options.channelId,
        ];
      }
      else {
        throw new Error(`Invalid parameters`);
      }
    }
    else if (!!options.communityId) {
      if (!!options.articleId) {
        query = `
          SELECT
            r."title",
            r."id",
            r."type",
            array_to_json(carp."permissions") as "permissions"
          FROM communities_articles_roles_permissions carp
          INNER JOIN roles r
            ON r."id" = carp."roleId"
            AND r."deletedAt" IS NULL
          WHERE
            carp."communityId" = $1 AND
            carp."articleId" = $2
        `;
        params = [
          options.communityId,
          options.articleId,
        ];
      }
      else {
        query = `
          SELECT
            r."title",
            r."id",
            r."type",
            array_to_json(r."permissions") as "permissions"
          FROM roles r
          WHERE r."communityId" = $1
            AND r."deletedAt" IS NULL
        `;
        params = [
          options.communityId,
        ];
      }
    }
    else if(!!options.communityEventId){
      query = `
        SELECT
          r."title",
          r."id",
          r."type",
          array_to_json(cep."permissions") as "permissions"
        FROM roles r
        INNER JOIN communities_events_permissions cep
          ON r."id" = cep."roleId"
        WHERE cep."communityEventId" = $1
          AND r."deletedAt" IS NULL
      `;
      params = [
        options.communityEventId,
      ];
    }
    else {
      throw new Error(`Invalid parameters`);
    }

    const result = await pool.query(query, params);
    return result.rows;
  }

  public async getPermissions(options: { userId?: string, communityId: string, channelId: string }): Promise<Set<ChannelPermission>>
  public async getPermissions(options: { userId?: string, callId: string, channelId?: string }): Promise<Set<CallPermission>>
  public async getPermissions(options: { userId?: string, communityEventId: string }): Promise<Set<CommunityEventPermission>>
  public async getPermissions(options: { userId?: string, communityId: string, articleId: string }): Promise<Set<ArticlePermission>>
  public async getPermissions(options: { userId?: string, communityId: string }): Promise<Set<CommunityPermission>>
  public async getPermissions(options: { userId?: string, communityId?: string, callId?: string, channelId?: string, articleId?: string, communityEventId?: string }): Promise<any> {
    let query: string, params: any[];
    if (!!options.callId) {
      query = `
        SELECT array_to_json(cp."permissions") AS "permissions"
        FROM roles r
        INNER JOIN callpermissions cp
          ON r."id" = cp."roleId"
        LEFT JOIN roles_users_users ruu
          ON (r."id" = ruu."roleId" AND ruu.claimed = TRUE)
        WHERE r."deletedAt" IS NULL
          AND (
            ${!!options.userId ? 'ruu."userId" = $2 OR' : ''}
            r."title" = ${format('%L', PredefinedRole.Public)}
          )
          AND cp."callId" = $1
      `;
      params = [
        options.callId,
      ];
    }
    else if (!!options.communityId) {
      if (!!options.channelId) {
        query = `
          SELECT array_to_json(ccrp."permissions") AS "permissions"
          FROM roles r
          INNER JOIN communities_channels_roles_permissions ccrp
            ON r."id" = ccrp."roleId"
          LEFT JOIN roles_users_users ruu
            ON (r."id" = ruu."roleId" AND ruu.claimed = TRUE)
          WHERE r."deletedAt" IS NULL
            AND (
              ${!!options.userId ? 'ruu."userId" = $3 OR' : ''}
              r."title" = ${format('%L', PredefinedRole.Public)}
            )
            AND ccrp."communityId" = $1
            AND ccrp."channelId" = $2
        `;
        params = [
          options.communityId,
          options.channelId
        ];
      }
      else if (!!options.articleId) {
        query = `
          SELECT array_to_json(carp."permissions") AS "permissions"
          FROM roles r
          INNER JOIN communities_articles_roles_permissions carp
            ON r."id" = carp."roleId"
          LEFT JOIN roles_users_users ruu
            ON (r."id" = ruu."roleId" AND ruu.claimed = TRUE)
          WHERE r."deletedAt" IS NULL
            AND (
              ${!!options.userId ? 'ruu."userId" = $3 OR' : ''}
              r."title" = ${format('%L', PredefinedRole.Public)}
            )
            AND carp."communityId" = $1
            AND carp."articleId" = $2
        `;
        params = [
          options.communityId,
          options.articleId
        ];
      }
      else {
        query = `
          SELECT array_to_json(r."permissions") AS "permissions"
          FROM roles r
          LEFT JOIN roles_users_users ruu
            ON (r."id" = ruu."roleId" AND ruu.claimed = TRUE)
          WHERE r."deletedAt" IS NULL
            AND (
              ${!!options.userId ? 'ruu."userId" = $2 OR' : ''}
              r."title" = ${format('%L', PredefinedRole.Public)}
            )
            AND r."communityId" = $1
        `;
        params = [
          options.communityId
        ];
      }
    }
    else if(!!options.communityEventId) {
      query = `
        SELECT array_to_json(cep."permissions") AS "permissions"
        FROM roles r
        INNER JOIN communities_events_permissions cep
          ON r."id" = cep."roleId"
        LEFT JOIN roles_users_users ruu
          ON (r."id" = ruu."roleId" AND ruu.claimed = TRUE)
        WHERE r."deletedAt" IS NULL
          AND (
            ${!!options.userId ? 'ruu."userId" = $2 OR' : ''}
            r."title" = ${format('%L', PredefinedRole.Public)}
          )
          AND cep."communityEventId" = $1
      `;
      params = [
        options.communityEventId
      ];
    }
    else {
      throw new Error(`Invalid parameters`);
    }

    if (!!options.userId) {
      params.push(options.userId);
    }
    const result = await pool.query(query, params);
    const rows: {
      permissions: ChannelPermission[] | ArticlePermission[] | CommunityPermission[] | CallPermission[] | CommunityEventPermission[] | CommunityEventPermission[];
    }[] = result.rows;

    return rows.reduce<Set<any>>((agg, row) => {
      for (const p of row.permissions) {
        agg.add(p);
      }
      return agg;
    }, new Set());
  }

  public async hasPermissions(options: { userId?: string, communityId: string, channelId: string, permissions: ChannelPermission[] }): Promise<boolean>
  public async hasPermissions(options: { userId?: string, callId: string, channelId?: string, permissions: CallPermission[] }): Promise<boolean>
  public async hasPermissions(options: { userId?: string, communityEventId: string, permissions: CommunityEventPermission[] }): Promise<boolean>
  public async hasPermissions(options: { userId?: string, communityId: string, articleId: string, permissions: ArticlePermission[] }): Promise<boolean>
  public async hasPermissions(options: { userId?: string, communityId: string, permissions: CommunityPermission[] }): Promise<boolean>
  public async hasPermissions(options: { userId?: string, communityId?: string, callId?: string, channelId?: string, articleId?: string, permissions: any[] }): Promise<boolean> {
    const permissions: Set<any> = await this.getPermissions(options as any);
    // console.log(`Permissions for user ${options.userId || "no-id"}, communityId: ${options.communityId}, callId: ${options.callId}, channelId: ${options.channelId}, articleId: ${options.articleId}, permissions: ${JSON.stringify(options.permissions)}, result from db: ${JSON.stringify(Array.from(permissions))}`)
    return options.permissions.every(p => permissions.has(p));
  }


  public async hasPermissionsOrThrow(options: { userId?: string, communityId: string, channelId: string, permissions: ChannelPermission[] }): Promise<void>
  public async hasPermissionsOrThrow(options: { userId?: string, callId: string, channelId?: string, permissions: CallPermission[] }): Promise<void>
  public async hasPermissionsOrThrow(options: { userId?: string, communityEventId: string, permissions: CommunityEventPermission[] }): Promise<void>
  public async hasPermissionsOrThrow(options: { userId?: string, communityId: string, articleId: string, permissions: ArticlePermission[] }): Promise<void>
  public async hasPermissionsOrThrow(options: { userId?: string, communityId: string, permissions: CommunityPermission[] }): Promise<void>
  public async hasPermissionsOrThrow(options: { userId?: string, communityId?: string, callId?: string, channelId?: string, articleId?: string, permissions: any[] }): Promise<void> {
    const hasPermissions = await this.hasPermissions(options as any);
    if (!hasPermissions) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
  }

  /**
   * Whether `userId` is a member of the community `communityId`: holds at
   * least one claimed, live role of it, and the community is not deleted.
   */
  public async isMemberOfActiveCommunity(userId: string, communityId: string): Promise<boolean> {
    const result = await pool.query(`
      SELECT 1
      FROM roles_users_users ruu
      INNER JOIN roles r
        ON r."id" = ruu."roleId"
      INNER JOIN communities c
        ON c."id" = r."communityId"
      WHERE ruu."userId" = $1
        AND r."communityId" = $2
        AND ruu.claimed = TRUE
        AND r."deletedAt" IS NULL
        AND c."deletedAt" IS NULL
      LIMIT 1
    `, [userId, communityId]);
    return result.rows.length > 0;
  }

  public async hasTrustOrThrow(options: { userId: string, trust: string }): Promise<void> {
    const query = `
      SELECT id
      FROM users
      WHERE id = $1 AND "trustScore" >= $2
    `;
    const result =  await pool.query(query, [options.userId, options.trust]);
    if (result.rows.length === 0) {
      throw new Error(errors.server.INSUFFICIENT_TRUST);
    }
  }
}

const permissionHelper = new PermissionHelper();
export default permissionHelper;