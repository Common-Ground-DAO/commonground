// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { type PoolClient } from "pg";
import {
  BotOwnerType,
  BotPlatformPresenceMode,
  CommunityPermission,
  PredefinedRole,
  RoleType,
} from "../common/enums";
import errors from "../common/errors";
import pool from "../util/postgres";
import serverconfig from "../serverconfig";
import userHelper, { type CreateBotUserData } from "./users";
import eventHelper from "./event";

type BotRecord = {
  userId: string;
  deviceId: string;
  ownerType: Models.User.BotOwnerType;
  ownerId: string | null;
  platformPresenceMode: Models.User.BotPlatformPresenceMode | null;
  deletedAt: string | null;
};

type MembershipChange = {
  communityId: string;
  userId: string;
  memberRoleId: string;
  roleIds: string[];
  communityOrder: string[];
  memberCount: number;
  updatedAt: string;
};

type RoleChange = {
  communityId: string;
  userId: string;
  addedRoleIds: string[];
  removedRoleIds: string[];
};

const platformOperatorIds = new Set(serverconfig.PLATFORM_OPERATOR_USER_IDS);

async function _assertHumanActor(db: PoolClient, actorUserId: string) {
  const result = await db.query(`
    SELECT 1
    FROM users
    WHERE id = $1
      AND is_bot = FALSE
      AND "deletedAt" IS NULL
  `, [actorUserId]);
  if (result.rowCount !== 1) {
    throw new Error(errors.server.NOT_ALLOWED);
  }
}

async function _assertCommunityManager(db: PoolClient, actorUserId: string, communityId: string) {
  const result = await db.query(`
    SELECT 1
    FROM roles_users_users ruu
    INNER JOIN roles r ON r.id = ruu."roleId"
    INNER JOIN users u ON u.id = ruu."userId"
    INNER JOIN communities c ON c.id = r."communityId"
    WHERE ruu."userId" = $1
      AND r."communityId" = $2
      AND ruu.claimed = TRUE
      AND $3::text = ANY(r.permissions::text[])
      AND r."deletedAt" IS NULL
      AND u.is_bot = FALSE
      AND u."deletedAt" IS NULL
      AND c."deletedAt" IS NULL
    LIMIT 1
  `, [actorUserId, communityId, CommunityPermission.COMMUNITY_MANAGE_ROLES]);
  if (result.rowCount !== 1) {
    throw new Error(errors.server.NOT_ALLOWED);
  }
}

async function _assertOwnerAuthorization(
  db: PoolClient,
  actorUserId: string,
  ownerType: Models.User.BotOwnerType,
  ownerId: string | null,
) {
  await _assertHumanActor(db, actorUserId);
  if (ownerType === BotOwnerType.USER) {
    if (ownerId !== actorUserId) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
    return;
  }
  if (ownerType === BotOwnerType.COMMUNITY) {
    if (!ownerId) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    await _assertCommunityManager(db, actorUserId, ownerId);
    return;
  }
  if (ownerType === BotOwnerType.PLATFORM && ownerId === null && platformOperatorIds.has(actorUserId)) {
    return;
  }
  throw new Error(errors.server.NOT_ALLOWED);
}

async function _getBot(db: PoolClient, botUserId: string, activeOnly = true): Promise<BotRecord> {
  const result = await db.query<BotRecord>(`
    SELECT
      b."userId",
      b."deviceId",
      b."ownerType",
      b."ownerId",
      b."platformPresenceMode",
      b."deletedAt"
    FROM bots b
    INNER JOIN users u ON u.id = b."userId"
    WHERE b."userId" = $1
      AND u.is_bot = TRUE
      AND u."deletedAt" IS NULL
      ${activeOnly ? 'AND b."deletedAt" IS NULL' : ''}
    FOR UPDATE OF b
  `, [botUserId]);
  if (result.rowCount !== 1) {
    throw new Error(errors.server.NOT_FOUND);
  }
  return result.rows[0];
}

