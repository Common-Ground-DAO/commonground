// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import format from "pg-format";
import errors from "../common/errors";
import pool from "../util/postgres";
import config from "../common/config";

class PluginHelper {
  public async createPlugin(data: API.Plugins.createPlugin.Request, privateKey: string, publicKey: string) {
    const { name, url, communityId, config, permissions, clonable, description, imageId, requiresIsolationMode, tags } = data;
    const plugin = await pool.query(`
      WITH plugin_insert AS (
        INSERT INTO plugins ("ownerCommunityId", "url", "privateKey", "publicKey", "permissions", "clonable", "description", "imageId", "requiresIsolationMode", "tags")
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
        RETURNING "id" as "pluginId", "url", "permissions", "clonable", "appstoreEnabled", "warnAbusive", "description", "imageId", "ownerCommunityId", "tags"
      ), community_plugin_insert AS (
        INSERT INTO communities_plugins ("communityId", "pluginId", "name", "config")
        VALUES ($1, (SELECT "pluginId" FROM plugin_insert), $11, $12)
        RETURNING "id", "communityId", "name", "config"
      )
      SELECT * FROM plugin_insert, community_plugin_insert
    `, [communityId, url, privateKey, publicKey, permissions, clonable, description, imageId, requiresIsolationMode, tags, name, config]);
    return plugin.rows[0] as {
      id: string;
      communityId: string;
      ownerCommunityId: string;
      pluginId: string;
      name: string;
      config: Models.Plugin.PluginConfig | null;
      url: string;
      tags: string[] | null;
      description: string | null;
      imageId: string | null;
      permissions: Models.Plugin.PluginPermissions | null;
      clonable: boolean;
      appstoreEnabled: boolean;
      requiresIsolationMode: boolean;
      warnAbusive: boolean;
    };
  }

  public async clonePlugin(data: API.Plugins.clonePlugin.Request) {
    const { pluginId, copiedFromCommunityId, targetCommunityId } = data;
    const query = `
    WITH original_community_plugin AS (
      SELECT "name"
      FROM communities_plugins cp
      WHERE "pluginId" = $1 AND "communityId" = $2 AND "deletedAt" IS NULL
    )
    INSERT INTO communities_plugins ("communityId", "pluginId", "name")
    SELECT $3, $1, (SELECT "name" FROM original_community_plugin)
    RETURNING "id";
    `;

    const result = await pool.query(query, [pluginId, copiedFromCommunityId, targetCommunityId]);

    if (result.rowCount === 0) {
      throw new Error(errors.server.NOT_ALLOWED);
    }

    return result.rows[0].id;
  }

  public async updatePlugin(data: API.Plugins.updatePlugin.Request) {
    const { id, name, config, pluginData } = data;
    const query = `${!!pluginData ? `WITH update_plugin_data AS (
      UPDATE plugins
      SET "url" = $4, "permissions" = $5, "clonable" = $6, "description" = $7, "imageId" = $8, "requiresIsolationMode" = $9, "tags" = $10, "updatedAt" = NOW()
      WHERE "id" = $11
    )` : ''}
    UPDATE communities_plugins
    SET "name" = $2, "config" = $3, "updatedAt" = NOW()
    WHERE "id" = $1
    RETURNING *`;

    const parameters: any[] = [id, name, config];
    if (!!pluginData) {
      parameters.push(pluginData.url, pluginData.permissions, pluginData.clonable, pluginData.description, pluginData.imageId, pluginData.requiresIsolationMode, pluginData.tags, pluginData.pluginId);
    }

    const result = await pool.query(query, parameters);
    if (result.rowCount === 0) {
      throw new Error(errors.server.NOT_FOUND);
    }
  }