async function _getBotView(db: PoolClient, botUserId: string): Promise<API.Bot.BotView> {
  const result = await db.query<API.Bot.BotView>(`
    SELECT
      b."userId",
      b."deviceId",
      b."ownerType",
      b."ownerId",
      ua."displayName",
      ua."imageId",
      b.description,
      CASE WHEN b."ownerType" = 'platform' THEN json_build_object(
        'mode', b."platformPresenceMode",
        'communityIds', COALESCE((
          SELECT json_agg(bpc."communityId" ORDER BY bpc."communityId")
          FROM bots_platform_communities bpc
          WHERE bpc."botUserId" = b."userId"
        ), '[]'::json)
      ) ELSE NULL END AS "platformPresence",
      COALESCE((
        SELECT json_agg(memberships."communityId" ORDER BY memberships."communityId")
        FROM (
          SELECT DISTINCT r."communityId"
          FROM roles_users_users ruu
          INNER JOIN roles r ON r.id = ruu."roleId"
          INNER JOIN communities c ON c.id = r."communityId"
          WHERE ruu."userId" = b."userId"
            AND r.title = $2
            AND r.type = $3
            AND r."deletedAt" IS NULL
            AND c."deletedAt" IS NULL
        ) memberships
      ), '[]'::json) AS "communityIds",
      b."createdAt",
      b."updatedAt",
      b."deletedAt" AS "disabledAt"
    FROM bots b
    INNER JOIN user_accounts ua
      ON ua."userId" = b."userId"
      AND ua.type = 'bot'
      AND ua."deletedAt" IS NULL
    WHERE b."userId" = $1
  `, [botUserId, PredefinedRole.Member, RoleType.PREDEFINED]);
  if (result.rowCount !== 1) {
    throw new Error(errors.server.NOT_FOUND);
  }
  return result.rows[0];
}

function _ownerLockKey(ownerType: Models.User.BotOwnerType, ownerId: string | null) {
  return `bot-owner:${ownerType}:${ownerId || 'platform'}`;
}

function _ownerLimit(ownerType: Models.User.BotOwnerType) {
  if (ownerType === BotOwnerType.USER) return serverconfig.BOT_USER_OWNER_LIMIT;
  if (ownerType === BotOwnerType.COMMUNITY) return serverconfig.BOT_COMMUNITY_OWNER_LIMIT;
  return serverconfig.BOT_PLATFORM_OWNER_LIMIT;
}

async function _assertOwnerLimit(db: PoolClient, ownerType: Models.User.BotOwnerType, ownerId: string | null) {
  await db.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [_ownerLockKey(ownerType, ownerId)]);
  const result = await db.query<{ count: string }>(`
    SELECT count(*)::text AS count
    FROM bots
    WHERE "ownerType" = $1
      AND "ownerId" IS NOT DISTINCT FROM $2::uuid
      AND "deletedAt" IS NULL
  `, [ownerType, ownerId]);
  if (Number(result.rows[0].count) >= _ownerLimit(ownerType)) {
    throw new Error(errors.server.NOT_ALLOWED);
  }
}

async function _validateSelectedCommunities(db: PoolClient, communityIds: string[]) {
  if (communityIds.length === 0) return;
  const result = await db.query<{ id: string }>(`
    SELECT id
    FROM communities
    WHERE id = ANY($1::uuid[])
      AND "deletedAt" IS NULL
  `, [communityIds]);
  if (result.rowCount !== communityIds.length) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
}

async function _replacePlatformSelections(db: PoolClient, botUserId: string, communityIds: string[]) {
  await _validateSelectedCommunities(db, communityIds);
  await db.query(`DELETE FROM bots_platform_communities WHERE "botUserId" = $1`, [botUserId]);
  if (communityIds.length > 0) {
    await db.query(`
      INSERT INTO bots_platform_communities ("botUserId", "communityId")
      SELECT $1, unnest($2::uuid[])
    `, [botUserId, communityIds]);
  }
}

async function _assertBotPolicy(db: PoolClient, bot: BotRecord, communityId: string) {
  const community = await db.query<{ allowUserBots: boolean }>(`
    SELECT "allowUserBots"
    FROM communities
    WHERE id = $1 AND "deletedAt" IS NULL
  `, [communityId]);
  if (community.rowCount !== 1) {
    throw new Error(errors.server.NOT_FOUND);
  }
  if (bot.ownerType === BotOwnerType.COMMUNITY && bot.ownerId !== communityId) {
    throw new Error(errors.server.NOT_ALLOWED);
  }
  if (bot.ownerType === BotOwnerType.USER) {
    if (!community.rows[0].allowUserBots) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
    const ownerMembership = await db.query(`
      SELECT 1
      FROM roles_users_users ruu
      INNER JOIN roles r ON r.id = ruu."roleId"
      INNER JOIN users u ON u.id = ruu."userId"
      WHERE ruu."userId" = $1
        AND r."communityId" = $2
        AND r.title = $3
        AND r.type = $4
        AND ruu.claimed = TRUE
        AND r."deletedAt" IS NULL
        AND u.is_bot = FALSE
        AND u."deletedAt" IS NULL
    `, [bot.ownerId, communityId, PredefinedRole.Member, RoleType.PREDEFINED]);
    if (ownerMembership.rowCount !== 1) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
  }
  if (bot.ownerType === BotOwnerType.PLATFORM && bot.platformPresenceMode === BotPlatformPresenceMode.SELECTED) {
    const selected = await db.query(`
      SELECT 1 FROM bots_platform_communities
      WHERE "botUserId" = $1 AND "communityId" = $2
    `, [bot.userId, communityId]);
    if (selected.rowCount !== 1) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
  }
}