  public async deletePlugin(id: string): Promise<{ deletedForCommunityIds: string[] }> {
    const communityPlugin = await this.getCommunityPlugin(id);
    const actualPlugin = await this.getPlugin(communityPlugin.pluginId);

    if (actualPlugin.ownerCommunityId === communityPlugin.communityId) {
      const result = await pool.query(`
        WITH plugin_update AS (
          UPDATE plugins SET "deletedAt" = NOW() WHERE id = $1
        )
        UPDATE communities_plugins
        SET "deletedAt" = NOW()
        WHERE "pluginId" = $1
        AND "deletedAt" IS NULL
        RETURNING "communityId"
      `, [actualPlugin.id]);
      if (result.rowCount === 0) {
        throw new Error(errors.server.NOT_FOUND);
      }

      return {
        deletedForCommunityIds: result.rows.map(row => row.communityId),
      };
    } else {
      const result = await pool.query(`
        UPDATE communities_plugins
        SET "deletedAt" = NOW()
        WHERE "id" = $1
        AND "communityId" = $2
      `, [communityPlugin.id, communityPlugin.communityId]);
      if (result.rowCount === 0) {
        throw new Error(errors.server.NOT_FOUND);
      }

      return {
        deletedForCommunityIds: [communityPlugin.communityId],
      };
    }
  }

  public async updatePluginStatePermissions(userId: string, pluginId: string, permissions: Models.Plugin.PluginPermission[]) {
    const result = await pool.query(`
      INSERT INTO user_plugin_state ("userId", "pluginId", "acceptedPermissions")
      VALUES ($1, $2, $3::jsonb)
      ON CONFLICT ("userId", "pluginId")
      DO UPDATE SET "acceptedPermissions" = EXCLUDED."acceptedPermissions"
      RETURNING *;
    `, [userId, pluginId, JSON.stringify(permissions)]);
    
    if (result.rowCount === 0) {
      throw new Error(errors.server.NOT_FOUND);
    }
  }

  public async resetPluginStatePermissions(pluginId: string) {
    await pool.query(`
      UPDATE user_plugin_state SET "acceptedPermissions" = NULL WHERE "pluginId" = $1
    `, [pluginId]);
  }

  public async getCommunitiesWithPlugin(pluginId: string, limit?: number, offset?: number): Promise<string[]> {
    const params: (string | number)[] = [pluginId];    
    let query = `
      SELECT "communityId"
      FROM communities_plugins cp
      WHERE "pluginId" = $1 
      AND "deletedAt" IS NULL
      ORDER BY "createdAt" DESC`;

    if (limit !== undefined) {
      params.push(limit);
      query += ` LIMIT $${params.length}`;
    }

    if (offset !== undefined) {
      params.push(offset);
      query += ` OFFSET $${params.length}`;
    }

    const result = await pool.query(query, params);
    
    return result.rows.map(row => row.communityId);
  }

  public async getCommunityPlugin(communityPluginId: string) {
    const plugin = await pool.query(`
      SELECT id, "communityId", "pluginId", name, config FROM communities_plugins WHERE id = $1 AND "deletedAt" IS NULL
    `, [communityPluginId]);

    return plugin.rows[0] as {
      id: string;
      communityId: string;
      pluginId: string;
      name: string;
      config: Models.Plugin.PluginConfig | null;
    };
  }

  public async getPlugin(pluginId: string) {
    const plugin = await pool.query(`
      SELECT id, url, "imageId", "permissions", "privateKey", "publicKey", "ownerCommunityId" FROM plugins WHERE id = $1 AND "deletedAt" IS NULL
    `, [pluginId]);
    return plugin.rows[0] as {
      id: string;
      url: string;
      imageId: string | null;
      permissions: Models.Plugin.PluginPermissions | null;
      privateKey: string;
      publicKey: string;
      ownerCommunityId: string;
    };
  }

  public async getAppstorePlugin(pluginId: string) {
    const result = await pool.query(`
      SELECT 
        p.id as "pluginId",
        p."ownerCommunityId",
        p.url,
        p."description",
        p."permissions",
        p."imageId",
        p."tags",
        owner_cp."name",
        COUNT(DISTINCT cp."communityId") AS "communityCount",
        p."appstoreEnabled"
      FROM plugins p
      -- Join for counting how many communities use the plugin
      JOIN communities_plugins cp ON p.id = cp."pluginId"
      -- Separate join just to get the name of the owner community
      JOIN communities_plugins owner_cp 
        ON p.id = owner_cp."pluginId" AND owner_cp."communityId" = p."ownerCommunityId"
      WHERE p."deletedAt" IS NULL 
        AND (p."appstoreEnabled" = TRUE OR p."clonable" = TRUE)
        AND p.id = $1
      GROUP BY 
        p.id,
        owner_cp."name"
    `, [pluginId]);

    if (result.rowCount !== 1) {
      throw new Error(errors.server.NOT_FOUND);
    }

    return result.rows[0] as {
      pluginId: string;
      ownerCommunityId: string;
      url: string;
      description: string;
      permissions: Models.Plugin.PluginPermissions;
      imageId: string;
      tags: string[] | null;
      name: string;
      communityCount: number;
      appstoreEnabled: boolean;
    };
  }

  public async getAppstorePlugins(data: {
    query?: string,
    tags?: string[],
    limit: number,
    offset: number
  }) {
    const { query, tags, limit, offset } = data;

    const whereArray: string[] = ['p."deletedAt" IS NULL', '(p."appstoreEnabled" = TRUE OR p."clonable" = TRUE)'];
    if (query !== undefined && query.length > 0) {
      let sqlSafeQuery = query.replace(/\\/g, '\\\\');  // Escape backslashes first (\ -> \\)
      sqlSafeQuery = sqlSafeQuery.replace(/%/g, '\\%');  // Escape % -> \%
      sqlSafeQuery = sqlSafeQuery.replace(/_/g, '\\_');  // Escape _ -> \_
      whereArray.push(`(
        owner_cp."name" ILIKE ${format('%L', `%${sqlSafeQuery}%`)} ESCAPE '\\'
      )`);
    }
    if (!!tags && tags.length > 0) {
      const lowerTagArray = tags.map(t => format('%L', t.toLowerCase())).join(',');
      const tagArrayString = `ARRAY[${lowerTagArray}]`;

      whereArray.push(`(
        SELECT ARRAY_AGG(LOWER(tag)) FROM UNNEST(p."tags") AS tag
      ) @> ${tagArrayString}::text[]`);
    }

    const plugins = await pool.query(`
      SELECT 
        p.id as "pluginId",
        p."ownerCommunityId",
        p.url,
        p."description",
        p."permissions",
        p."imageId",
        p."tags",
        owner_cp."name",
        COUNT(DISTINCT cp."communityId") AS "communityCount",
        p."appstoreEnabled"
      FROM plugins p
      -- Join for counting how many communities use the plugin
      JOIN communities_plugins cp 
        ON p.id = cp."pluginId"
      -- Separate join just to get the name of the owner community
      JOIN communities_plugins owner_cp
        ON p.id = owner_cp."pluginId" 
        AND owner_cp."communityId" = p."ownerCommunityId"
      -- Join reports to check unresolved count
      LEFT JOIN reports r 
        ON r."targetId" = p.id 
        AND r.resolved = false
      WHERE ${whereArray.join(' AND ')}
      GROUP BY 
        p.id,
        owner_cp."name"
      HAVING p."appstoreEnabled" = true 
        OR COUNT(r.id) < ${config.MINIMUM_REPORTS_TO_FLAG_PLUGIN}
      ORDER BY p."appstoreEnabled" DESC, p."createdAt" DESC
      LIMIT $1 OFFSET $2;
    `, [limit, offset]);

    return plugins.rows as {
      pluginId: string;
      ownerCommunityId: string;
      url: string;
      description: string;
      permissions: Models.Plugin.PluginPermissions;
      imageId: string;
      tags: string[] | null;
      name: string;
      communityCount: number;
      appstoreEnabled: boolean;
    }[];
  }

  public async getUserPluginPermissions(userId: string, pluginId: string) {
    const result = await pool.query(`
      SELECT "acceptedPermissions" FROM user_plugin_state WHERE "userId" = $1 AND "pluginId" = $2
    `, [userId, pluginId]);
    // No row = the user has never accepted anything for this plugin. Return an
    // empty set rather than undefined, which callers dereference
    // (.acceptedPermissions) — a first userInfo/userFriends pluginRequest
    // before any acceptPluginPermissions used to NPE here.
    return (result.rows[0] ?? { acceptedPermissions: [] }) as {
      acceptedPermissions: Models.Plugin.PluginPermission[];
    };
  }
}

const pluginHelper = new PluginHelper();
export default pluginHelper;