async function _installMembership(db: PoolClient, botUserId: string, communityId: string): Promise<MembershipChange | null> {
  const result = await db.query<MembershipChange>(`
    WITH member_role AS (
      SELECT id
      FROM roles
      WHERE "communityId" = $2
        AND title = $3
        AND type = $4
        AND "deletedAt" IS NULL
    ),
    role_insert AS (
      INSERT INTO roles_users_users ("roleId", "userId", claimed)
      SELECT id, $1, TRUE FROM member_role
      ON CONFLICT ("userId", "roleId") DO NOTHING
      RETURNING "roleId"
    ),
    user_update AS (
      UPDATE users
      SET "communityOrder" = CASE
        WHEN "communityOrder" @> ARRAY[$2::uuid] THEN "communityOrder"
        ELSE array_append("communityOrder", $2::uuid)
      END
      WHERE id = $1 AND EXISTS (SELECT 1 FROM role_insert)
      RETURNING "communityOrder"
    ),
    state_update AS (
      INSERT INTO user_community_state ("userId", "communityId")
      SELECT $1, $2 WHERE EXISTS (SELECT 1 FROM role_insert)
      ON CONFLICT ("userId", "communityId") DO UPDATE SET
        "userLeftCommunity" = NULL,
        "approvalUpdatedAt" = now()
    ),
    community_update AS (
      UPDATE communities
      SET "memberCount" = "memberCount" + 1, "updatedAt" = now()
      WHERE id = $2 AND EXISTS (SELECT 1 FROM role_insert)
      RETURNING "memberCount", "updatedAt"
    )
    SELECT
      $2::uuid AS "communityId",
      $1::uuid AS "userId",
      (SELECT "roleId" FROM role_insert) AS "memberRoleId",
      ARRAY[(SELECT "roleId" FROM role_insert)]::uuid[] AS "roleIds",
      (SELECT "communityOrder" FROM user_update) AS "communityOrder",
      "memberCount",
      "updatedAt"
    FROM community_update
  `, [botUserId, communityId, PredefinedRole.Member, RoleType.PREDEFINED]);
  return result.rows[0] || null;
}

async function _removeMembership(db: PoolClient, botUserId: string, communityId: string): Promise<MembershipChange | null> {
  const result = await db.query<MembershipChange>(`
    WITH delete_roles AS (
      DELETE FROM roles_users_users ruu
      USING roles r
      WHERE ruu."userId" = $1
        AND ruu."roleId" = r.id
        AND r."communityId" = $2
      RETURNING ruu."roleId"
    ),
    user_update AS (
      UPDATE users
      SET "communityOrder" = array_remove("communityOrder", $2::uuid)
      WHERE id = $1 AND EXISTS (SELECT 1 FROM delete_roles)
      RETURNING "communityOrder"
    ),
    channel_settings_delete AS (
      DELETE FROM user_channel_settings
      WHERE "userId" = $1 AND "communityId" = $2
    ),
    state_update AS (
      UPDATE user_community_state
      SET "userLeftCommunity" = now()
      WHERE "userId" = $1 AND "communityId" = $2
    ),
    community_update AS (
      UPDATE communities
      SET "memberCount" = GREATEST("memberCount" - 1, 0), "updatedAt" = now()
      WHERE id = $2 AND EXISTS (SELECT 1 FROM delete_roles)
      RETURNING "memberCount", "updatedAt"
    )
    SELECT
      $2::uuid AS "communityId",
      $1::uuid AS "userId",
      NULL::uuid AS "memberRoleId",
      COALESCE((SELECT array_agg("roleId") FROM delete_roles), ARRAY[]::uuid[]) AS "roleIds",
      (SELECT "communityOrder" FROM user_update) AS "communityOrder",
      "memberCount",
      "updatedAt"
    FROM community_update
  `, [botUserId, communityId]);
  return result.rows[0] || null;
}

async function _assertRoleSetAllowed(
  db: PoolClient,
  bot: BotRecord,
  communityId: string,
  roleIds: string[],
) {
  const roles = await db.query(`
    SELECT id
    FROM roles
    WHERE id = ANY($1::uuid[])
      AND "communityId" = $2
      AND type <> $3
      AND "deletedAt" IS NULL
  `, [roleIds, communityId, RoleType.PREDEFINED]);
  if (roles.rowCount !== roleIds.length) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  if (bot.ownerType !== BotOwnerType.USER || roleIds.length === 0) return;

  // Bot bearer principals cannot reach community-management routes in v1.
  // The user-owner cap therefore applies to the channel permissions that the
  // messaging allowlist can actually exercise.
  const excess = await db.query(`
    WITH bot_permissions AS (
      SELECT ccrp."channelId", unnest(ccrp.permissions)::text AS permission
      FROM communities_channels_roles_permissions ccrp
      WHERE ccrp."communityId" = $1
        AND ccrp."roleId" = ANY($2::uuid[])
    ), owner_permissions AS (
      SELECT ccrp."channelId", unnest(ccrp.permissions)::text AS permission
      FROM communities_channels_roles_permissions ccrp
      INNER JOIN roles r ON r.id = ccrp."roleId"
      LEFT JOIN roles_users_users ruu
        ON ruu."roleId" = r.id AND ruu."userId" = $3 AND ruu.claimed = TRUE
      WHERE ccrp."communityId" = $1
        AND (ruu."userId" IS NOT NULL OR (r.type = $4 AND r.title = $5))
        AND r."deletedAt" IS NULL
    )
    SELECT 1
    FROM (SELECT * FROM bot_permissions EXCEPT SELECT * FROM owner_permissions) missing
    LIMIT 1
  `, [communityId, roleIds, bot.ownerId, RoleType.PREDEFINED, PredefinedRole.Public]);
  if (excess.rowCount !== 0) {
    throw new Error(errors.server.NOT_ALLOWED);
  }
}

async function _assertBotInstalled(db: PoolClient, botUserId: string, communityId: string) {
  const membership = await db.query(`
    SELECT 1
    FROM roles_users_users ruu
    INNER JOIN roles r ON r.id = ruu."roleId"
    WHERE ruu."userId" = $1
      AND r."communityId" = $2
      AND r.type = $3
      AND r.title = $4
      AND r."deletedAt" IS NULL
  `, [botUserId, communityId, RoleType.PREDEFINED, PredefinedRole.Member]);
  if (membership.rowCount !== 1) throw new Error(errors.server.NOT_ALLOWED);
}

async function _setBotRoles(db: PoolClient, bot: BotRecord, communityId: string, roleIds: string[]) {
  await _assertRoleSetAllowed(db, bot, communityId, roleIds);
  await _assertBotInstalled(db, bot.userId, communityId);

  const current = await db.query<{ roleId: string }>(`
    SELECT ruu."roleId"
    FROM roles_users_users ruu
    INNER JOIN roles r ON r.id = ruu."roleId"
    WHERE ruu."userId" = $1
      AND r."communityId" = $2
      AND r.type <> $3
  `, [bot.userId, communityId, RoleType.PREDEFINED]);
  const currentIds = current.rows.map(row => row.roleId);

  await db.query(`
    DELETE FROM roles_users_users ruu
    USING roles r
    WHERE ruu."roleId" = r.id
      AND ruu."userId" = $1
      AND r."communityId" = $2
      AND r.type <> $3
  `, [bot.userId, communityId, RoleType.PREDEFINED]);
  if (roleIds.length > 0) {
    await db.query(`
      INSERT INTO roles_users_users ("userId", "roleId", claimed)
      SELECT $1, unnest($2::uuid[]), TRUE
    `, [bot.userId, roleIds]);
  }
  return {
    communityId,
    userId: bot.userId,
    addedRoleIds: roleIds.filter(id => !currentIds.includes(id)),
    removedRoleIds: currentIds.filter(id => !roleIds.includes(id)),
  } satisfies RoleChange;
}

async function _emitJoin(change: MembershipChange) {
  await eventHelper.userJoinRooms(change.userId, {
    roleIds: [change.memberRoleId],
    communityIds: [change.communityId],
  });
  await eventHelper.emit({
    type: 'cliCommunityEvent', action: 'update', data: {
      id: change.communityId,
      memberCount: change.memberCount,
      updatedAt: change.updatedAt,
    }
  }, { communityIds: [change.communityId] });
  await eventHelper.emit({
    type: 'cliMembershipEvent', action: 'join', data: {
      communityId: change.communityId,
      userId: change.userId,
      roleIds: [change.memberRoleId],
    }
  }, { communityIds: [change.communityId] });
}

async function _emitLeave(change: MembershipChange) {
  await eventHelper.userLeaveRooms(change.userId, {
    roleIds: change.roleIds,
    communityIds: [change.communityId],
  });
  await eventHelper.emit({
    type: 'cliCommunityEvent', action: 'update', data: {
      id: change.communityId,
      memberCount: change.memberCount,
      updatedAt: change.updatedAt,
    }
  }, { communityIds: [change.communityId] });
  await eventHelper.emit({
    type: 'cliMembershipEvent', action: 'leave', data: {
      communityId: change.communityId,
      userId: change.userId,
    }
  }, { communityIds: [change.communityId] });
}

async function _emitRoleChange(change: RoleChange) {
  if (change.removedRoleIds.length > 0) {
    await eventHelper.userLeaveRooms(change.userId, { roleIds: change.removedRoleIds });
    await eventHelper.emit({
      type: 'cliMembershipEvent', action: 'roles_removed', data: {
        communityId: change.communityId,
        userId: change.userId,
        roleIds: change.removedRoleIds,
      }
    }, { communityIds: [change.communityId] });
  }
  if (change.addedRoleIds.length > 0) {
    await eventHelper.userJoinRooms(change.userId, { roleIds: change.addedRoleIds });
    await eventHelper.emit({
      type: 'cliMembershipEvent', action: 'roles_added', data: {
        communityId: change.communityId,
        userId: change.userId,
        roleIds: change.addedRoleIds,
      }
    }, { communityIds: [change.communityId] });
  }
}

class BotHelper {
  public async listBots(actorUserId: string, owner: API.Bot.Owner): Promise<API.Bot.BotView[]> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await _assertOwnerAuthorization(client, actorUserId, owner.ownerType, owner.ownerId);
      const ids = await client.query<{ userId: string }>(`
        SELECT "userId"
        FROM bots
        WHERE "ownerType" = $1 AND "ownerId" IS NOT DISTINCT FROM $2::uuid
        ORDER BY "createdAt"
      `, [owner.ownerType, owner.ownerId]);
      const result = await Promise.all(ids.rows.map(row => _getBotView(client, row.userId)));
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async createBot(actorUserId: string, data: API.Bot.createBot.Request): Promise<API.Bot.BotView> {
    const client = await pool.connect();
    const joined: MembershipChange[] = [];
    let botUserId: string;
    try {
      await client.query('BEGIN');
      await _assertOwnerAuthorization(client, actorUserId, data.ownerType, data.ownerId);
      await _assertOwnerLimit(client, data.ownerType, data.ownerId);
      if (data.ownerType === BotOwnerType.PLATFORM) {
        if (!data.platformPresence) throw new Error(errors.server.INVALID_REQUEST);
        if (data.platformPresence.mode === BotPlatformPresenceMode.ALL && data.platformPresence.communityIds.length > 0) {
          throw new Error(errors.server.INVALID_REQUEST);
        }
        await _validateSelectedCommunities(client, data.platformPresence.communityIds);
      } else if (!data.ownerId) {
        throw new Error(errors.server.INVALID_REQUEST);
      }
      const createData: CreateBotUserData = data.ownerType === BotOwnerType.PLATFORM ? {
        ownerType: BotOwnerType.PLATFORM,
        ownerId: null,
        platformPresenceMode: data.platformPresence!.mode,
        displayName: data.displayName,
        imageId: data.imageId,
        description: data.description,
      } : {
        ownerType: data.ownerType,
        ownerId: data.ownerId!,
        displayName: data.displayName,
        imageId: data.imageId,
        description: data.description,
      };
      botUserId = (await userHelper.createBotUserInTransaction(client, createData)).userId;
      if (data.ownerType === BotOwnerType.PLATFORM) {
        await _replacePlatformSelections(client, botUserId, data.platformPresence!.communityIds);
      } else if (data.ownerType === BotOwnerType.COMMUNITY) {
        const change = await _installMembership(client, botUserId, data.ownerId!);
        if (!change) throw new Error(errors.server.INVALID_REQUEST);
        joined.push(change);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    for (const change of joined) await _emitJoin(change);
    if (data.ownerType === BotOwnerType.PLATFORM) {
      try {
        await this.reconcilePlatformBot(botUserId!);
      } catch (error) {
        console.error('Initial platform bot reconciliation will require retry', { botUserId, error });
      }
    }
    return await this.getBotView(botUserId!);
  }

  public async getBotView(botUserId: string) {
    const client = await pool.connect();
    try {
      return await _getBotView(client, botUserId);
    } finally {
      client.release();
    }
  }

  public async updateBot(actorUserId: string, data: API.Bot.updateBot.Request): Promise<API.Bot.BotView> {
    const client = await pool.connect();
    let platformChanged = false;
    try {
      await client.query('BEGIN');
      const bot = await _getBot(client, data.botUserId);
      await _assertOwnerAuthorization(client, actorUserId, bot.ownerType, bot.ownerId);
      if (data.platformPresence) {
        if (bot.ownerType !== BotOwnerType.PLATFORM) throw new Error(errors.server.INVALID_REQUEST);
        if (data.platformPresence.mode === BotPlatformPresenceMode.ALL && data.platformPresence.communityIds.length > 0) {
          throw new Error(errors.server.INVALID_REQUEST);
        }
        await _replacePlatformSelections(client, bot.userId, data.platformPresence.communityIds);
        await client.query(`UPDATE bots SET "platformPresenceMode" = $2, "updatedAt" = now() WHERE "userId" = $1`, [bot.userId, data.platformPresence.mode]);
        platformChanged = true;
      }
      if (data.description !== undefined) {
        await client.query(`UPDATE bots SET description = $2, "updatedAt" = now() WHERE "userId" = $1`, [bot.userId, data.description]);
      }
      if (data.displayName !== undefined || data.imageId !== undefined) {
        await client.query(`
          UPDATE user_accounts
          SET
            "displayName" = COALESCE($2, "displayName"),
            "imageId" = CASE WHEN $3::boolean THEN $4 ELSE "imageId" END,
            "updatedAt" = now()
          WHERE "userId" = $1 AND type = 'bot' AND "deletedAt" IS NULL
        `, [bot.userId, data.displayName ?? null, data.imageId !== undefined, data.imageId ?? null]);
        await client.query(`UPDATE users SET "updatedAt" = now() WHERE id = $1`, [bot.userId]);
        await client.query(`UPDATE bots SET "updatedAt" = now() WHERE "userId" = $1`, [bot.userId]);
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (platformChanged) {
      try {
        await this.reconcilePlatformBot(data.botUserId);
      } catch (error) {
        console.error('Updated platform bot reconciliation will require retry', { botUserId: data.botUserId, error });
      }
    }
    return await this.getBotView(data.botUserId);
  }

  public async disableBot(actorUserId: string, botUserId: string): Promise<void> {
    const client = await pool.connect();
    const left: MembershipChange[] = [];
    try {
      await client.query('BEGIN');
      const bot = await _getBot(client, botUserId);
      await _assertOwnerAuthorization(client, actorUserId, bot.ownerType, bot.ownerId);
      const communities = await client.query<{ communityId: string }>(`
        SELECT DISTINCT r."communityId"
        FROM roles_users_users ruu
        INNER JOIN roles r ON r.id = ruu."roleId"
        WHERE ruu."userId" = $1
      `, [botUserId]);
      for (const row of communities.rows) {
        const change = await _removeMembership(client, botUserId, row.communityId);
        if (change) left.push(change);
      }
      await client.query(`UPDATE bots SET "deletedAt" = now(), "updatedAt" = now() WHERE "userId" = $1`, [botUserId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    for (const change of left) await _emitLeave(change);
  }

  public async disableBotsForOwner(ownerType: 'user' | 'community', ownerId: string): Promise<void> {
    const client = await pool.connect();
    const left: MembershipChange[] = [];
    try {
      await client.query('BEGIN');
      const bots = await client.query<{ userId: string }>(`
        SELECT "userId"
        FROM bots
        WHERE "ownerType" = $1
          AND "ownerId" = $2
          AND "deletedAt" IS NULL
        FOR UPDATE
      `, [ownerType, ownerId]);
      for (const bot of bots.rows) {
        const communities = await client.query<{ communityId: string }>(`
          SELECT DISTINCT r."communityId"
          FROM roles_users_users ruu
          INNER JOIN roles r ON r.id = ruu."roleId"
          WHERE ruu."userId" = $1
        `, [bot.userId]);
        for (const row of communities.rows) {
          const change = await _removeMembership(client, bot.userId, row.communityId);
          if (change) left.push(change);
        }
      }
      await client.query(`
        UPDATE bots
        SET "deletedAt" = now(), "updatedAt" = now()
        WHERE "ownerType" = $1 AND "ownerId" = $2 AND "deletedAt" IS NULL
      `, [ownerType, ownerId]);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    for (const change of left) await _emitLeave(change);
  }

  public async installBot(actorUserId: string, data: API.Bot.installBot.Request): Promise<void> {
    const client = await pool.connect();
    let change: MembershipChange | null = null;
    let roleChange: RoleChange | null = null;
    try {
      await client.query('BEGIN');
      const bot = await _getBot(client, data.botUserId);
      if (bot.ownerType === BotOwnerType.PLATFORM) {
        await _assertOwnerAuthorization(client, actorUserId, bot.ownerType, bot.ownerId);
        if (bot.platformPresenceMode !== BotPlatformPresenceMode.SELECTED) throw new Error(errors.server.NOT_ALLOWED);
        await client.query(`INSERT INTO bots_platform_communities ("botUserId", "communityId") VALUES ($1, $2) ON CONFLICT DO NOTHING`, [bot.userId, data.communityId]);
      } else {
        await _assertCommunityManager(client, actorUserId, data.communityId);
      }
      await _assertBotPolicy(client, bot, data.communityId);
      change = await _installMembership(client, bot.userId, data.communityId);
      roleChange = await _setBotRoles(client, bot, data.communityId, data.roleIds);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    if (change) await _emitJoin(change);
    if (roleChange) await _emitRoleChange(roleChange);
  }

  public async removeBot(actorUserId: string, data: API.Bot.removeBot.Request): Promise<void> {
    const client = await pool.connect();
    let change: MembershipChange | null = null;
    try {
      await client.query('BEGIN');
      const bot = await _getBot(client, data.botUserId);
      if (bot.ownerType === BotOwnerType.PLATFORM) {
        await _assertOwnerAuthorization(client, actorUserId, bot.ownerType, bot.ownerId);
        if (bot.platformPresenceMode !== BotPlatformPresenceMode.SELECTED) throw new Error(errors.server.NOT_ALLOWED);
        await client.query(`DELETE FROM bots_platform_communities WHERE "botUserId" = $1 AND "communityId" = $2`, [bot.userId, data.communityId]);
      } else {
        await _assertCommunityManager(client, actorUserId, data.communityId);
      }
      change = await _removeMembership(client, bot.userId, data.communityId);
      if (!change) throw new Error(errors.server.NOT_FOUND);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await _emitLeave(change!);
  }

  public async setBotRoles(actorUserId: string, data: API.Bot.setBotRoles.Request): Promise<void> {
    const client = await pool.connect();
    let roleChange: RoleChange;
    try {
      await client.query('BEGIN');
      await _assertCommunityManager(client, actorUserId, data.communityId);
      const bot = await _getBot(client, data.botUserId);
      await _assertBotPolicy(client, bot, data.communityId);
      roleChange = await _setBotRoles(client, bot, data.communityId, data.roleIds);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    await _emitRoleChange(roleChange!);
  }

  public async setAllowUserBots(actorUserId: string, communityId: string, allowUserBots: boolean): Promise<void> {
    const client = await pool.connect();
    const left: MembershipChange[] = [];
    try {
      await client.query('BEGIN');
      await _assertCommunityManager(client, actorUserId, communityId);
      const updated = await client.query(`
        UPDATE communities SET "allowUserBots" = $2, "updatedAt" = now()
        WHERE id = $1 AND "deletedAt" IS NULL
        RETURNING id
      `, [communityId, allowUserBots]);
      if (updated.rowCount !== 1) throw new Error(errors.server.NOT_FOUND);
      if (!allowUserBots) {
        const bots = await client.query<{ userId: string }>(`
          SELECT DISTINCT b."userId"
          FROM bots b
          INNER JOIN roles_users_users ruu ON ruu."userId" = b."userId"
          INNER JOIN roles r ON r.id = ruu."roleId"
          WHERE b."ownerType" = 'user'
            AND b."deletedAt" IS NULL
            AND r."communityId" = $1
        `, [communityId]);
        for (const bot of bots.rows) {
          const change = await _removeMembership(client, bot.userId, communityId);
          if (change) left.push(change);
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    for (const change of left) await _emitLeave(change);
    await eventHelper.emit({
      type: 'cliCommunityEvent',
      action: 'update',
      data: { id: communityId, allowUserBots, updatedAt: new Date().toISOString() },
    }, { communityIds: [communityId] });
  }

  public async guardGenericRoleAssignment(botUserId: string, communityId: string, addedRoleIds: string[]) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const botResult = await client.query(`SELECT 1 FROM bots WHERE "userId" = $1`, [botUserId]);
      if (botResult.rowCount === 0) {
        await client.query('COMMIT');
        return;
      }
      const bot = await _getBot(client, botUserId);
      await _assertBotPolicy(client, bot, communityId);
      await _assertBotInstalled(client, bot.userId, communityId);
      const current = await client.query<{ roleId: string }>(`
        SELECT ruu."roleId"
        FROM roles_users_users ruu
        INNER JOIN roles r ON r.id = ruu."roleId"
        WHERE ruu."userId" = $1 AND r."communityId" = $2 AND r.type <> $3
      `, [botUserId, communityId, RoleType.PREDEFINED]);
      await _assertRoleSetAllowed(client, bot, communityId, Array.from(new Set([...current.rows.map(r => r.roleId), ...addedRoleIds])));
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async guardGenericRoleRemoval(botUserId: string, communityId: string) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const botResult = await client.query(`SELECT 1 FROM bots WHERE "userId" = $1`, [botUserId]);
      if (botResult.rowCount === 0) {
        await client.query('COMMIT');
        return;
      }
      const bot = await _getBot(client, botUserId);
      await _assertBotPolicy(client, bot, communityId);
      await _assertBotInstalled(client, bot.userId, communityId);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async reconcileUserBotsForOwner(ownerUserId: string, communityId: string) {
    const client = await pool.connect();
    const left: MembershipChange[] = [];
    const roleChanges: RoleChange[] = [];
    try {
      await client.query('BEGIN');
      const bots = await client.query<{ userId: string }>(`
        SELECT DISTINCT b."userId"
        FROM bots b
        INNER JOIN roles_users_users ruu ON ruu."userId" = b."userId"
        INNER JOIN roles r ON r.id = ruu."roleId"
        WHERE b."ownerType" = 'user' AND b."ownerId" = $1
          AND b."deletedAt" IS NULL AND r."communityId" = $2
      `, [ownerUserId, communityId]);
      for (const row of bots.rows) {
        const bot = await _getBot(client, row.userId);
        try {
          await _assertBotPolicy(client, bot, communityId);
        } catch (error) {
          if (!(error instanceof Error) || ![
            errors.server.NOT_ALLOWED,
            errors.server.NOT_FOUND,
          ].includes(error.message)) {
            throw error;
          }
          const change = await _removeMembership(client, bot.userId, communityId);
          if (change) left.push(change);
          continue;
        }

        const current = await client.query<{ roleId: string }>(`
          SELECT ruu."roleId"
          FROM roles_users_users ruu
          INNER JOIN roles r ON r.id = ruu."roleId"
          WHERE ruu."userId" = $1
            AND r."communityId" = $2
            AND r.type <> $3
        `, [bot.userId, communityId, RoleType.PREDEFINED]);
        const currentRoleIds = current.rows.map(role => role.roleId);
        try {
          await _assertRoleSetAllowed(client, bot, communityId, currentRoleIds);
        } catch (error) {
          if (!(error instanceof Error) || ![
            errors.server.INVALID_REQUEST,
            errors.server.NOT_ALLOWED,
          ].includes(error.message)) {
            throw error;
          }
          roleChanges.push(await _setBotRoles(client, bot, communityId, []));
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
    for (const change of roleChanges) await _emitRoleChange(change);
    for (const change of left) await _emitLeave(change);
  }

  public async reconcileAllUserBotsInCommunity(communityId: string) {
    const result = await pool.query<{ ownerId: string }>(`
      SELECT DISTINCT b."ownerId"
      FROM bots b
      INNER JOIN roles_users_users ruu ON ruu."userId" = b."userId"
      INNER JOIN roles r ON r.id = ruu."roleId"
      WHERE b."ownerType" = 'user'
        AND b."deletedAt" IS NULL
        AND r."communityId" = $1
    `, [communityId]);
    for (const row of result.rows) {
      await this.reconcileUserBotsForOwner(row.ownerId, communityId);
    }
  }

  public async reconcilePlatformBot(botUserId: string) {
    const client = await pool.connect();
    const joined: MembershipChange[] = [];
    const left: MembershipChange[] = [];
    try {
      await client.query('BEGIN');
      const bot = await _getBot(client, botUserId);
      if (bot.ownerType !== BotOwnerType.PLATFORM) throw new Error(errors.server.INVALID_REQUEST);
      const desired = await client.query<{ communityId: string }>(bot.platformPresenceMode === BotPlatformPresenceMode.ALL ? `
        SELECT id AS "communityId" FROM communities WHERE "deletedAt" IS NULL
      ` : `
        SELECT bpc."communityId"
        FROM bots_platform_communities bpc
        INNER JOIN communities c ON c.id = bpc."communityId"
        WHERE bpc."botUserId" = $1 AND c."deletedAt" IS NULL
      `, bot.platformPresenceMode === BotPlatformPresenceMode.ALL ? [] : [botUserId]);
      const desiredIds = new Set(desired.rows.map(row => row.communityId));
      const actual = await client.query<{ communityId: string }>(`
        SELECT DISTINCT r."communityId"
        FROM roles_users_users ruu INNER JOIN roles r ON r.id = ruu."roleId"
        WHERE ruu."userId" = $1
      `, [botUserId]);
      const actualIds = new Set(actual.rows.map(row => row.communityId));
      for (const communityId of desiredIds) {
        if (!actualIds.has(communityId)) {
          const change = await _installMembership(client, botUserId, communityId);
          if (change) joined.push(change);
        }
      }
      for (const communityId of actualIds) {
        if (!desiredIds.has(communityId)) {
          const change = await _removeMembership(client, botUserId, communityId);
          if (change) left.push(change);
        }
      }
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      console.error('Platform bot reconciliation failed', { botUserId, error });
      throw error;
    } finally {
      client.release();
    }
    for (const change of joined) await _emitJoin(change);
    for (const change of left) await _emitLeave(change);
  }

  public async reconcilePlatformBotsForCommunity(communityId: string) {
    const result = await pool.query<{ userId: string }>(`
      SELECT "userId" FROM bots
      WHERE "ownerType" = 'platform'
        AND "platformPresenceMode" = 'all'
        AND "deletedAt" IS NULL
    `);
    for (const row of result.rows) {
      try {
        await this.reconcilePlatformBot(row.userId);
      } catch (error) {
        console.error('New-community platform bot reconciliation failed', { communityId, botUserId: row.userId, error });
      }
    }
  }
}

const botHelper = new BotHelper();
export default botHelper;
