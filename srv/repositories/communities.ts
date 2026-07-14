// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
  ArticlePermission,
  CallPermission,
  ChannelNotificationTypeEnum,
  ChannelPermission,
  ChannelPinTypeEnum,
  CommunityPermission,
  PredefinedRole,
  CommunityPremiumFeatureName,
  RoleType,
  UserBlockState,
  PremiumRenewal,
  CommunityApprovalState,
} from "../common/enums";
import { rolePermissionPresets } from "../common/presets";
import pool from "../util/postgres";
import { type Pool, type PoolClient } from "pg";
import format from 'pg-format';
import errors from "../common/errors";
import config from "../common/config";
import urls from "../util/urls";
import eventHelper from "./event";
import permissionHelper from "./permissions";
import { randomString } from "../util";
import {
  calculateCommunityUpgradeCost,
  checkCommunityRequirements,
  getRandomReadableString,
  getUrl,
} from "../common/util";
import { promisify } from "util";
import fs from "fs";
import xml from "xml";
import notificationHelper from "./notifications";
import dayjs from "dayjs";
import userHelper from "./users";
import emailHelper from "./emails";
import { investmentTargets } from "../common/investmentTargets";
import { parseUnits } from "ethers/utils";
import botHelper from "./bots";

/* Community Retrieval */

const blockStateCoalesce = `'{"state":null,"until":null}'::json`;

async function _getCommunitySocialPreview(
  db: Pool | PoolClient,
  options: { communityId: string } | { communityUrl: string },
) {
  const query = `
    SELECT
      c."title",
      c."shortDescription",
      c."logoSmallId",
      c."logoLargeId",
      c."memberCount",
      c."official"
    FROM communities c
    WHERE c."deletedAt" IS NULL
      ${'communityId' in options
      ? format('AND c."id" = %L::UUID', options.communityId)
      : format('AND c."url" = %L', options.communityUrl)}
  `;
  const result = await db.query(query);
  if (result.rows.length === 1) {
    return result.rows[0] as {
      title: string;
      shortDescription: string;
      logoSmallId: string;
      logoLargeId: string;
      memberCount: number;
      official: boolean;
    }
  }
  return null;
};

async function _getCommunityListView(
  db: Pool | PoolClient,
  data: {
    where?: string;
    orderBy?: string;
    limit?: number;
    offset?: number;
    params?: any[];
  }
): Promise<Models.Community.ListView[]> {
  const query = `
    SELECT
      c."id",
      c."url",
      c."title",
      c."logoSmallId",
      c."logoLargeId",
      c."headerImageId",
      c."shortDescription",
      c."tags",
      c."official",
      c."allowUserBots",
      c."updatedAt",
      c."createdAt",
      c."memberCount",
      CASE WHEN cp."featureName" IS NOT NULL THEN json_build_object(
        'featureName', cp."featureName",
        'activeUntil', cp."activeUntil",
        'autoRenew', cp."autoRenew"
      ) ELSE NULL END as "premium"
    FROM communities c
    LEFT JOIN LATERAL (
      SELECT "featureName", "activeUntil", "autoRenew"
      FROM communities_premium
      WHERE "featureName" = ANY(ARRAY[${format("%L", [CommunityPremiumFeatureName.BASIC, CommunityPremiumFeatureName.PRO, CommunityPremiumFeatureName.ENTERPRISE])}]::"public"."communities_premium_featurename_enum"[])
        AND "communityId" = c."id"
      ORDER BY "activeUntil" DESC
      LIMIT 1
    ) cp ON TRUE
    WHERE ${data.where ? `${data.where} AND` : ''} c."deletedAt" IS NULL
    ${data.orderBy ? `ORDER BY ${data.orderBy}` : ''}
    ${data.offset ? `OFFSET ${data.offset}` : ''}
    ${data.limit ? `LIMIT ${data.limit}` : ''}
  `;
  const result = await db.query(query, data.params);
  return result.rows as {
    id: string;
    url: string;
    title: string;
    logoSmallId: string | null;
    logoLargeId: string | null;
    headerImageId: string | null;
    shortDescription: string;
    tags: string[];
    official: boolean;
    allowUserBots: boolean;
    updatedAt: string;
    createdAt: string;
    memberCount: number;
    premium: Models.Community.Premium | null;
  }[];
};

async function _getCommunityDetailView<Ext>(
  db: Pool | PoolClient,
  data: {
    userId?: string;
    CTE?: string;
    extraFields?: string;
    where: string;
    params?: any[];
  }
) {
  const query = `
    ${data.CTE ? data.CTE : ''}
    SELECT
      c."id",
      c."url",
      c."title",
      c."logoSmallId",
      c."logoLargeId",
      c."headerImageId",
      c."shortDescription",
      c."tags",
      c."official",
      c."allowUserBots",
      c."updatedAt",
      c."description",
      c."links",
      c."createdAt",
      c."creatorId",
      c."memberCount",
      c."pointBalance",
      c."onboardingOptions",
      c."enablePersonalNewsletter",
      COALESCE((
        SELECT JSON_AGG(
          JSON_BUILD_OBJECT(
            'id', cp."id",
            'communityId', cp."communityId",
            'pluginId', cp."pluginId",
            'ownerCommunityId', p."ownerCommunityId",
            'name', cp."name",
            'url', p."url",
            'description', p."description",
            'imageId', p."imageId",
            'permissions', p."permissions",
            'clonable', p."clonable",
            'appstoreEnabled', p."appstoreEnabled",
            'warnAbusive', p."warnAbusive",
            'requiresIsolationMode', p."requiresIsolationMode",
            'tags', p."tags",
            ${data.userId ? `'acceptedPermissions', COALESCE(ups."acceptedPermissions", '[]'::JSONB),` : ''}
            'reportFlagged', (
              SELECT COUNT(*) >= ${config.MINIMUM_REPORTS_TO_FLAG_PLUGIN}
              FROM reports r
              WHERE r."targetId" = cp."pluginId"
                AND r."type" = 'PLUGIN'::"public"."reports_type_enum"
                AND r.resolved = false
                AND r."deletedAt" IS NULL
            ),
            'config', CASE 
              WHEN EXISTS (
                SELECT 1 FROM roles r
                JOIN roles_users_users ruu ON r.id = ruu."roleId"
                WHERE r."communityId" = c.id 
                  AND ruu."userId" = ${data.userId ? format('%L::UUID', data.userId) : 'NULL'}
                  AND r.type = 'PREDEFINED'::"public"."roles_type_enum"
                  AND r.title = 'Admin'
                  AND ruu.claimed = TRUE
                  AND r."deletedAt" IS NULL
              ) THEN cp.config
              ELSE NULL
            END
          )
        )
        FROM communities_plugins cp
        INNER JOIN plugins p ON cp."pluginId" = p."id"
        ${
          data.userId ? 
          `LEFT JOIN user_plugin_state ups ON ups."pluginId" = cp."pluginId" AND ups."userId" = ${format("%L::UUID", data.userId)}`
          : ''
        }
        WHERE cp."communityId" = c."id" 
          AND cp."deletedAt" IS NULL 
          AND p."deletedAt" IS NULL
      ), '[]'::JSON) AS "plugins",
      ${!!data.userId
      ? `cid."approvalState" as "myApplicationStatus",
           (SELECT COUNT(*)::int FROM user_community_state cid WHERE cid."communityId" = c."id" AND cid."approvalState" = 'PENDING'::public.user_community_state_approvalstate_enum) as "membersPendingApproval",`
      : ''}
      COALESCE((
        SELECT ARRAY_TO_JSON(ARRAY_AGG(JSON_BUILD_OBJECT(
          'communityId', ch."communityId",
          'channelId', ch."channelId",
          'areaId', ch."areaId",
          'title', ch."title",
          'url', ch."url",
          'order', ch."order",
          'description', ch."description",
          'emoji', ch."emoji",
          'lastMessageDate', (
            SELECT m2."createdAt"
            FROM messages m2
            WHERE m2."deletedAt" IS NULL
              AND m2."channelId" = ch."channelId"
            ORDER BY m2."createdAt" DESC
            LIMIT 1
          ),
          'pinnedMessageIds', ch."pinnedMessageIds",
          ${!!data.userId
      ? `
            'updatedAt', CASE
              WHEN ucs."updatedAt" IS NULL OR ucs."updatedAt" < ch."updatedAt"
              THEN ch."updatedAt"
              ELSE ucs."updatedAt"
            END,
            'pinType', ucs."pinType",
            'notifyType', ucs."notifyType",
            'pinnedUntil', ucs."pinnedUntil",
            'lastRead', chrs."lastRead",
            'unread', (
              SELECT count(*)
              FROM messages m
              WHERE m."channelId" = ch."channelId"
                AND m."deletedAt" IS NULL
                AND m."createdAt" > chrs."lastRead"
                AND chrs."lastRead" IS NOT NULL
            ),`
      : `
            'updatedAt', ch."updatedAt",
            'pinType', NULL,
            'notifyType', NULL,
            'pinnedUntil', NULL,
            'lastRead', NULL,
            'unread', 0,`
    }
          'rolePermissions', (
            SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG("item")), '[]'::JSON)
            FROM (
              SELECT JSON_BUILD_OBJECT(
                'roleId', r2."id",
                'roleTitle', r2."title",
                'permissions', ccrp."permissions"
              ) AS "item"
              FROM "communities_channels_roles_permissions" ccrp
              INNER JOIN roles r2
                ON r2."id" = ccrp."roleId"
                AND r2."deletedAt" IS NULL
              WHERE ccrp."communityId" = ch."communityId"
                AND ccrp."channelId" = ch."channelId"
            ) sub
          )
        )))
        FROM "communities_channels" ch
        ${!!data.userId
      ? `
        LEFT JOIN channelreadstate chrs
          ON chrs."channelId" = ch."channelId"
          AND chrs."userId" = ${format("%L::UUID", data.userId)}
        LEFT JOIN user_channel_settings ucs
          ON ucs."userId" = ${format("%L::UUID", data.userId)}
          AND ucs."channelId" = ch."channelId"
          AND ucs."communityId" = ch."communityId"
      `
      : ``
    }
        WHERE ch."communityId" = c."id"
          AND ch."deletedAt" IS NULL
      ), '[]'::JSON) as "channels",
      COALESCE((
        SELECT ARRAY_TO_JSON(ARRAY_AGG(JSON_BUILD_OBJECT(
          'id', a."id",
          'communityId', a."communityId",
          'title', a."title",
          'order', a."order",
          'updatedAt', a."updatedAt"
        )))
        FROM areas a
        WHERE a."communityId" = c."id" AND a."deletedAt" IS NULL
      ), '[]'::JSON) as "areas",
      ARRAY_TO_JSON(ARRAY_AGG(JSON_BUILD_OBJECT(
        'id', r."id",
        'communityId', r."communityId",
        'title', r."title",
        'type', r."type",
        'assignmentRules', r."assignmentRules",
        'updatedAt', r."updatedAt",
        'permissions', r."permissions",
        'imageId', r."imageId",
        'description', r."description",
        'airdropConfig', r."airdropConfig"
      ))) as "roles",
      COALESCE((
        SELECT ARRAY_TO_JSON(ARRAY_AGG(JSON_BUILD_OBJECT(
          'id', cl.id,
          'communityId', cl."communityId",
          'channelId', cl."channelId",
          'callServerUrl', cs.url,
          'previewUserIds', cl."previewUserIds",
          'title', cl.title,
          'description', cl.description,
          'callMembers', (
            SELECT COUNT(*)
            FROM callmembers cms
            WHERE cms."callId" = cl.id
              AND cms."leftAt" IS NULL
          ),
          'slots', cl.slots,
          'startedAt', cl."startedAt",
          'endedAt', cl."endedAt",
          'updatedAt', cl."updatedAt",
          'rolePermissions', (
            SELECT array_to_json(array_agg(json_build_object(
              'roleId', cp."roleId",
              'permissions', cp."permissions"
            )))
            FROM callpermissions cp
            WHERE cp."callId" = cl.id
          ),
          'callType', cl."callType",
          'callCreator', cl."callCreator",
          'scheduleDate', cl."scheduleDate",
          'stageSlots', cl."stageSlots",
          'highQuality', cl."highQuality",
          'audioOnly', cl."audioOnly"
        )))
        FROM calls cl
        INNER JOIN callservers cs
          ON cs."id" = cl."callServerId"
        WHERE cl."communityId" = c."id"
          AND cl."endedAt" IS NULL
      ), '[]'::JSON) as "calls",
      COALESCE((
        SELECT ARRAY_TO_JSON(ARRAY_AGG(JSON_BUILD_OBJECT(
          'contractId', ct."contractId",
          'order', ct."order",
          'active', ct.active
        )))
        FROM communities_tokens ct
        WHERE ct."communityId" = c."id"
      ), '[]'::JSON) as "tokens",
      (
        SELECT JSON_BUILD_OBJECT(
          'featureName', "featureName",
          'activeUntil', "activeUntil",
          'autoRenew', "autoRenew"
        )
        FROM communities_premium
        WHERE "communityId" = c."id"
          AND "featureName" = ANY(ARRAY[${format("%L", [CommunityPremiumFeatureName.BASIC, CommunityPremiumFeatureName.PRO, CommunityPremiumFeatureName.ENTERPRISE])}]::"public"."communities_premium_featurename_enum"[])
        ORDER BY "activeUntil" DESC
        LIMIT 1
      ) as "premium"${!!data.userId ? `,
        COALESCE((
          SELECT json_build_object(
            'notifyMentions', ucs."notifyMentions",
            'notifyReplies', ucs."notifyReplies",
            'notifyPosts', ucs."notifyPosts",
            'notifyEvents', ucs."notifyEvents",
            'notifyCalls', ucs."notifyCalls"
          )
          FROM user_community_state ucs
          WHERE ucs."userId" = ${format("%L::UUID", data.userId)}
          AND ucs."communityId" = c."id"
        ), '{}'::JSON) AS "notificationState", (
          SELECT ucs."newsletterJoinedAt" IS NOT NULL AND ucs."newsletterLeftAt" IS NULL
          FROM user_community_state ucs
          WHERE "userId" = ${format("%L::UUID", data.userId)}
          AND "communityId" = c."id"
        ) AS "myNewsletterEnabled"
      ` : ''}
      ${data.extraFields ? `,${data.extraFields}` : ''}
    FROM communities c
    INNER JOIN roles r
      ON  r."communityId" = c."id"
      AND r."deletedAt" IS NULL
    ${!!data.userId ? `LEFT JOIN user_community_state cid
      ON cid."communityId" = c."id"
      AND cid."userId" = ${format('%L::UUID', data.userId)}` : ''}
    WHERE ${data.where} AND c."deletedAt" IS NULL
    GROUP BY c."id" ${!!data.userId ? ', cid."approvalState"' : ''}
  `;
  const result = await db.query(query, data.params);
  return result.rows as ({
    id: string;
    url: string;
    title: string;
    logoSmallId: string | null;
    logoLargeId: string | null;
    headerImageId: string | null;
    shortDescription: string;
    tags: string[];
    official: boolean;
    allowUserBots: boolean;
    updatedAt: string;

    description: string;
    links: Common.Link[];
    createdAt: string;
    creatorId: string;
    memberCount: number;
    pointBalance: number;
    myApplicationStatus?: CommunityApprovalState;
    membersPendingApproval?: number;
    enablePersonalNewsletter: boolean;
    plugins: {
      id: string;
      communityId: string;
      pluginId: string;
      ownerCommunityId: string;
      name: string;
      url: string;
      description: string | null;
      imageId: string | null;
      config: Models.Plugin.PluginConfig | null;
      permissions: Models.Plugin.PluginPermissions;
      acceptedPermissions: Models.Plugin.PluginPermission[];
      clonable: boolean;
      appstoreEnabled: boolean;
      warnAbusive: boolean;
      requiresIsolationMode: boolean;
      tags: string[] | null;
      reportFlagged: boolean;
    }[];
    channels: {
      communityId: string;
      channelId: string;
      areaId: string | null;
      title: string;
      url: string | null;
      order: number;
      description: string | null;
      emoji: string | null;
      updatedAt: string;
      unread: number;
      lastRead: string | null;
      lastMessageDate: string | null;
      pinnedMessageIds: string[] | null;
      rolePermissions: {
        roleId: string;
        roleTitle: string;
        permissions: ChannelPermission[];
      }[];
      pinType: Models.Community.ChannelPinType | null;
      notifyType: Models.Community.ChannelNotifyType | null;
      pinnedUntil: string | null;
    }[];
    areas: {
      id: string;
      communityId: string;
      title: string;
      order: number;
      updatedAt: string;
    }[];
    roles: {
      id: string;
      communityId: string;
      title: string;
      type: RoleType;
      assignmentRules: Models.Community.AssignmentRules | null;
      updatedAt: string;
      permissions: CommunityPermission[];
      imageId: string | null;
      description: string | null;
      airdropConfig: Models.Community.RoleAirdropConfig | null;
    }[];
    calls: {
      id: string;
      communityId: string;
      channelId: string;
      callServerUrl: string;
      previewUserIds: string[];
      title: string;
      description: string | null;
      callMembers: number;
      slots: number;
      startedAt: string;
      endedAt: string | null;
      updatedAt: string;
      rolePermissions: {
        roleId: string;
        permissions: Common.CallPermission[];
      }[];
      callType: Common.CallType;
      callCreator: string;
      scheduleDate: string | null;
      stageSlots: number;
      highQuality: boolean;
      audioOnly: boolean;
    }[];
    tokens: {
      contractId: string;
      order: number;
      active: boolean;
    }[];
    premium: {
      featureName: Models.Community.PremiumName;
      activeUntil: string;
      autoRenew: Common.PremiumRenewal | null;
    } | null;
    onboardingOptions?: Models.Community.OnboardingOptions;
    notificationState?: {
      notifyMentions: boolean;
      notifyReplies: boolean;
      notifyPosts: boolean;
      notifyEvents: boolean;
      notifyCalls: boolean;
    },
    myNewsletterEnabled: boolean;
  } & Ext)[];
};

async function __getCommunityChannelBaseData(
  db: Pool | PoolClient,
  data: {
    communityId: string;
    channelId: string;
  },
) {
  const query = `
    SELECT JSON_BUILD_OBJECT(
      'communityId', ch."communityId",
      'channelId', ch."channelId",
      'areaId', ch."areaId",
      'title', ch."title",
      'url', ch."url",
      'order', ch."order",
      'description', ch."description",
      'emoji', ch."emoji",
      'updatedAt', ch."updatedAt",
      'lastMessageDate', (
        SELECT m2."createdAt"
        FROM messages m2
        WHERE m2."deletedAt" IS NULL
          AND m2."channelId" = ch."channelId"
        ORDER BY m2."createdAt" DESC
        LIMIT 1
      ),
      'pinnedMessageIds', ch."pinnedMessageIds"
    ) as "data"
    FROM "communities_channels" ch
    WHERE "communityId" = $1 AND "channelId" = $2
  `;
  const result = await db.query(query, [data.communityId, data.channelId]);
  if (!(result.rows.length === 1)) {
    throw new Error(errors.server.NOT_FOUND);
  }
  return result.rows[0].data as {
    communityId: string;
    channelId: string;
    areaId: string | null;
    title: string;
    url: string | null;
    order: number;
    description: string | null;
    emoji: string | null;
    updatedAt: string;
    lastMessageDate: string | null;
    pinnedMessageIds: string[] | null;
  };
}

async function _getMemberList(
  db: Pool | PoolClient,
  data: API.Community.getMemberList.Request,
): Promise<{
  [userId: string]: {
    roleIds: string[];
  };
}> {
  const query = `
    SELECT
      ruu."userId",
      array_to_json(array_agg(ruu."roleId")) AS "roleIds"
    FROM roles_users_users ruu
    INNER JOIN roles r
      ON r."id" = ruu."roleId"
      AND r."deletedAt" IS NULL
    WHERE r."communityId" = $1
      AND ruu.claimed = TRUE
    GROUP BY ruu."userId"
  `;
  const result = await db.query(query, [data.communityId]);
  const rows = result.rows as {
    userId: string;
    roleIds: string[];
  }[];
  return rows.reduce<{
    [userId: string]: {
      roleIds: string[];
    };
  }>((agg, val) => {
    const { userId, roleIds } = val;
    agg[userId] = { roleIds };
    return agg;
  }, {});
}

/* COMMUNITY */

async function _createCommunity(
  db: PoolClient,
  data: API.Community.createCommunity.Request,
  userId: string,
): Promise<{ id: string }> {
  const url = randomString(10);

  const query = `
    INSERT INTO communities (
      "title",
      "logoSmallId",
      "logoLargeId",
      "shortDescription",
      "description",
      "headerImageId",
      "links",
      "tags",
      "creatorId",
      "url"
    )
    VALUES ($1,$2,$3,$4,$5,$6,$7::jsonb,$8,$9,$10)
    RETURNING "id"
  `;
  const params: any[] = [
    data.title,
    data.logoSmallId,
    data.logoLargeId,
    data.shortDescription,
    data.description,
    data.headerImageId,
    JSON.stringify(data.links),
    data.tags,
    userId,
    url
  ];
  const result = await db.query(query, params);
  if (result.rows.length === 1) {
    return result.rows[0];
  }
  throw new Error("Community creation failed");
};

async function _updateCommunity(
  db: Pool | PoolClient,
  data: API.Community.updateCommunity.Request & { previewImageId?: string }
): Promise<{ updatedAt: string }> {
  const setArray: string[] = [];
  const params: any[] = [data.id];
  let i = 2;
  if (data.description !== undefined) {
    setArray.push(`"description" = $${i++}`);
    params.push(data.description);
  }
  if (data.logoSmallId !== undefined) {
    setArray.push(`"logoSmallId" = $${i++}`);
    params.push(data.logoSmallId);
  }
  if (data.logoLargeId !== undefined) {
    setArray.push(`"logoLargeId" = $${i++}`);
    params.push(data.logoLargeId);
  }
  if (data.headerImageId !== undefined) {
    setArray.push(`"headerImageId" = $${i++}`);
    params.push(data.headerImageId);
  }
  if (data.links !== undefined) {
    setArray.push(`"links" = $${i++}`);
    params.push(JSON.stringify(data.links));
  }
  if (data.shortDescription !== undefined) {
    setArray.push(`"shortDescription" = $${i++}`);
    params.push(data.shortDescription);
  }
  if (data.tags !== undefined) {
    setArray.push(`"tags" = $${i++}`);
    params.push(data.tags);
  }
  if (data.title !== undefined) {
    setArray.push(`"title" = $${i++}`);
    params.push(data.title);
  }
  if (data.previewImageId !== undefined) {
    setArray.push(`"previewImageId" = $${i++}`);
    params.push(data.previewImageId);
  }
  if (data.enablePersonalNewsletter !== undefined) {
    setArray.push(`"enablePersonalNewsletter" = $${i++}`);
    params.push(data.enablePersonalNewsletter);
  }
  if (setArray.length === 0) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  const query = `
    UPDATE communities
    SET ${setArray.join(',')}, "updatedAt" = NOW()
    WHERE "id" = $1
    RETURNING "updatedAt"
  `;
  const result = await db.query(query, params);
  return result.rows[0] as {
    updatedAt: string;
  };
}

/* AREA */

async function _createArea(
  db: Pool | PoolClient,
  data: API.Community.createArea.Request
): Promise<{ id: string, updatedAt: string }> {
  const q = {
    query: `
      INSERT INTO areas (
        "communityId",
        "title",
        "order"
      ) VALUES ($1,$2,$3)
      RETURNING "id", "updatedAt"
    `,
    params: [
      data.communityId,
      data.title,
      data.order
    ]
  };
  const result = await db.query(q.query, q.params);
  if (result.rows.length === 1) {
    return result.rows[0];
  }
  throw new Error(errors.server.NOT_ALLOWED);
}

async function _updateArea(
  db: Pool | PoolClient,
  data: API.Community.updateArea.Request
) {
  const setArray: string[] = [];
  const params: any[] = [data.communityId, data.id];
  let i = 3;
  if (data.order !== undefined) {
    setArray.push(`"order" = $${i++}`);
    params.push(data.order);
  }
  if (data.title !== undefined) {
    setArray.push(`"title" = $${i++}`);
    params.push(data.title);
  }
  if (setArray.length === 0) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  const query = `
    UPDATE areas
    SET ${setArray.join(',')}, "updatedAt" = NOW()
    WHERE "communityId" = $1 AND "id" = $2
    RETURNING "updatedAt"
  `;
  const result = await db.query(query, params);
  if (result.rows.length === 1) {
    return result.rows[0] as { updatedAt: string };
  }
  throw new Error(errors.server.NOT_ALLOWED)
}

async function _deleteArea(
  db: Pool | PoolClient,
  data: API.Community.deleteArea.Request
): Promise<void> {
  const q = {
    query: `
      WITH delete_area AS (
        UPDATE areas
        SET "updatedAt" = NOW(), "deletedAt" = NOW()
        WHERE "communityId" = $1 AND "id" = $2
      )
      UPDATE communities_channels
      SET "updatedAt" = NOW(), "areaId" = NULL
      WHERE "communityId" = $1 AND "areaId" = $2
    `,
    params: [
      data.communityId,
      data.id
    ]
  };
  await db.query(q.query, q.params);
}

/* CHANNEL */

async function _createChannel(
  runner: PoolClient,
  data: API.Community.createChannel.Request,
): Promise<{ communityId: string, channelId: string, updatedAt: string }> {
  const query = `
    WITH insert_channel AS (
      INSERT INTO channels
      DEFAULT VALUES
      RETURNING "id"
    )
    INSERT INTO communities_channels (
      "channelId",
      "areaId",
      "communityId",
      "title",
      "emoji",
      "description",
      "order",
      "url"
    ) VALUES (
      (SELECT "id" FROM insert_channel),
      $1,$2,$3,$4,$5,$6,$7
    )
    RETURNING "communityId", "channelId", "updatedAt"
  `;
  const params: any[] = [
    data.areaId,
    data.communityId,
    data.title,
    data.emoji,
    data.description,
    data.order,
    data.url
  ];
  const result = await runner.query(query, params);
  if (result.rows.length === 1) {
    const insertResult: { communityId: string, channelId: string, updatedAt: string } = result.rows[0];
    const query = `
      INSERT INTO communities_channels_roles_permissions
        ("communityId", "channelId", "roleId", "permissions")
      VALUES
        ${data.rolePermissions.map(
      rp => format(
        '(%L::uuid, %L::uuid, %L::uuid, ARRAY[%L]::"public"."communities_channels_roles_permissions_permissions_enum"[])',
        insertResult.communityId,
        insertResult.channelId,
        rp.roleId,
        rp.permissions
      )
    ).join(',')}
    `;
    const permResult = await runner.query(query);
    if (permResult.rowCount > 0) {
      return insertResult;
    }
  }
  throw new Error("Error adding channel");
}

async function _updateChannel(
  db: PoolClient,
  data: API.Community.updateChannel.Request
): Promise<{
  updatedAt: string;
  deletedRolesAccess: {
    roleId: string;
  }[];
}> {
  const setArray: string[] = [];
  const params: any[] = [data.communityId, data.channelId];
  let i = 3;

  if (data.order !== undefined) {
    setArray.push(`"order" = $${i++}`);
    params.push(data.order);
  }
  if (data.title !== undefined) {
    setArray.push(`"title" = $${i++}`);
    params.push(data.title);
  }
  if (data.areaId !== undefined) {
    setArray.push(`"areaId" = $${i++}`);
    params.push(data.areaId);
  }
  if (data.description !== undefined) {
    setArray.push(`"description" = $${i++}`);
    params.push(data.description);
  }
  if (data.emoji !== undefined) {
    setArray.push(`"emoji" = $${i++}`);
    params.push(data.emoji);
  }
  if (data.url !== undefined) {
    setArray.push(`"url" = $${i++}`);
    params.push(data.url);
  }
  if (data.pinnedMessageIds !== undefined) {
    setArray.push(`"pinnedMessageIds" = $${i++}`);
    params.push(JSON.stringify(data.pinnedMessageIds));
  }
  if (setArray.length === 0 && !data.rolePermissions) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  const query = `
    UPDATE communities_channels
    SET ${setArray.length > 0 ? `${setArray.join(',')},` : ''} "updatedAt" = NOW()
    WHERE "communityId" = $1 AND "channelId" = $2 AND "deletedAt" IS NULL
    RETURNING "updatedAt"
  `;
  const result = await db.query(query, params);
  let updatedAt: string;
  if (result.rowCount === 1) {
    updatedAt = result.rows[0].updatedAt;
  } else {
    throw new Error(errors.server.NOT_FOUND);
  }

  let deletedRolesAccess: {
    roleId: string;
  }[] = [];
  if (data.rolePermissions !== undefined) {
    const query = `
      WITH insert_permissions AS (
        INSERT INTO communities_channels_roles_permissions
          ("communityId", "channelId", "roleId", "permissions")
        VALUES 
          ${data.rolePermissions.map(
      rp => format(
        '(%L::uuid, %L::uuid, %L::uuid, ARRAY[%L]::"public"."communities_channels_roles_permissions_permissions_enum"[])',
        data.communityId,
        data.channelId,
        rp.roleId,
        rp.permissions
      )
    ).join(',')}
        ON CONFLICT ("communityId", "channelId", "roleId")
          DO UPDATE SET "permissions" = EXCLUDED."permissions"
      )
      DELETE FROM communities_channels_roles_permissions
      WHERE "communityId" = $1 AND "channelId" = $2 AND NOT "roleId" = ANY(ARRAY[${format("%L", data.rolePermissions.map(r => r.roleId))}]::UUID[])
      RETURNING "roleId"
    `;
    const result = await db.query(query, [
      data.communityId,
      data.channelId,
    ]);
    deletedRolesAccess = result.rows as {
      roleId: string;
    }[];
  }
  return {
    updatedAt,
    deletedRolesAccess,
  };
}

async function _deleteChannel(
  db: Pool | PoolClient,
  data: API.Community.deleteChannel.Request,
): Promise<void> {
  const query = `
    UPDATE communities_channels
    SET "updatedAt" = NOW(), "deletedAt" = NOW(), "url" = NULL
    WHERE "communityId" = $1 AND "channelId" = $2
  `;
  const params = [
    data.communityId,
    data.channelId
  ];
  const result = await db.query(query, params);
  if (result.rowCount !== 1) {
    throw new Error(errors.server.NOT_FOUND);
  }
}

/* ROLE */

async function _getRole(
  db: Pool | PoolClient,
  roleId: string,
) {
  const query = `
    SELECT
      "communityId",
      "title",
      "type",
      "assignmentRules",
      "permissions",
      "updatedAt",
      "imageId",
      "description",
      "airdropConfig"
    FROM roles
    WHERE "id" = $1
      AND "deletedAt" IS NULL
  `;
  const result = await db.query(query, [roleId]);
  if (result.rows.length === 1) {
    return result.rows[0] as {
      communityId: string;
      title: string;
      type: RoleType,
      assignmentRules: Models.Community.AssignmentRules | null,
      permissions: Common.CommunityPermission[],
      updatedAt: string,
      description: string | null,
      imageId: string | null,
      airdropConfig: Models.Community.RoleAirdropConfig | null
    };
  }
  throw new Error(errors.server.NOT_FOUND);
}

async function _createRole(
  db: PoolClient,
  data: API.Community.createRole.Request
): Promise<{ id: string, updatedAt: string }> {
  const query = `
    INSERT INTO roles (
      "communityId",
      "title",
      "type",
      "assignmentRules",
      "permissions",
      "imageId",
      "description"
    ) VALUES ($1,$2,$3,$4,$5,$6,$7)
    RETURNING "id", "updatedAt"
  `;
  const params = [
    data.communityId,
    data.title,
    data.type,
    data.assignmentRules,
    data.permissions,
    data.imageId,
    data.description
  ];
  const result = await db.query(query, params);
  if (result.rows.length === 1) {
    const contractIds: string[] = [];
    const row = result.rows[0] as { id: string, updatedAt: string };
    if (data.assignmentRules !== null && data.assignmentRules.type === 'token') {
      const { rules } = data.assignmentRules;
      contractIds.push(rules.rule1.contractId);
      if ('rule2' in rules) {
        contractIds.push(rules.rule2.contractId);
      }
      await db.query(`
        INSERT INTO roles_contracts_contracts (
          "rolesId",
          "contractsId"
        )
        VALUES ${contractIds.map(c_id => format('(%L::UUID, %L::UUID)', row.id, c_id)).join(',')}
      `);
    }
    return row;
  }
  throw new Error("Role could not be created");
}

async function _updateRole(
  db: PoolClient,
  data: API.Community.updateRole.Request
): Promise<{ updatedAt: string }> {
  const params: any[] = [data.communityId, data.id];
  let _noPredefined = false, _noAdmin = false;
  const setArray: string[] = [];
  let CTE = '';
  let i = 3;
  if (data.title !== undefined) {
    _noPredefined = true;
    setArray.push(`"title" = $${i++}`);
    params.push(data.title);
  }
  if (data.assignmentRules !== undefined) {
    _noPredefined = true;
    setArray.push(`"assignmentRules" = $${i++}`);
    params.push(data.assignmentRules);
    if (data.assignmentRules === null || data.assignmentRules.type === 'free') {
      CTE = `
        WITH delete_roles_contracts AS (
          DELETE FROM roles_contracts_contracts
          WHERE "rolesId" = ${format('%L::UUID', data.id)}
        )
      `;
    } else if (data.assignmentRules.type === 'token') {
      const contractIds: string[] = [];
      const { rules } = data.assignmentRules;
      contractIds.push(rules.rule1.contractId);
      if ('rule2' in rules) {
        contractIds.push(rules.rule2.contractId);
      }
      CTE = `
        WITH upsert_roles_contracts AS (
          INSERT INTO roles_contracts_contracts (
            "rolesId",
            "contractsId"
          )
          VALUES ${contractIds.map(c_id => format('(%L::UUID, %L::UUID)', data.id, c_id)).join(',')}
          ON CONFLICT ("rolesId", "contractsId")
            DO UPDATE SET "contractsId" = EXCLUDED."contractsId"
          RETURNING "contractsId"
        ), delete_other AS (
          DELETE FROM roles_contracts_contracts
          WHERE "rolesId" = ${format('%L', data.id)} AND
            NOT "contractsId" = ANY(SELECT "contractsId" FROM upsert_roles_contracts)
        )
      `;
    }
  }
  if (data.type !== undefined) {
    _noPredefined = true;
    setArray.push(`"type" = $${i++}`);
    params.push(data.type);
    if (data.type === RoleType.PREDEFINED) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
  }
  if (data.permissions !== undefined) {
    _noAdmin = true;
    setArray.push(`"permissions" = $${i++}`);
    params.push(data.permissions);
  }
  if (data.imageId !== undefined) {
    setArray.push(`"imageId" = $${i++}`);
    params.push(data.imageId);
  }
  if (data.description !== undefined) {
    setArray.push(`"description" = $${i++}`);
    params.push(data.description);
  }
  if (setArray.length === 0) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  // The CTE is not a problem cleanup-wise, since a rollback
  // has to happen when we run into an error
  const query = `
    ${CTE}
    UPDATE roles
    SET ${setArray.join(',')}, "updatedAt" = NOW()
    WHERE "communityId" = $1 AND "id" = $2 AND "deletedAt" IS NULL
    ${_noPredefined ? format('AND "type" <> %L', RoleType.PREDEFINED) : ''}
    ${_noAdmin ? format('AND "title" <> %L', PredefinedRole.Admin) : ''}
    RETURNING "updatedAt"
  `;
  const result = await db.query(query, params);
  if (result.rowCount === 1) {
    return result.rows[0];
  }
  throw new Error(errors.server.NOT_ALLOWED);
}

async function _deleteRole(
  db: Pool | PoolClient,
  data: API.Community.deleteRole.Request
): Promise<void> {
  const query = `
    WITH role_select AS (
      SELECT "id" FROM roles
      WHERE "id" = $1
        AND "communityId" = $2
        AND "deletedAt" IS NULL
        AND "type" <> ${format('%L', RoleType.PREDEFINED)}
    ),
    userrole_delete AS (
      DELETE FROM roles_users_users
      WHERE "roleId" = (SELECT "id" FROM role_select)
    ),
    channelrole_delete AS (
      DELETE FROM communities_channels_roles_permissions
      WHERE "roleId" = (SELECT "id" FROM role_select)
    ),
    articlerole_delete AS (
      DELETE FROM communities_articles_roles_permissions
      WHERE "roleId" = (SELECT "id" FROM role_select)
    )
    UPDATE roles
    SET "updatedAt" = NOW(), "deletedAt" = NOW()
    WHERE "id" = (SELECT "id" FROM role_select)
  `;
  const params = [
    data.id,
    data.communityId
  ];
  const result = await db.query(query, params);
  if (result.rowCount === 0) {
    throw new Error(errors.server.NOT_ALLOWED);
  }
}

async function _addUserToRoles(
  db: Pool | PoolClient,
  data: {
    userId: string;
    communityId: string;
    roleIds: string[];
  }
) {
  const { communityId, userId, roleIds } = data;
  const query = `
    WITH role_data AS (
      SELECT "id", "title", $2::UUID AS "userId", TRUE AS "claimed"
      FROM roles
      WHERE "communityId" = $1
        AND "title" <> ${format('%L', PredefinedRole.Public)}
        AND "id" = ANY(ARRAY[${roleIds.map(s => format('%L', s)).join(',')}]::uuid[])
        AND "deletedAt" IS NULL
    )
    INSERT INTO roles_users_users ("roleId", "userId", "claimed")
    SELECT "id", "userId", "claimed" FROM role_data
    ON CONFLICT ("roleId", "userId")
      DO UPDATE SET "claimed" = TRUE, "updatedAt" = now()
    RETURNING "roleId"
  `;
  const result = await db.query(query, [communityId, userId]);
  return {
    createdUserRoles: result.rows as { roleId: string }[]
  }
}

async function _removeUserFromRoles(
  db: Pool | PoolClient,
  data: {
    userId: string;
    communityId: string;
    roleIds: string[];
  }
) {
  const { communityId, userId, roleIds } = data;
  const query = `
    WITH role_data AS (
      SELECT "id" FROM roles
      WHERE "communityId" = $1
        AND "title" <> ${format('%L', PredefinedRole.Member)}
        AND "id" = ANY(ARRAY[${roleIds.map(s => format('%L::UUID', s)).join(',')}])
    )
    DELETE FROM roles_users_users
    WHERE "userId" = $2
      AND "roleId" = ANY(SELECT "id" FROM role_data)
    RETURNING "roleId"
  `;
  const result = await db.query(query, [communityId, userId]);
  return {
    deletedUserRoles: result.rows as { roleId: string }[]
  }
}

async function _getCommunityRoles(
  db: Pool | PoolClient,
  communityId: string,
) {
  const roleResult = await db.query(`
    SELECT
      "id",
      "type",
      "title",
      "assignmentRules",
      "permissions"
    FROM roles
    WHERE "communityId" = $1
      AND "deletedAt" IS NULL
  `, [communityId]);
  return roleResult.rows as {
    id: string;
    type: RoleType;
    title: string;
    assignmentRules: Models.Community.AssignmentRules | null;
    permissions: Common.CommunityPermission[];
  }[];
}

async function _getCommunityTokens(
  db: Pool | PoolClient,
  communityId: string,
) {
  const existingTokens = await db.query<{
    contractId: string;
    order: number;
    active: boolean;
  }>(`
    SELECT
      ct."contractId",
      ct."order",
      ct."active"
    FROM communities_tokens ct
    WHERE ct."communityId" = $1
  `, [communityId]);
  return existingTokens.rows;
}

async function _getTagFrequencyData(
  db: Pool | PoolClient,
) {
  const result = await db.query(`
    SELECT "tags" FROM communities
    WHERE array_length("tags", 1) > 0
  `);
  const tagMap: { [tag: string]: number } = {};
  for (const row of result.rows as { tags: string[] }[]) {
    for (const tag of row.tags) {
      tagMap[tag] = (tagMap[tag] || 0) + 1;
    }
  }
  return tagMap;
}

/* REPOSITORY */

class CommunityHelper {
  public async getCommunityList(data: API.Community.getCommunityList.Request): Promise<Models.Community.ListView[]> {
    let orderBy = 'c."createdAt" DESC';
    if (data.sort === 'popular') {
      orderBy = 'c."activityScore" DESC';
    }
    // If searching, allow any community to be shown
    const whereArray: string[] = !!data.search ? [] : ['(c."memberCount" >= 5 OR cp."activeUntil" >= NOW())'];
    if (data.search !== undefined) {
      let sqlSafeQuery = data.search.replace(/\\/g, '\\\\');  // Escape backslashes first (\ -> \\)
      sqlSafeQuery = sqlSafeQuery.replace(/%/g, '\\%');  // Escape % -> \%
      sqlSafeQuery = sqlSafeQuery.replace(/_/g, '\\_');  // Escape _ -> \_
      whereArray.push(`(
        c."title" ILIKE ${format('%L', `%${sqlSafeQuery}%`)} ESCAPE '\\'
      )`);
    }
    if (!!data.tags && data.tags.length > 0) {
      const tagArrayString = `ARRAY[${data.tags.map(t => format('%L', t)).join(',')}]::varchar[]`;
      whereArray.push(`c."tags" @> ${tagArrayString}`);
    }
    const result = await _getCommunityListView(pool, {
      where: whereArray.join(' AND '),
      orderBy,
      limit: data.limit || config.GROUPS_BATCH_SIZE,
      offset: data.offset
    });
    return result;
  }

  public async getCommunitiesById(data: API.Community.getCommunitiesById.Request): Promise<Models.Community.ListView[]> {
    let where = `c."id" = ANY(ARRAY[${format('%L', data.ids)}]::UUID[])`;
    const result = await _getCommunityListView(pool, {
      where,
    });
    return result;
  }


  public async getCommunityDetailView(data: API.Community.getCommunityDetailView.Request, userId?: string): Promise<Models.Community.DetailViewFromApi> {
    let CTE = `
      WITH community_id AS (
        SELECT id FROM communities
        WHERE ${'id' in data
        ? format("id = %L::UUID", data.id)
        : format("url = %L", data.url)
      }
      )
    `;
    let extraFields: string;
    if (!!userId) {
      CTE += `,
        my_roles AS (
          SELECT r."id" FROM roles r
          LEFT JOIN roles_users_users ruu ON (r."id" = ruu."roleId" AND ruu.claimed = TRUE)
          WHERE r."communityId" = (SELECT id FROM community_id) AND ruu."userId" = ${format("%L::UUID", userId)} AND r."deletedAt" IS NULL
        )`;
      extraFields = `
        COALESCE((
          SELECT ARRAY_TO_JSON(ARRAY_AGG(mr."id"))
          FROM my_roles mr
        ), '[]'::JSON) AS "myRoleIds",
        COALESCE((
          SELECT json_build_object(
            'state', ucs."blockState",
            'until', ucs."blockStateUntil"
          )
          FROM user_community_state ucs
          WHERE ucs."userId" = ${format("%L::UUID", userId)}
            AND ucs."communityId" = (SELECT id FROM community_id)
            AND (ucs."blockStateUntil" IS NULL OR ucs."blockStateUntil" > NOW())
        ), ${blockStateCoalesce}) AS "blockState"`;
    } else {
      extraFields = `
        (
          SELECT '[]'::JSON
        ) AS "myRoleIds",
        ${blockStateCoalesce} AS "blockState"`;
    }
    const result = await _getCommunityDetailView<{
      myRoleIds: string[];
      blockState: Models.Community.DetailView["blockState"];
    }>(pool, {
      userId,
      CTE,
      extraFields,
      where: `c."id" = (SELECT id FROM community_id)`,
    });
    if (result.length === 1) {
      this.filterCommunitiesVisibility(result);
      const channelTdsWithoutLastRead: string[] = [];
      const newLastRead = new Date().toISOString();
      for (const channel of result[0].channels) {
        if (channel.lastRead === null) {
          channel.lastRead = newLastRead;
          channelTdsWithoutLastRead.push(channel.channelId);
        }
      }
      if (channelTdsWithoutLastRead.length > 0 && !!userId) {
        await pool.query(`
          INSERT INTO channelreadstate ("channelId", "userId", "lastRead")
          VALUES ${channelTdsWithoutLastRead.map(channelId =>
          format("(%L::UUID, %L::UUID, %L::TIMESTAMPTZ)", channelId, userId, newLastRead)
        ).join(',')}
          ON CONFLICT ("channelId", "userId") DO UPDATE SET "lastRead" = EXCLUDED."lastRead"
        `);
      }
      return result[0] as typeof result[0] & {
        channels: (typeof result[0]["channels"][0] & { lastRead: string })[];
      };
    } else {
      throw new Error(errors.server.NOT_FOUND);
    }
  }

  public async attemptJoinCommunity(userId: string, communityId: string, questionnaireAnswers?: Models.Community.QuestionnaireAnswer[], password?: string): Promise<Models.Community.DetailViewFromApi | null> {
    const blockState = await this.getUserBlockState(userId, communityId);
    if (blockState === 'BANNED') {
      throw new Error(errors.server.NOT_ALLOWED);
    }

    const onboardingOptions = await this.getCommunityOnboardingOptions(communityId);
    // Verify questions
    if (onboardingOptions?.questionnaire?.enabled) {
      const verifyQuestionnaire = () => {
        const onboardingQuestions = onboardingOptions.questionnaire?.questions;
        if (!questionnaireAnswers) return false;
        if (!onboardingQuestions) return false;
        if (questionnaireAnswers.length !== onboardingQuestions.length) return false;
        for (let i = 0; i < (questionnaireAnswers?.length || 0); i++) {
          if (questionnaireAnswers[i].answer.length === 0) return false;
          if (questionnaireAnswers[i].question !== onboardingQuestions[i].question) return false;
          if (questionnaireAnswers[i].type !== onboardingQuestions[i].type) return false;
          if (questionnaireAnswers[i].type !== 'text' && questionnaireAnswers[i].answer.some(selectedAnswer => !onboardingQuestions[i].options.includes(selectedAnswer))) {
            return false;
          }
        }

        return true;
      }

      if (!(verifyQuestionnaire())) {
        throw new Error(errors.server.NOT_ALLOWED);
      }
    }

    // Verify requirements
    if (onboardingOptions?.requirements?.enabled) {
      const [ownUser] = await userHelper.getUserDataByIds([userId], userId);
      const result = checkCommunityRequirements(onboardingOptions.requirements, ownUser);
      if (!!result) {
        throw new Error(errors.server.NOT_ALLOWED);
      }
    }

    // Verify password
    if (onboardingOptions?.passwordProtected?.enabled) {
      const expectedPassword = await this.getCommunityPassword(communityId);
      if (password !== expectedPassword.password) {
        throw new Error(errors.server.NOT_ALLOWED);
      }
    }

    if (onboardingOptions?.manuallyApprove?.enabled) {
      // check if not recently denied
      const joinApproval = await this.getJoinApproval(communityId, userId);
      if (joinApproval?.approvalState === CommunityApprovalState.DENIED) {
        const lastChanged = dayjs(joinApproval?.updatedAt);
        const changedLessThan24Hours = dayjs().isBefore(lastChanged.add(24, 'hour'));
        if (changedLessThan24Hours) {
          throw new Error(errors.server.COMMUNITY_JOIN_IN_WAIT_PERIOD);
        }
      }

      const result = await pool.query(`
        INSERT INTO user_community_state ("userId", "communityId", "questionnaireAnswers", "approvalState")
        VALUES ($1, $2, $3, ${format("%L", CommunityApprovalState.PENDING)})
        ON CONFLICT ("userId", "communityId")
          DO UPDATE SET
            "approvalState" = EXCLUDED."approvalState",
            "questionnaireAnswers" = EXCLUDED."questionnaireAnswers",
            "approvalUpdatedAt" = now(),
            "userLeftCommunity" = now()
        RETURNING 1
      `, [userId, communityId, !!questionnaireAnswers ? JSON.stringify(questionnaireAnswers) : null]);
      if (result.rows.length !== 1) {
        throw new Error(errors.server.NOT_ALLOWED);
      }

      const pendingApprovals = await this.getPendingJoinApprovals(communityId);
      const roles = await this.getCommunityRoles(communityId);
      const rolesWithPermission = roles.filter(role => role.permissions.includes('COMMUNITY_MANAGE_USER_APPLICATIONS'));

      eventHelper.emit({
        type: 'cliCommunityEvent',
        action: 'update',
        data: {
          id: communityId,
          updatedAt: new Date().toISOString(),
          membersPendingApproval: pendingApprovals.length,
        }
      }, {
        roleIds: rolesWithPermission.map(r => r.id)
      });

      return null;
    } else {
      return this.joinCommunity(userId, communityId, onboardingOptions?.questionnaire?.enabled ? questionnaireAnswers : undefined);
    }
  }

  private async joinCommunity(userId: string, communityId: string, questionnaireAnswers?: Models.Community.QuestionnaireAnswer[]): Promise<Models.Community.DetailViewFromApi> {
    const blockState = await this.getUserBlockState(userId, communityId);
    if (blockState !== 'BANNED') {
      const result = await pool.query(`
        WITH member_role AS (
          SELECT r."id" FROM roles r
          WHERE r."communityId" = $2::UUID
            AND r."title" = ${format("%L", PredefinedRole.Member)}
            AND r."type" = ${format('%L', RoleType.PREDEFINED)}
        ),
        role_insert AS (
          INSERT INTO roles_users_users ("roleId", "userId", "claimed")
          VALUES ((SELECT id FROM member_role), $1, TRUE)
          RETURNING 1
        ),
        user_update AS (
          UPDATE users u
          SET "communityOrder" =
            CASE
              WHEN u."communityOrder" @> ARRAY[$2::UUID]
              THEN u."communityOrder"
              ELSE array_append(u."communityOrder", $2::UUID)
            END
          WHERE u.id = $1
            AND EXISTS (SELECT 1 FROM role_insert)
          RETURNING "communityOrder"
        ),
        user_community_state_update AS (
          INSERT INTO user_community_state ("userId", "communityId", "questionnaireAnswers", "approvalState")
          VALUES ($1, $2, ${!!questionnaireAnswers ? format("%L, %L", JSON.stringify(questionnaireAnswers), CommunityApprovalState.APPROVED) : 'NULL, NULL'})
          ON CONFLICT ("userId", "communityId")
          DO UPDATE SET
            ${!!questionnaireAnswers ? `"approvalState" = EXCLUDED."approvalState", "questionnaireAnswers" = EXCLUDED."questionnaireAnswers",` : ''}
            "approvalUpdatedAt" = now(),
            "userLeftCommunity" = NULL
        )
        UPDATE communities
        SET "memberCount" = "memberCount" + 1, "updatedAt" = now()
        WHERE id = $2::UUID AND EXISTS (SELECT 1 FROM role_insert)
        RETURNING "memberCount", (SELECT "communityOrder" FROM user_update), "updatedAt"
      `, [userId, communityId]);
      if (result.rows.length !== 1) {
        throw new Error(errors.server.NOT_ALLOWED);
      }
      const data = await this.getCommunityDetailView({ id: communityId }, userId);
      const memberRoleId = data.roles.find(r => r.title === PredefinedRole.Member)?.id;
      if (!memberRoleId) {
        throw new Error("Member Role not found, this is - theoretically - impossible. If this happened, a member role was either not created or deleted, which should not happen.");
      }
      eventHelper.emit({
        type: "cliCommunityEvent",
        action: "update",
        data: {
          id: communityId,
          memberCount: result.rows[0].memberCount,
          updatedAt: result.rows[0].updatedAt,
        },
      }, {
        communityIds: [communityId],
      });
      eventHelper.emit({
        type: "cliMembershipEvent",
        action: "join",
        data: {
          communityId: communityId,
          userId: userId,
          roleIds: [memberRoleId],
        },
      }, {
        communityIds: [communityId],
      });
      eventHelper.emit({
        type: "cliUserOwnData",
        data: {
          communityOrder: result.rows[0].communityOrder,
        },
      }, {
        userIds: [userId]
      });
      eventHelper.userJoinRooms(userId, {
        roleIds: [memberRoleId],
        communityIds: [communityId],
      });
      return data;
    }

    throw new Error(errors.server.NOT_ALLOWED);
  }

  public async leaveCommunity(userId: string, communityId: string): Promise<Models.Community.DetailViewFromApi> {
    const result = await pool.query(`
      WITH delete_roles AS (
        DELETE FROM roles_users_users
        WHERE "userId" = $1
          AND "roleId" = ANY(
            SELECT "id" FROM roles
            WHERE "communityId" = $2
          )
        RETURNING "roleId"
      ),
      user_update AS (
        UPDATE users u
        SET "communityOrder" =
          CASE
            WHEN u."communityOrder" @> ARRAY[$2::UUID]
            THEN array_remove(u."communityOrder", $2::UUID)
            ELSE u."communityOrder"
          END
        WHERE u.id = $1
          AND EXISTS (SELECT 1 FROM delete_roles)
        RETURNING "communityOrder"
      ),
      channel_setting_delete AS (
        DELETE FROM user_channel_settings
        WHERE "userId" = $1
          AND "communityId" = $2
      ),
      user_community_state_update AS (
        UPDATE user_community_state
        SET "userLeftCommunity" = now()
        WHERE "userId" = $1
          AND "communityId" = $2
      )
      UPDATE communities
      SET "memberCount" = "memberCount" - 1, "updatedAt" = now()
      WHERE id = $2 AND EXISTS (SELECT 1 FROM delete_roles)
      RETURNING "memberCount", (
        SELECT array_to_json(array_agg("roleId"))
        FROM delete_roles
      ) AS "deletedRolesIds",
      (SELECT "communityOrder" FROM user_update),
      "updatedAt"
    `, [userId, communityId]);
    if (result.rows.length !== 1) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
    const leaveResult: {
      memberCount: number;
      deletedRolesIds: string[];
      communityOrder: string[]
    } = result.rows[0];
    const data = await this.getCommunityDetailView({ id: communityId }, userId);
    eventHelper.userLeaveRooms(userId, {
      roleIds: result.rows[0].deletedRolesIds,
      communityIds: [communityId],
    });
    eventHelper.emit({
      type: "cliCommunityEvent",
      action: "update",
      data: {
        id: communityId,
        memberCount: result.rows[0].memberCount,
        updatedAt: result.rows[0].updatedAt,
      },
    }, {
      communityIds: [communityId]
    });
    eventHelper.emit({
      type: "cliUserOwnData",
      data: {
        communityOrder: leaveResult.communityOrder,
      },
    }, {
      userIds: [userId]
    });
    eventHelper.emit({
      type: "cliMembershipEvent",
      action: "leave",
      data: {
        communityId: communityId,
        userId: userId,
      },
    }, {
      communityIds: [communityId],
    });
    const roleIds = data.roles.map(r => r.id);
    await eventHelper.userLeaveRooms(userId, {
      communityIds: [communityId],
      roleIds,
    });
    await botHelper.reconcileUserBotsForOwner(userId, communityId);
    return data;
  }

  public async setUserBlockState(data: API.Community.setUserBlockState.Request) {
    // check if user is admin
    const isAdmin = await pool.query(`
      SELECT 1
      FROM roles_users_users ruu
      INNER JOIN roles r
        ON r.id = ruu."roleId"
      WHERE ruu."userId" = $1
        AND r."title" = '${PredefinedRole.Admin}'
        AND r."type" = '${RoleType.PREDEFINED}'
        AND r."communityId" = $2
        AND ruu."claimed" = TRUE
    `, [data.userId, data.communityId]);
    if (isAdmin.rows.length === 1) {
      throw new Error(errors.server.NOT_ALLOWED);
    }

    // check if user is owner
    const isCreator = await pool.query(`
      SELECT 1
      FROM communities
      WHERE "creatorId" = $1 AND "id" = $2
    `, [data.userId, data.communityId]);
    if (isCreator.rows.length === 1) {
      throw new Error(errors.server.NOT_ALLOWED);
    }

    if (data.blockState === null) {
      await pool.query(`
        UPDATE user_community_state
        SET
          "blockState" = null,
          "blockStateUntil" = null,
          "blockStateUpdatedAt" = now()
        WHERE "userId" = $1 AND "communityId" = $2
      `, [data.userId, data.communityId]);
    }
    else {
      if (data.blockState === UserBlockState.BANNED) {
        try {
          await this.leaveCommunity(data.userId, data.communityId);
        }
        catch (e) {
          console.error("Could not make user leave community as of ban", e);
        }
      }
      await pool.query(`
        INSERT INTO user_community_state ("userId", "communityId", "blockState", "blockStateUntil", "blockStateUpdatedAt")
        VALUES ($1, $2, $3, $4, now())
        ON CONFLICT ("userId", "communityId")
        DO UPDATE SET
          "blockState" = EXCLUDED."blockState",
          "blockStateUntil" = EXCLUDED."blockStateUntil",
          "blockStateUpdatedAt" = now()
      `, [data.userId, data.communityId, data.blockState, data.until]);
    }
  }

  public async getOwnCommunities(userId: string): Promise<Models.Community.DetailViewFromApi[]> {
    const result = await _getCommunityDetailView<{
      myRoleIds: string[];
      blockState: Models.Community.DetailView["blockState"];
    }>(pool, {
      userId,
      CTE: `
        WITH my_roles AS (
          SELECT r."id", r."communityId" FROM roles r
          LEFT JOIN roles_users_users ruu
            ON (r."id" = ruu."roleId" AND ruu.claimed = TRUE)
          WHERE ruu."userId" = $1 AND r."deletedAt" IS NULL
        )`,
      extraFields: `
        COALESCE((
          SELECT ARRAY_TO_JSON(ARRAY_AGG(mr."id"))
          FROM my_roles mr
          WHERE mr."communityId" = c."id"
        ), '[]'::JSON) AS "myRoleIds",
        COALESCE((
          SELECT json_build_object(
            'state', ucs."blockState",
            'until', ucs."blockStateUntil"
          )
          FROM user_community_state ucs
          WHERE ucs."userId" = $1
            AND ucs."communityId" = c."id"
            AND (ucs."blockStateUntil" IS NULL OR ucs."blockStateUntil" > NOW())
        ), ${blockStateCoalesce}) AS "blockState"`,
      where: `c."id" = ANY(SELECT DISTINCT "communityId" FROM my_roles)`,
      params: [userId]
    });
    this.filterCommunitiesVisibility(result);
    const channelIdsWithoutLastRead: string[] = [];
    const newLastRead = new Date().toISOString();
    for (const community of result) {
      for (const channel of community.channels) {
        if (channel.lastRead === null) {
          channel.lastRead = newLastRead;
          channelIdsWithoutLastRead.push(channel.channelId);
        }
      }
    }
    if (channelIdsWithoutLastRead.length > 0 && !!userId) {
      await pool.query(`
        INSERT INTO channelreadstate ("channelId", "userId", "lastRead")
        VALUES ${channelIdsWithoutLastRead.map(channelId =>
        format("(%L::UUID, %L::UUID, %L::TIMESTAMPTZ)", channelId, userId, newLastRead)
      ).join(',')}
        ON CONFLICT ("channelId", "userId") DO UPDATE SET "lastRead" = EXCLUDED."lastRead"
      `);
    }
    return result as (typeof result[0] & {
      channels: (typeof result[0]["channels"][0] & { lastRead: string })[];
    })[];
  }

  public async createCommunity(
    data: API.Community.createCommunity.Request,
    userId: string
  ): Promise<Models.Community.DetailViewFromApi> {
    const client = await pool.connect();
    let communityId: string;
    await client.query("BEGIN");
    try {
      communityId = (await _createCommunity(client, data, userId)).id;
      await client.query(`
        INSERT INTO user_community_state ("userId", "communityId")
        VALUES ($1, $2)
        ON CONFLICT ("userId", "communityId") DO NOTHING
      `, [userId, communityId]);
      const roleData: API.Community.createRole.Request[] = [
        {
          type: RoleType.PREDEFINED,
          title: PredefinedRole.Admin,
          assignmentRules: null,
          communityId,
          permissions: rolePermissionPresets.Community.Admin,
          imageId: null,
          description: null,
        }, {
          type: RoleType.PREDEFINED,
          title: PredefinedRole.Member,
          assignmentRules: null,
          communityId,
          permissions: rolePermissionPresets.Community.Member,
          imageId: null,
          description: null,
        }, {
          type: RoleType.PREDEFINED,
          title: PredefinedRole.Public,
          assignmentRules: null,
          communityId,
          permissions: rolePermissionPresets.Community.Public,
          imageId: null,
          description: null,
        }, {
          type: RoleType.CUSTOM_MANUAL_ASSIGN,
          title: "Editor",
          assignmentRules: null,
          communityId,
          permissions: rolePermissionPresets.Community.Editor,
          imageId: null,
          description: null,
        }, {
          type: RoleType.CUSTOM_MANUAL_ASSIGN,
          title: "Moderator",
          assignmentRules: null,
          communityId,
          permissions: rolePermissionPresets.Community.Moderator,
          imageId: null,
          description: null,
        }
      ];
      const roles = await Promise.all(
        roleData.map(async (data) => {
          const { id } = await _createRole(client, data);
          return {
            ...data,
            id
          };
        })
      );
      const areaData = {
        title: 'General',
        order: 10000000,
        communityId
      };
      const { id: areaId } = await _createArea(client, areaData);
      const channelData: API.Community.createChannel.Request = {
        areaId,
        communityId,
        title: 'General',
        order: 10000000,
        description: '',
        emoji: '',
        url: 'general',
        rolePermissions: roles.reduce<API.Community.createChannel.Request["rolePermissions"]>(
          (agg, role) => {
            const presets: { [title: string]: ChannelPermission[] } = rolePermissionPresets.Channel;
            if (Object.keys(presets).includes(role.title)) {
              const permissions = presets[role.title];
              if (permissions.length > 0) {
                agg.push({
                  roleId: role.id,
                  roleTitle: role.title,
                  permissions
                })
              }
            }
            return agg;
          }, []
        )
      };
      await _createChannel(client, channelData);
      await _addUserToRoles(client, {
        userId,
        communityId,
        roleIds: roles
          .filter(r => r.title === PredefinedRole.Admin || r.title === PredefinedRole.Member)
          .map(r => r.id)
      });
      const communityOrderResult = await client.query(`
        UPDATE users u
        SET "communityOrder" = array_append(u."communityOrder", $2::UUID)
        WHERE u.id = $1 AND NOT $2::UUID = any(u."communityOrder")
        RETURNING "communityOrder"
      `, [userId, communityId]);

      let firstArticleOriginalId: string | undefined;
      if (config.DEPLOYMENT === "prod") {
        firstArticleOriginalId = config.COMMUNITY_CREATION_ARTICLE_PROD;
      }
      else if (config.DEPLOYMENT === "staging") {
        firstArticleOriginalId = config.COMMUNITY_CREATION_ARTICLE_STAGING;
      }
      else if (config.DEPLOYMENT === "dev") {
        firstArticleOriginalId = config.COMMUNITY_CREATION_ARTICLE_DEV;
      }
      if (!!firstArticleOriginalId) {
        // the welcome-article template may not exist (e.g. fresh self-hosted
        // instances); a savepoint keeps a failure here from aborting the
        // whole community-creation transaction
        await client.query("SAVEPOINT initial_article");
        try {
          const articleInsertResult = await client.query(`
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
              SELECT
                ${format("%L::UUID", userId)} AS "creatorId",
                "headerImageId",
                "thumbnailImageId",
                "title",
                "content",
                "previewText",
                "tags",
                (SELECT "id" FROM insert_channel) AS "channelId"
              FROM articles
              WHERE id = ${format("%L::UUID", firstArticleOriginalId)}
              RETURNING id
            ),
            insert_community_article AS (
              INSERT INTO communities_articles (
                "communityId",
                "articleId",
                "published"
              )
              VALUES (
                ${format("%L::UUID", communityId)},
                (SELECT id FROM insert_article),
                now()
              )
            )
            INSERT INTO communities_articles_roles_permissions (
              "communityId",
              "articleId",
              "roleId",
              "permissions"
            )
            VALUES (
              ${format("%L::UUID", communityId)},
              (SELECT id FROM insert_article),
              ${format("%L::UUID", roles.find(r => r.title === PredefinedRole.Admin && r.type === RoleType.PREDEFINED)?.id)},
              ARRAY['ARTICLE_PREVIEW','ARTICLE_READ']::"public"."communities_articles_roles_permissions_permissions_enum"[]
            )
          `);
        }
        catch (e) {
          await client.query("ROLLBACK TO SAVEPOINT initial_article");
          console.error("Creating initial article failed, continuing without it", e);
        }
      }

      await eventHelper.emit({
        type: "cliUserOwnData",
        data: {
          communityOrder: communityOrderResult.rows[0].communityOrder,
        },
      }, {
        userIds: [userId]
      });
      await eventHelper.userJoinRooms(userId, {
        roleIds: roles
          .filter(r => r.title === PredefinedRole.Admin || r.title === PredefinedRole.Member)
          .map(r => r.id),
        communityIds: [communityId],
      });

      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    await botHelper.reconcilePlatformBotsForCommunity(communityId);
    return await this.getCommunityDetailView({ id: communityId }, userId);
  }

  public async updateCommunity(
    data: API.Community.updateCommunity.Request & { previewImageId?: string }
  ): Promise<void> {
    const { updatedAt } = await _updateCommunity(pool, data);
    // preview image should not be delivered as an update
    delete data.previewImageId;
    // send event if more than data.id is still present
    if (Object.keys(data).length > 1) {
      const event: Events.Community.Community = {
        type: "cliCommunityEvent",
        action: "update",
        data: {
          ...data,
          updatedAt,
        },
      };
      await eventHelper.emit(event, {
        communityIds: [data.id],
      });
    }
  }

  // public async getMemberList(
  //   data: API.Community.getMemberList.Request,
  // ): Promise<API.Community.getMemberList.Response> {
  //   return _getMemberList(pool, data);
  // }

  public async getMemberNewsletterCount(
    data: API.Community.getMemberNewsletterCount.Request,
  ): Promise<API.Community.getMemberNewsletterCount.Response> {
    const count = await emailHelper.getMembersCountForNewsletter(data);

    return { count };
  }

  public async createArea(data: API.Community.createArea.Request): Promise<{ id: string, updatedAt: string }> {
    const result = await _createArea(pool, data);
    const event: Events.Community.Area = {
      type: "cliAreaEvent",
      action: "new",
      data: { ...data, ...result },
    };
    await eventHelper.emit(event, {
      communityIds: [data.communityId],
    });
    return result;
  }

  public async updateArea(data: API.Community.updateArea.Request): Promise<{ updatedAt: string }> {
    const result = await _updateArea(pool, data);
    const event: Events.Community.Area = {
      type: "cliAreaEvent",
      action: "update",
      data: { ...data, ...result },
    };
    await eventHelper.emit(event, {
      communityIds: [data.communityId],
    });
    return result;
  }

  public async deleteArea(data: API.Community.deleteArea.Request): Promise<void> {
    await _deleteArea(pool, data);
    const event: Events.Community.Area = {
      type: "cliAreaEvent",
      action: "delete",
      data,
    };
    await eventHelper.emit(event, {
      communityIds: [data.communityId],
    });
  }

  public async createChannel(data: API.Community.createChannel.Request): Promise<void> {
    const client = await pool.connect();
    let result: Awaited<ReturnType<typeof _createChannel>>;
    await client.query("BEGIN");
    try {
      const communityRoles = await _getCommunityRoles(client, data.communityId);
      const existingRoleIds = new Set(communityRoles.map(r => r.id));
      const adminId = communityRoles.find(r => r.title === PredefinedRole.Admin && r.type === RoleType.PREDEFINED)?.id;
      if (!adminId) {
        console.error("No admin role found for community", data.communityId);
        throw new Error("No admin role found for community");
      }
      // check if all roleIds really belong to this community
      for (const rolePermission of data.rolePermissions) {
        if (!existingRoleIds.has(rolePermission.roleId) || rolePermission.roleId === adminId) {
          throw new Error(errors.server.NOT_ALLOWED);
        }
      }
      data.rolePermissions = [
        {
          roleId: adminId,
          roleTitle: PredefinedRole.Admin,
          permissions: rolePermissionPresets.Channel.Admin
        },
        ...data.rolePermissions,
      ];
      result = await _createChannel(client, data);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    const roleData = await permissionHelper.getRolePermissions({
      communityId: data.communityId,
      channelId: result.channelId
    });
    const eventRoleIds = new Set<string>();
    const eventCommunityIds = new Set<string>();
    for (const r of roleData) {
      if (r.permissions.includes(ChannelPermission.CHANNEL_EXISTS)) {
        if (r.title === PredefinedRole.Public) {
          eventCommunityIds.add(data.communityId);
        } else {
          eventRoleIds.add(r.id);
        }
      }
    }
    const event: Events.Community.Channel = {
      type: "cliChannelEvent",
      action: "new",
      data: {
        ...data,
        ...result,
        lastRead: new Date().toISOString(),
        lastMessageDate: null,
        pinType: null,
        notifyType: null,
        pinnedUntil: null,
        pinnedMessageIds: null
      },
    };
    await eventHelper.emit(event, {
      roleIds: Array.from(eventRoleIds),
      communityIds: Array.from(eventCommunityIds),
    });
    await botHelper.reconcileAllUserBotsInCommunity(data.communityId);
  }

  public async updateChannel(data: API.Community.updateChannel.Request): Promise<void> {
    const [
      oldPermissions,
      communityRoles,
    ] = await Promise.all([
      permissionHelper.getRolePermissions({
        communityId: data.communityId,
        channelId: data.channelId,
      }),
      this.getCommunityRoles(data.communityId),
    ]);

    const communityRoleIds = new Set(communityRoles.map(r => r.id));
    const adminRole = communityRoles.find(r => r.type === RoleType.PREDEFINED && r.title === PredefinedRole.Admin)!;
    const publicRole = communityRoles.find(r => r.type === RoleType.PREDEFINED && r.title === PredefinedRole.Public)!;
    if (!!data.rolePermissions) {
      for (const rolePermission of data.rolePermissions) {
        if (rolePermission.roleId === adminRole.id || !communityRoleIds.has(rolePermission.roleId)) {
          throw new Error(errors.server.NOT_ALLOWED);
        }
      }
      data.rolePermissions.push({
        roleId: adminRole.id,
        roleTitle: PredefinedRole.Admin,
        permissions: rolePermissionPresets.Channel.Admin,
      });
    }

    let result: Awaited<ReturnType<typeof _updateChannel>> | undefined;
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      result = await _updateChannel(client, data);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    // generate event
    let newEventCommunityIds: string[] | undefined;
    const newRoleIds = new Set<string>();
    let updateEventCommunityIds: string[] | undefined;
    const updateRoleIds = new Set<string>();
    let deleteEventCommunityIds: string[] | undefined;
    const deleteRoleIds = new Set<string>();

    let extra: Partial<Models.Community.Channel> | undefined;
    if (!data.rolePermissions) {
      oldPermissions.forEach(p => {
        if (p.permissions.includes(ChannelPermission.CHANNEL_EXISTS)) {
          if (p.id === publicRole.id) {
            updateEventCommunityIds = [data.communityId];
          }
          else {
            updateRoleIds.add(p.id);
          }
        }
      });
    }
    else {
      console.log("NEW PERMISSIONS", data.rolePermissions)
      for (const newPermission of data.rolePermissions) {
        const oldPermission = oldPermissions.find(p => p.id === newPermission.roleId);
        if (
          (
            !oldPermission ||
            !oldPermission.permissions.includes(ChannelPermission.CHANNEL_EXISTS)
          ) && (
            newPermission.permissions.includes('CHANNEL_EXISTS')
          )
        ) {
          if (newPermission.roleId === publicRole.id) {
            newEventCommunityIds = [data.communityId];
          }
          else {
            newRoleIds.add(newPermission.roleId);
          }
        }
        else if (newPermission.permissions.includes('CHANNEL_EXISTS')) {
          if (newPermission.roleId === publicRole.id) {
            updateEventCommunityIds = [data.communityId];
          }
          else {
            updateRoleIds.add(newPermission.roleId);
          }
        }
        else {
          if (newPermission.roleId === publicRole.id) {
            deleteEventCommunityIds = [data.communityId];
          }
          else {
            deleteRoleIds.add(newPermission.roleId);
          }
        }
      }
      for (const oldPermission of oldPermissions) {
        if (!newRoleIds.has(oldPermission.id) && !updateRoleIds.has(oldPermission.id) && !deleteRoleIds.has(oldPermission.id)) {
          if (oldPermission.id === publicRole.id) {
            deleteEventCommunityIds = [data.communityId];
          }
          else {
            deleteRoleIds.add(oldPermission.id);
          }
        }
      }
    }

    if ((deleteRoleIds.size > 0 || !!deleteEventCommunityIds) && !data.rolePermissions?.find(rp => rp.roleId === publicRole.id && rp.permissions.includes('CHANNEL_EXISTS'))) {
      const deleteEvent: Events.Community.Channel = {
        type: "cliChannelEvent",
        action: "delete",
        data: {
          channelId: data.channelId,
          communityId: data.communityId,
        }
      };
      const excludeRoleIds = [...Array.from(newRoleIds), ...Array.from(updateRoleIds)];
      await eventHelper.emit(deleteEvent, {
        roleIds: Array.from(deleteRoleIds),
        communityIds: deleteEventCommunityIds,
      },
        excludeRoleIds.length > 0
          ? { roleIds: excludeRoleIds }
          : undefined,
      );
    }

    const updateEvent: Events.Community.Channel = {
      type: "cliChannelEvent",
      action: "update",
      data: {
        ...data,
        ...extra,
        updatedAt: result.updatedAt,
      },
    };
    const excludeRoleIds = [...Array.from(newRoleIds), ...Array.from(deleteRoleIds)];
    eventHelper.emit(updateEvent, {
      roleIds: Array.from(updateRoleIds),
      communityIds: updateEventCommunityIds,
    },
      excludeRoleIds.length > 0
        ? { roleIds: excludeRoleIds }
        : undefined,
    );

    if (newRoleIds.size > 0 || !!newEventCommunityIds) {
      if (!data.rolePermissions) {
        console.error("newRoleIds cannot be non-empty if no role permissions have changed");
        throw new Error(errors.server.UNKNOWN);
      }
      const channel = await __getCommunityChannelBaseData(pool, data);
      const newEvent: Events.Community.Channel = {
        type: "cliChannelEvent",
        action: "new",
        data: {
          ...channel,
          lastRead: new Date().toISOString(),
          rolePermissions: data.rolePermissions,
          pinType: null,
          notifyType: null,
          pinnedUntil: null,
        }
      };
      const excludeRoleIds = [...Array.from(updateRoleIds), ...Array.from(deleteRoleIds)];
      eventHelper.emit(newEvent, {
        roleIds: Array.from(newRoleIds),
        communityIds: newEventCommunityIds,
      },
        excludeRoleIds.length > 0
          ? { roleIds: excludeRoleIds }
          : undefined,
      );
    }
    await botHelper.reconcileAllUserBotsInCommunity(data.communityId);
  }

  public async deleteChannel(data: API.Community.deleteChannel.Request): Promise<void> {
    let oldRoles = await permissionHelper.getRolePermissions({
      communityId: data.communityId,
      channelId: data.channelId
    });
    await _deleteChannel(pool, data);
    const eventRoleIds = new Set<string>();
    const eventCommunityIds = new Set<string>();
    for (const r of oldRoles) {
      if (r.permissions.includes(ChannelPermission.CHANNEL_EXISTS)) {
        if (r.title === PredefinedRole.Public && r.type === RoleType.PREDEFINED) {
          eventCommunityIds.add(data.communityId);
        } else {
          eventRoleIds.add(r.id);
        }
      }
    }
    const event: Events.Community.Channel = {
      type: "cliChannelEvent",
      action: "delete",
      data,
    };
    await eventHelper.emit(event, {
      roleIds: Array.from(eventRoleIds),
      communityIds: Array.from(eventCommunityIds),
    });
  }

  public async getRole(roleId: string) {
    return await _getRole(pool, roleId);
  }

  public async canClaimGatedRole(userId: string, roleId: string) {
    const result = await pool.query(`
      SELECT
        ruu.claimed
      FROM roles r
      INNER JOIN roles_users_users ruu
        ON  ruu."roleId" = r.id
        AND ruu."userId" = ${format("%L::UUID", userId)}
      WHERE r.id = ${format("%L::UUID", roleId)}
        AND r."deletedAt" IS NULL
    `);
    return result.rows[0]?.claimed === false;
  }

  public async createRole(data: API.Community.createRole.Request): Promise<API.Community.createRole.Response> {
    const client = await pool.connect();
    let result: Awaited<ReturnType<typeof _createRole>>;
    await client.query("BEGIN");
    try {
      // check role limit
      const roleCountResult = await client.query(`
        SELECT count(*)
        FROM roles
        WHERE "communityId" = ${format("%L::UUID", data.communityId)}
          AND "deletedAt" IS NULL
      `);
      const roleCount = parseInt(roleCountResult.rows[0].count);
      let roleLimit: number = config.PREMIUM.COMMUNITY_FREE.ROLE_LIMIT;
      const premiumFeatures = await this._getCommunityPremiumFeatures(client, data.communityId);
      if (premiumFeatures.some(f => f.featureName === CommunityPremiumFeatureName.ENTERPRISE && new Date(f.activeUntil) > new Date())) {
        roleLimit = config.PREMIUM.COMMUNITY_ENTERPRISE.ROLE_LIMIT;
      }
      else if (premiumFeatures.some(f => f.featureName === CommunityPremiumFeatureName.PRO && new Date(f.activeUntil) > new Date())) {
        roleLimit = config.PREMIUM.COMMUNITY_PRO.ROLE_LIMIT;
      }
      else if (premiumFeatures.some(f => f.featureName === CommunityPremiumFeatureName.BASIC && new Date(f.activeUntil) > new Date())) {
        roleLimit = config.PREMIUM.COMMUNITY_BASIC.ROLE_LIMIT;
      }
      if (roleCount >= roleLimit + 3) { // +3 for predefined roles
        throw new Error(errors.server.ROLE_LIMIT_EXCEEDED);
      }

      // check potential community token
      const { assignmentRules } = data;
      if (!!assignmentRules && assignmentRules.type === "token") {
        const communityTokens = await _getCommunityTokens(client, data.communityId);
        const { rules } = assignmentRules;
        if (
          !communityTokens.find(t => t.contractId === rules.rule1.contractId) ||
          ('rule2' in rules && !communityTokens.find(t => t.contractId === rules.rule2.contractId))
        ) {
          throw new Error(errors.server.NO_COMMUNITY_TOKEN);
        }
      }

      result = await _createRole(client, data);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    const event: Events.Community.Role = {
      type: "cliRoleEvent",
      action: "new",
      data: {
        ...data,
        ...result,
        airdropConfig: null,
      },
    };
    await eventHelper.emit(event, {
      communityIds: [data.communityId],
    });

    return { id: result.id };
  }

  public async updateRole(data: API.Community.updateRole.Request): Promise<void> {
    const client = await pool.connect();
    let result: Awaited<ReturnType<typeof _updateRole>>;
    await client.query("BEGIN");
    try {
      // check potential community token
      const { assignmentRules } = data;
      if (!!assignmentRules && assignmentRules.type === "token") {
        const communityTokens = await _getCommunityTokens(client, data.communityId);
        const { rules } = assignmentRules;
        if (
          !communityTokens.find(t => t.contractId === rules.rule1.contractId) ||
          ('rule2' in rules && !communityTokens.find(t => t.contractId === rules.rule2.contractId))
        ) {
          throw new Error(errors.server.NO_COMMUNITY_TOKEN);
        }
      }

      result = await _updateRole(client, data);
      await client.query("COMMIT");
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    const event: Events.Community.Role = {
      type: "cliRoleEvent",
      action: "update",
      data: {
        ...data,
        ...result,
      },
    };
    await eventHelper.emit(event, {
      communityIds: [data.communityId],
    });
    await botHelper.reconcileAllUserBotsInCommunity(data.communityId);
  }

  public async deleteRole(data: API.Community.deleteRole.Request): Promise<void> {
    await _deleteRole(pool, data);
    const event: Events.Community.Role = {
      type: "cliRoleEvent",
      action: "delete",
      data,
    };
    await eventHelper.emit(event, {
      communityIds: [data.communityId],
    });
  }

  public async addUserToRoles(data: API.Community.addUserToRoles.Request): Promise<void> {
    await botHelper.guardGenericRoleAssignment(data.userId, data.communityId, data.roleIds);
    const client = await pool.connect();
    let success = false;
    let result: Awaited<ReturnType<typeof _addUserToRoles>>;
    await client.query("BEGIN");
    try {
      result = await _addUserToRoles(client, data);
      if (result.createdUserRoles.length !== data.roleIds.length) {
        throw new Error("Unexpected number of roles assigned. "
          + "The operation either tried to assign the Member role, "
          + "or the roleIds didn't match with the communityId.");
      }
      await client.query("COMMIT");
      success = true;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    if (success && result) {
      const roleIds = result.createdUserRoles.map(d => d.roleId);
      eventHelper.userJoinRooms(data.userId, { roleIds });
      const detailView = await this.getCommunityDetailView({ id: data.communityId }, data.userId);
      eventHelper.emit({
        type: "cliMembershipEvent",
        action: "roles_added",
        data: {
          communityId: data.communityId,
          userId: data.userId,
          roleIds,
        },
      }, {
        communityIds: [data.communityId],
      });
      const event: Events.Community.Community = {
        type: "cliCommunityEvent",
        action: "new-or-full-update",
        data: detailView,
      };
      await eventHelper.emit(event, {
        userIds: [data.userId],
      });
      await botHelper.reconcileUserBotsForOwner(data.userId, data.communityId);
    }
  }

  public async giveUserUnclaimedRoles(userId: string, roleIds: string[]): Promise<number> {
    const result = await pool.query(`
      WITH role_id_query AS (
        SELECT
          ${format("%L", userId)}::UUID AS "userId",
          id AS "roleId",
          FALSE AS "claimed"
        FROM roles
        WHERE id = ANY(ARRAY[${format("%L", roleIds)}]::UUID[])
      )
      INSERT INTO roles_users_users ("userId", "roleId", "claimed")
      SELECT "userId", "roleId", "claimed"
      FROM role_id_query
      ON CONFLICT ("userId", "roleId") DO NOTHING
    `);
    return result.rowCount;
  }

  public async removeUserFromUnclaimableRoles(userId: string, roleIds: string[]): Promise<void> {
    if (roleIds.length === 0) {
      return;
    }
    // get roles with communityId, then use removeUserFromRoles
    const result = await pool.query<{ roleId: string, communityId: string }>(`
      WITH delete_unclaimed_roles AS (
        DELETE FROM roles_users_users
        WHERE "userId" = ${format("%L", userId)}
          AND "roleId" = ANY(ARRAY[${format("%L", roleIds)}]::UUID[])
          AND claimed = FALSE
        RETURNING "roleId"
      )
      SELECT
        r."id" AS "roleId",
        r."communityId" AS "communityId"
      FROM roles r
      INNER JOIN roles_users_users ruu
        ON  r.id = ruu."roleId"
      WHERE r."id" = ANY(ARRAY[${format("%L", roleIds)}]::UUID[])
        AND ruu."userId" = ${format("%L", userId)}
        AND ruu.claimed = TRUE
    `);
    const rolesByCommunity = new Map<string, string[]>();
    for (const row of result.rows) {
      if (!rolesByCommunity.has(row.communityId)) {
        rolesByCommunity.set(row.communityId, []);
      }
      rolesByCommunity.get(row.communityId)!.push(row.roleId);
    }
    for (const communityId of rolesByCommunity.keys()) {
      await this.removeUserFromRoles({
        userId,
        communityId,
        roleIds: rolesByCommunity.get(communityId)!,
      });
    }
  }

  public async removeUserFromRoles(data: API.Community.removeUserFromRoles.Request): Promise<void> {
    await botHelper.guardGenericRoleRemoval(data.userId, data.communityId);
    const client = await pool.connect();
    let success = false;
    let result: Awaited<ReturnType<typeof _removeUserFromRoles>>;
    await client.query("BEGIN");
    try {
      result = await _removeUserFromRoles(client, data);
      if (result.deletedUserRoles.length !== data.roleIds.length) {
        throw new Error("Unexpected number of roles unassigned. "
          + "The operation either tried to unassign the Member role, "
          + "or the roleIds didn't match with the communityId.");
      }
      await client.query("COMMIT");
      success = true;
    } catch (e) {
      await client.query("ROLLBACK");
      throw e;
    } finally {
      client.release();
    }
    if (success && result) {
      const roleIds = result.deletedUserRoles.map(d => d.roleId);
      await eventHelper.userLeaveRooms(data.userId, { roleIds });
      const detailView = await this.getCommunityDetailView({ id: data.communityId }, data.userId);
      eventHelper.emit({
        type: "cliMembershipEvent",
        action: "roles_removed",
        data: {
          communityId: data.communityId,
          userId: data.userId,
          roleIds,
        },
      }, {
        communityIds: [data.communityId],
      });
      const event: Events.Community.Community = {
        type: "cliCommunityEvent",
        action: "new-or-full-update",
        data: detailView,
      };
      await eventHelper.emit(event, {
        userIds: [data.userId],
      });
      await botHelper.reconcileUserBotsForOwner(data.userId, data.communityId);
    }
  }

  public async addCommunityToken(data: API.Community.addCommunityToken.Request): Promise<void> {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const premiumFeatures = await this._getCommunityPremiumFeatures(client, data.communityId);
      let tokenLimit: number = config.PREMIUM.COMMUNITY_FREE.TOKEN_LIMIT;
      if (premiumFeatures.some(f => f.featureName === CommunityPremiumFeatureName.ENTERPRISE && new Date(f.activeUntil) > new Date())) {
        tokenLimit = config.PREMIUM.COMMUNITY_ENTERPRISE.TOKEN_LIMIT;
      }
      else if (premiumFeatures.some(f => f.featureName === CommunityPremiumFeatureName.PRO && new Date(f.activeUntil) > new Date())) {
        tokenLimit = config.PREMIUM.COMMUNITY_PRO.TOKEN_LIMIT;
      }
      else if (premiumFeatures.some(f => f.featureName === CommunityPremiumFeatureName.BASIC && new Date(f.activeUntil) > new Date())) {
        tokenLimit = config.PREMIUM.COMMUNITY_BASIC.TOKEN_LIMIT;
      }
      const existingTokens = await _getCommunityTokens(client, data.communityId);
      if (existingTokens.filter(r => r.active === true).length >= tokenLimit) {
        throw new Error(errors.server.LIMIT_EXCEEDED);
      }
      const newOrder = existingTokens.reduce((agg, r) => Math.max(agg, r.order), 0) + 1000;
      const tokenData = await client.query<{
        updatedAt: string;
        tokens: {
          communityId: string;
          contractId: string;
          order: number;
        }[]
      }>(`
        WITH insert_result AS (
          INSERT INTO communities_tokens ("communityId", "contractId", "order")
          VALUES ($1, $2, $3)
        ),
        update_result AS (
          UPDATE communities
          SET "updatedAt" = now()
          WHERE id = $1
        )
        SELECT
          now() AS "updatedAt",
          coalesce(json_agg(json_build_object(
            'communityId', "communityId",
            'contractId', "contractId",
            'order', "order"
          )), '[]'::json) AS "tokens"
        FROM communities_tokens
        WHERE "communityId" = $1
          AND active = TRUE
      `, [
        data.communityId,
        data.contractId,
        newOrder,
      ]);

      const event: Events.Community.Community = {
        type: "cliCommunityEvent",
        action: "update",
        data: {
          id: data.communityId,
          tokens: [...tokenData.rows[0].tokens, {
            communityId: data.communityId,
            contractId: data.contractId,
            order: newOrder,
          }],
          updatedAt: tokenData.rows[0].updatedAt,
        },
      };
      await eventHelper.emit(event, {
        communityIds: [data.communityId],
      });

      await client.query("COMMIT");
    }
    catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
    finally {
      client.release();
    }
  }

  public async removeCommunityToken(data: API.Community.removeCommunityToken.Request): Promise<void> {
    const client = await pool.connect();
    await client.query("BEGIN");
    try {
      const communityRoles = await client.query<{
        id: string;
        assignmentRules: Models.Community.AssignmentRules;
      }>(`
        SELECT id, "assignmentRules"
        FROM roles
        WHERE "communityId" = $1
          AND "assignmentRules" IS NOT NULL
          AND "type" = ${format('%L::"public"."roles_type_enum"', RoleType.CUSTOM_AUTO_ASSIGN)}
          AND "deletedAt" IS NULL
      `, [data.communityId]);

      const manualAssignRoleIds: string[] = [];
      for (const role of communityRoles.rows) {
        const { assignmentRules } = role;
        if (assignmentRules.type === 'token') {
          if (
            assignmentRules.rules.rule1.contractId === data.contractId ||
            ('rule2' in assignmentRules.rules && assignmentRules.rules.rule2.contractId === data.contractId)
          ) {
            manualAssignRoleIds.push(role.id);
          }
        }
      }

      let cte = 'WITH ';
      if (manualAssignRoleIds.length > 0) {
        cte = `
          WITH role_update AS (
            UPDATE roles
            SET
              "assignmentRules" = NULL,
              "type" = ${format('%L::"public"."roles_type_enum"', RoleType.CUSTOM_MANUAL_ASSIGN)},
              "updatedAt" = now()
            WHERE id = ANY(ARRAY[${format('%L', manualAssignRoleIds)}]::UUID[])
          ),
        `;
      }

      const result = await client.query<{
        tokens: {
          communityId: string;
          contractId: string;
          order: number;
        }[];
        updatedAt: string;
      }>(`
        ${cte}
        delete_tokens AS (
          DELETE FROM communities_tokens
          WHERE "communityId" = $1
            AND "contractId" = $2
        ),
        update_community AS (
          UPDATE communities
          SET "updatedAt" = now()
          WHERE id = $1
        )
        SELECT
          coalesce(json_agg(json_build_object(
            'communityId', "communityId",
            'contractId', "contractId",
            'order', "order"
          )), '[]'::json) AS "tokens",
          now() AS "updatedAt"
        FROM communities_tokens
        WHERE "communityId" = $1
      `, [data.communityId, data.contractId]);

      const tokens = result.rows[0].tokens.filter(t => t.contractId !== data.contractId);
      const event: Events.Community.Community = {
        type: "cliCommunityEvent",
        action: "update",
        data: {
          id: data.communityId,
          tokens,
          updatedAt: result.rows[0].updatedAt,
        },
      };
      eventHelper.emit(event, {
        communityIds: [data.communityId],
      });
      for (const role of manualAssignRoleIds) {
        const event: Events.Community.Role = {
          type: "cliRoleEvent",
          action: "update",
          data: {
            id: role,
            communityId: data.communityId,
            assignmentRules: null,
            type: RoleType.CUSTOM_MANUAL_ASSIGN,
            updatedAt: result.rows[0].updatedAt,
          },
        };
        eventHelper.emit(event, {
          communityIds: [data.communityId],
        });
      }

      await client.query("COMMIT");
    }
    catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
    finally {
      client.release();
    }
  }

  public async givePointsToCommunity(userId: string, data: API.Community.givePointsToCommunity.Request) {
    const amount = Number(data.amount).toString();
    const transactionData: Models.Premium.TransactionData = {
      type: 'user-donate-community',
    };
    const queryResult = await pool.query<{
      data: {
        userPointBalance: number | null;
        communityPointBalance: number | null;
        updatedAt: string | null;
      };
    }>(`
      WITH sufficient_balance AS (
        SELECT 1
        FROM users
        WHERE id = $1
          AND "pointBalance" >= $3
      ), update_user AS (
        UPDATE users
        SET
          "pointBalance" = "pointBalance" - $3,
          "updatedAt" = now()
        WHERE id = $1
          AND EXISTS(SELECT 1 FROM sufficient_balance)
        RETURNING "pointBalance"
      ), update_community AS (
        UPDATE communities
        SET
          "pointBalance" = "pointBalance" + $3,
          "updatedAt" = now()
        WHERE id = $2
          AND EXISTS(SELECT 1 FROM sufficient_balance)
        RETURNING "pointBalance", "updatedAt"
      ), insert_transaction AS (
        INSERT INTO point_transactions ("userId", "communityId", "data", "amount")
        SELECT $1::uuid, $2::uuid, $4::jsonb, $3
        WHERE EXISTS (SELECT 1 FROM sufficient_balance)
      )
      SELECT json_build_object(
        'userPointBalance', (SELECT "pointBalance" FROM update_user),
        'communityPointBalance', (SELECT "pointBalance" FROM update_community),
        'updatedAt', (SELECT "updatedAt" FROM update_community)
      ) AS data
    `, [userId, data.communityId, amount, JSON.stringify(transactionData)]);
    const result = queryResult.rows[0];
    if (
      result.data.communityPointBalance !== null &&
      result.data.userPointBalance !== null &&
      result.data.updatedAt !== null
    ) {
      const communityEvent: Events.Community.Community = {
        type: 'cliCommunityEvent',
        action: 'update',
        data: {
          id: data.communityId,
          updatedAt: result.data.updatedAt,
          pointBalance: result.data.communityPointBalance,
        },
      };
      const userEvent: Events.User.OwnData = {
        type: 'cliUserOwnData',
        data: {
          updatedAt: result.data.updatedAt,
          pointBalance: result.data.userPointBalance,
        },
      };
      eventHelper.emit(communityEvent, {
        communityIds: [data.communityId],
      });
      eventHelper.emit(userEvent, {
        userIds: [userId],
      });
    }
    else {
      throw new Error(errors.server.INSUFFICIENT_BALANCE);
    }
  }

  public async _getCommunityPremiumFeatures(db: Pool | PoolClient, communityId: string) {
    const result = await db.query<{
      featureName: CommunityPremiumFeatureName;
      activeUntil: string;
      autoRenew: Common.PremiumRenewal | null;
    }>(`
      SELECT
        "featureName",
        "activeUntil",
        "autoRenew"
      FROM communities_premium
      WHERE "communityId" = $1
    `, [communityId]);
    return result.rows;
  }

  private async _upsertOrReplacePremiumFeature(db: Pool | PoolClient, options: {
    type: 'replace';
    communityId: string;
    price: number;
    featureName: Models.Community.PremiumName;
    replacedFeatureName: Models.Community.PremiumName;
    userId: string;
  } | {
    type: 'upsert';
    communityId: string;
    price: number;
    featureName: Models.Community.PremiumName;
    duration: 'month' | 'year';
    userId: string;
  }) {
    const { userId, communityId, featureName, price } = options;
    const transactionData: Models.Premium.TransactionData = {
      type: 'community-spend',
      featureName,
      triggeredBy: "MANUAL",
    }
    const CTEs: string[] = [`
      WITH update_community AS (
        UPDATE communities
        SET
          "pointBalance" = "pointBalance" - ${format("%s", Number(price))},
          "updatedAt" = now()
        WHERE id = ${format("%L", communityId)}::uuid
          AND "pointBalance" >= ${format("%s", Number(price))}
        RETURNING "pointBalance", "updatedAt"
      ), insert_transaction AS (
        INSERT INTO point_transactions ("userId", "communityId", "data", "amount")
        SELECT
          ${format("%L", userId)}::uuid AS "userId",
          ${format("%L", communityId)}::uuid AS "communityId",
          ${format("%L", JSON.stringify(transactionData))}::jsonb AS "data",
          ${format("%s", Number(price))}
        WHERE EXISTS (SELECT 1 FROM update_community)
      )
    `];
    if (options.type === 'replace') {
      CTEs.push(`
        delete_lower_tier AS (
          DELETE FROM communities_premium
          WHERE "communityId" = ${format("%L", communityId)}::uuid
            AND "featureName" = ${format("%L", options.replacedFeatureName)}::"public"."communities_premium_featurename_enum"
            AND EXISTS (SELECT 1 FROM update_community)
          RETURNING "activeUntil", "autoRenew"
        ),
        insert_value_select AS (
          SELECT
            ${format("%L", communityId)}::uuid AS "communityId",
            ${format("%L", featureName)}::"public"."communities_premium_featurename_enum" AS "featureName",
            (SELECT "activeUntil" FROM delete_lower_tier) AS "activeUntil",
            (SELECT "autoRenew" FROM delete_lower_tier) AS "autoRenew"
          WHERE EXISTS(SELECT 1 FROM delete_lower_tier)
        )
      `);
    }
    else if (options.type === 'upsert') {
      CTEs.push(`
        insert_value_select AS (
          SELECT
            ${format("%L", communityId)}::uuid AS "communityId",
            ${format("%L", featureName)}::"public"."communities_premium_featurename_enum" AS "featureName",
            now() + interval '${options.duration === 'year' ? '365' : '30'} days' AS "activeUntil",
            '${options.duration === 'year' ? PremiumRenewal.YEAR : PremiumRenewal.MONTH}'::"public"."communities_premium_autorenew_enum" AS "autoRenew"
          WHERE EXISTS (SELECT 1 FROM update_community)
        )
      `);
    }

    const result = await db.query<{
      data: {
        pointBalance: number;
        updatedAt: string;
      }
    }>(`
      ${CTEs.join(',')},
      insert_premium AS (
        INSERT INTO communities_premium ("communityId", "featureName", "activeUntil", "autoRenew")
        SELECT "communityId", "featureName", "activeUntil", "autoRenew"
        FROM insert_value_select
        ON CONFLICT ("communityId", "featureName")
        DO UPDATE SET
          "activeUntil" = excluded."activeUntil",
          "autoRenew" = excluded."autoRenew"
      )
      SELECT json_build_object(
        'pointBalance', (SELECT "pointBalance" FROM update_community),
        'updatedAt', (SELECT "updatedAt" FROM update_community)
      ) AS data
    `);
    if (result.rows.length === 1) {
      const { data } = result.rows[0];
      if (!!data && data.pointBalance !== null && data.updatedAt !== null) {
        return data;
      }
    }
    throw new Error(errors.server.INSUFFICIENT_BALANCE);
  }

  public async buyCommunityPremiumFeature(userId: string, data: API.Community.buyCommunityPremiumFeature.Request) {
    const { communityId, featureName } = data;
    let price = 0;
    let result: Awaited<ReturnType<typeof this._upsertOrReplacePremiumFeature>> | undefined;
    const currentFeatures = await this._getCommunityPremiumFeatures(pool, communityId);
    const now = new Date();

    if (currentFeatures.some(d => d.featureName === featureName && new Date(d.activeUntil) > now)) {
      throw new Error(errors.server.INVALID_REQUEST);
    }

    if (featureName === 'URL_CHANGE') {
      price = config.PREMIUM.URL_CHANGE.ONETIME_PRICE;
      const transactionData: Models.Premium.TransactionData = {
        type: 'community-spend',
        featureName: 'URL_CHANGE',
        triggeredBy: "MANUAL",
      };
      const query = `
        WITH update_community AS (
          UPDATE communities
          SET
            "pointBalance" = "pointBalance" - ${format("%s", Number(price))},
            "updatedAt" = now(),
            "url" = ${format("%L", data.url)}
          WHERE id = ${format("%L", communityId)}::uuid
            AND "pointBalance" >= ${format("%s", Number(price))}
            AND "url" <> ${format("%L", data.url)}
          RETURNING "pointBalance", "updatedAt"
        ), insert_transaction AS (
          INSERT INTO point_transactions ("userId", "communityId", "data", "amount")
          SELECT
            ${format("%L", userId)}::uuid AS "userId",
            ${format("%L", communityId)}::uuid AS "communityId",
            ${format("%L", JSON.stringify(transactionData))}::jsonb AS "data",
            ${format("%s", Number(price))}
          WHERE EXISTS(SELECT 1 FROM update_community)
        )
        SELECT "pointBalance", "updatedAt"
        FROM update_community
      `;
      const updateResult = await pool.query<{
        pointBalance: number;
        updatedAt: string;
      }>(query);
      if (updateResult.rows.length === 1) {
        result = updateResult.rows[0];
      }
      else {
        throw new Error(errors.server.INSUFFICIENT_BALANCE);
      }
    }
    else {
      const { duration } = data;
      if (duration === 'upgrade') {
        let currentFeature: Models.Community.Premium | undefined;
        switch (featureName) {
          case CommunityPremiumFeatureName.PRO:
            currentFeature = currentFeatures.find(f => f.featureName === 'BASIC' && new Date(f.activeUntil) > now);
            break;

          case CommunityPremiumFeatureName.ENTERPRISE:
            currentFeature = currentFeatures.find(f => (f.featureName === 'PRO' || f.featureName === 'BASIC') && new Date(f.activeUntil) > now);
            break;
        }
        if (!currentFeature) {
          throw new Error(errors.server.INVALID_REQUEST);
        }
        const price = calculateCommunityUpgradeCost(currentFeature, featureName, true);
        result = await this._upsertOrReplacePremiumFeature(pool, {
          type: 'replace',
          price,
          communityId,
          featureName,
          replacedFeatureName: currentFeature.featureName,
          userId,
        });
      }
      else if (duration === 'month' || duration === 'year') {
        // if the community already has a premium feature, they cannot buy another one but need to upgrade
        if (currentFeatures.some(f => ((f.featureName === 'BASIC' || f.featureName === 'PRO' || f.featureName === 'ENTERPRISE') && new Date(f.activeUntil) > now))) {
          throw new Error(errors.server.INVALID_REQUEST);
        }
        switch (featureName) {
          case CommunityPremiumFeatureName.BASIC:
            price = config.PREMIUM.COMMUNITY_BASIC.MONTHLY_PRICE;
            break;

          case CommunityPremiumFeatureName.PRO:
            price = config.PREMIUM.COMMUNITY_PRO.MONTHLY_PRICE;
            break;

          case CommunityPremiumFeatureName.ENTERPRISE:
            price = config.PREMIUM.COMMUNITY_ENTERPRISE.MONTHLY_PRICE;
            break;

          default:
            throw new Error(errors.server.INVALID_REQUEST);
        }
        if (duration === 'year') {
          price = Math.round(price * 12 * ((100 - config.PREMIUM.YEARLY_DISCOUNT_PERCENT) / 100));
        }
        result = await this._upsertOrReplacePremiumFeature(pool, {
          type: 'upsert',
          price,
          communityId,
          featureName,
          duration,
          userId,
        });
      }
    }

    if (!result) {
      throw new Error(errors.server.INVALID_REQUEST);
    }

    const { pointBalance, updatedAt } = result;
    const eventData: Events.Community.Community["data"] = {
      id: communityId,
      updatedAt,
      pointBalance,
    };

    if (data.featureName === 'URL_CHANGE') {
      eventData.url = data.url;
    }
    else if (featureName === 'BASIC' || featureName === 'PRO' || featureName === 'ENTERPRISE') {
      const premiumFeatures = await this._getCommunityPremiumFeatures(pool, communityId);
      const toDelete = premiumFeatures.filter(f => f.featureName !== featureName && (f.featureName === 'BASIC' || f.featureName === 'PRO' || f.featureName === 'ENTERPRISE'));
      if (toDelete.length > 0) {
        await pool.query(`
          DELETE FROM communities_premium
          WHERE "communityId" = ${format("%L", communityId)}::uuid
            AND "featureName" = ANY(ARRAY[${format("%L", toDelete.map(f => f.featureName))}]::"public"."communities_premium_featurename_enum"[])
        `);
      }
      const premium = premiumFeatures.find(f => f.featureName === featureName);
      if (!!premium) {
        eventData.premium = premium;
      }
      else {
        console.error(`Community ${data.communityId}: Premium feature ${featureName} not found after buy / upgrade`, premiumFeatures);
      }
    }
    const event: Events.Community.Community = {
      type: 'cliCommunityEvent',
      action: 'update',
      data: eventData,
    };
    eventHelper.emit(event, {
      communityIds: [communityId],
    });
  }

  public async setPremiumFeatureAutoRenew(requestData: API.Community.setPremiumFeatureAutoRenew.Request) {
    const { communityId, featureName, autoRenew } = requestData;
    const currentFeatures = await this._getCommunityPremiumFeatures(pool, communityId);
    const activeFeature = currentFeatures.find(f => f.featureName === featureName && new Date(f.activeUntil) > new Date());
    if (!activeFeature) {
      throw new Error(errors.server.INVALID_REQUEST);
    }
    const result = await pool.query<{
      data: {
        updatedAt: string | null;
      }
    }>(`
      WITH update_feature AS (
        UPDATE communities_premium
        SET "autoRenew" = ${autoRenew === null ? 'NULL' : format('%L::"public"."communities_premium_autorenew_enum"', autoRenew)}
        WHERE "communityId" = ${format("%L::uuid", communityId)}
          AND "featureName" = ${format("%L", featureName)}::"public"."communities_premium_featurename_enum"
        RETURNING "autoRenew"
      ),
      update_community AS (
        UPDATE communities
        SET "updatedAt" = now()
        WHERE id = ${format("%L::uuid", communityId)}
          AND EXISTS (SELECT 1 FROM update_feature)
        RETURNING "updatedAt"
      )
      SELECT json_build_object(
        'updatedAt', (SELECT "updatedAt" FROM update_community)
      ) AS data
    `);
    activeFeature.autoRenew = autoRenew;
    const { data } = result.rows[0];
    if (!!data && data.updatedAt !== null) {
      const event: Events.Community.Community = {
        type: 'cliCommunityEvent',
        action: 'update',
        data: {
          id: communityId,
          updatedAt: data.updatedAt,
          premium: activeFeature,
        },
      };
      eventHelper.emit(event, {
        communityIds: [communityId],
      });
    }
    else {
      throw new Error(errors.server.INVALID_REQUEST);
    }
  }

  public async getUserBlockState(
    userId: string,
    communityId: string
  ): Promise<Models.Community.UserBlockState | null> {
    const result = await pool.query(`
      SELECT "blockState" FROM user_community_state
      WHERE "userId" = $1
        AND "communityId" = $2
        AND ("blockStateUntil" > NOW() OR "blockStateUntil" IS NULL)
    `, [userId, communityId]);
    return result.rows[0]?.blockState || null;
  }

  public async getCommunityOnboardingOptions(communityId: string): Promise<Models.Community.OnboardingOptions | undefined> {
    const result = await pool.query<Pick<Models.Community.DetailView, 'onboardingOptions'>>(`
      SELECT "onboardingOptions" FROM communities
      WHERE "id" = $1
    `, [communityId]);
    if (result.rows.length === 1) {
      return result.rows[0].onboardingOptions;
    }
    throw new Error(errors.server.NOT_ALLOWED);
  }

  public async getCommunityRoles(communityId: string, db?: PoolClient) {
    return await _getCommunityRoles(db || pool, communityId);
  }

  public async getUserRoleRelationships({ communityId, userId }: { communityId: string, userId: string }) {
    const result = await pool.query(`
      SELECT "roleId", "claimed"
      FROM roles_users_users ruu
      INNER JOIN roles r
        ON r.id = ruu."roleId"
        AND r."deletedAt" IS NULL
      WHERE ruu."userId" = $2
        AND r."communityId" = $1
    `, [communityId, userId]);
    return result.rows as {
      roleId: string;
      claimed: boolean;
    }[];
  }

  public async isCommunityMember(userId: string, communityId: string) {
    const result = await pool.query(`
      SELECT 1
      FROM roles_users_users ruu
      INNER JOIN roles r
        ON r.id = ruu."roleId"
      WHERE
        r.title = '${PredefinedRole.Member}' AND
        r."type" = '${RoleType.PREDEFINED}' AND
        r."communityId" = $1 AND
        ruu."userId" = $2
    `, [communityId, userId]);
    return result.rows.length === 1;
  }

  public async getCommunitySocialPreview(
    options: { communityId: string } | { communityUrl: string }
  ) {
    return await _getCommunitySocialPreview(pool, options);
  }

  public async getWizardDataForSocialPreview(wizardId: string) {
    const wizardData = await pool.query<{
      socialPreviewDescription: string;
      isPublic: boolean;
    }>(`
      SELECT
        w."data"->>'socialPreviewDescription' AS "socialPreviewDescription",
        (r."title" = ${format("%L", PredefinedRole.Public)} AND r."type" = ${format('%L::"public"."roles_type_enum"', RoleType.PREDEFINED)}) as "isPublic"
      FROM wizards w
      INNER JOIN wizard_role_permission wrp
        ON wrp."wizardId" = w.id
      INNER JOIN roles r
        ON wrp."roleId" = r.id
        AND w."communityId" = r."communityId"
      WHERE w.id = $1
    `, [wizardId]);
    if (wizardData.rows.length === 1) {
      return wizardData.rows[0];
    }
    return undefined;
  }

  #sitemapFile = "__sitemapCache.xml";
  #sitemapStaleAfter = 30 * 60 * 1000; // 15m
  public async getSitemap() {
    const statAsync = promisify(fs.stat);
    const writeFileAsync = promisify(fs.writeFile);
    const readFileAsync = promisify(fs.readFile);
    const pages: {
      title: string;
      created: string;
      lastModified: string;
      relativeUrl: string;
    }[] = [];
    try {
      const { mtime } = await statAsync(this.#sitemapFile);
      if (mtime > new Date(Date.now() - this.#sitemapStaleAfter)) {
        const data = await readFileAsync(this.#sitemapFile);
        return data.toString('utf-8');
      }
    }
    catch (e) { }

    let latestPublicArticleDate: Date = new Date("2023-01-01");

    const verifiedCommunitiesResult = await pool.query(`
      SELECT
        c.id,
        c.url,
        c.title,
        c."createdAt",
        c."updatedAt",
        COALESCE((
          SELECT array_to_json(array_agg(json_build_object(
            'articleId', ca."articleId",
            'published', ca."published",
            'updatedAt', ca."updatedAt",
            'title', a."title"
          )))
          FROM communities_articles ca
          INNER JOIN communities_articles_roles_permissions carp
            ON ca."communityId" = carp."communityId"
              AND ca."articleId" = carp."articleId"
          INNER JOIN roles r
            ON carp."roleId" = r."id"
          INNER JOIN articles a
            ON carp."articleId" = a."id"

          WHERE r."title" = ${format("%L", PredefinedRole.Public)}
            AND r."type" = ${format('%L::"public"."roles_type_enum"', RoleType.PREDEFINED)}
            AND ca."communityId" = c.id
            AND ca."deletedAt" IS NULL
            AND carp."permissions" @> ${format(
      'ARRAY[%L]::"public"."communities_articles_roles_permissions_permissions_enum"[]',
      [ArticlePermission.ARTICLE_PREVIEW, ArticlePermission.ARTICLE_READ]
    )}
            AND ca."published" < now()
        ), '[]'::JSON) AS "articles"
      FROM communities c
      INNER JOIN LATERAL (
        SELECT "communityId"
        FROM communities_premium
        WHERE "featureName" = ANY(ARRAY[${format("%L", [CommunityPremiumFeatureName.BASIC, CommunityPremiumFeatureName.PRO, CommunityPremiumFeatureName.ENTERPRISE])}]::"public"."communities_premium_featurename_enum"[])
          AND "activeUntil" > now()
          AND "communityId" = c."id"
        ORDER BY "activeUntil" DESC
        LIMIT 1
      ) cp ON TRUE
    `);

    const verifiedCommunities = verifiedCommunitiesResult.rows as {
      id: string;
      url: string;
      title: string;
      createdAt: string;
      updatedAt: string;
      articles: {
        articleId: string;
        published: string;
        updatedAt: string;
        title: string;
      }[];
    }[];
    verifiedCommunities.forEach(c => {
      pages.push({
        title: c.title,
        created: new Date(c.createdAt).toISOString().split("T")[0],
        lastModified: new Date(c.updatedAt).toISOString().split("T")[0],
        relativeUrl: getUrl({
          type: "community-lobby",
          community: {
            url: c.url,
          },
        })
      });
      for (const a of c.articles) {
        const publishedDate = new Date(a.published);
        if (!latestPublicArticleDate || latestPublicArticleDate < publishedDate) {
          latestPublicArticleDate = publishedDate;
        }
        pages.push({
          title: a.title,
          created: new Date(a.published).toISOString().split("T")[0],
          lastModified: new Date(a.updatedAt).toISOString(),
          relativeUrl: getUrl({
            type: "community-article",
            community: {
              url: c.url,
            },
            article: {
              articleId: a.articleId,
              title: a.title,
            },
          })
        });
      }
    });

    pages.unshift({
      title: "Common Ground",
      created: "2023-01-01",
      lastModified: latestPublicArticleDate.toISOString(),
      relativeUrl: "/"
    });

    console.log(`${pages.length} Pages in sitemap.xml`);

    const sitemapItems = pages.reduce(function (
      items: {
        url: [{ loc: string }, { lastmod: string }]
      }[],
      item: typeof pages[0],
    ) {
      // build page items
      items.push({
        url: [
          {
            loc: `${urls.APP_URL}${item.relativeUrl}`,
          },
          {
            lastmod: item.lastModified,
          },
        ],
      });
      return items;
    }, []);

    const sitemapObject = {
      urlset: [
        {
          _attr: {
            xmlns: "http://www.sitemaps.org/schemas/sitemap/0.9",
          },
        },
        ...sitemapItems,
      ],
    };

    const sitemap = `<?xml version="1.0" encoding="UTF-8"?>${xml(sitemapObject)}`;
    await writeFileAsync(this.#sitemapFile, sitemap, "utf-8");
    return sitemap;
  }

  public async getTagFrequencyData() {
    return await _getTagFrequencyData(pool);
  }

  public async setChannelPinState({ userId, channelId, communityId, pinnedUntil, pinType, notifyType }: API.Community.setChannelPinState.Request & {
    userId: string;
  }) {
    const onConflictUpdates: string[] = ['"updatedAt" = now()'];
    if (pinType !== undefined) {
      onConflictUpdates.push('"pinType" = EXCLUDED."pinType"');
    }
    if (notifyType !== undefined) {
      onConflictUpdates.push('"notifyType" = EXCLUDED."notifyType"');
    }
    if (pinnedUntil !== undefined) {
      onConflictUpdates.push('"pinnedUntil" = EXCLUDED."pinnedUntil"');
    }

    const query = `
        INSERT INTO user_channel_settings (
          "userId",
          "communityId",
          "channelId",
          "pinType",
          "notifyType",
          "pinnedUntil"
        )
        VALUES (
          $1::uuid,
          $2::uuid,
          $3::uuid,
          $4::"public"."user_channel_settings_pintype_enum",
          $5::"public"."user_channel_settings_notifytype_enum",
          $6::timestamptz
        )
        ON CONFLICT ("userId", "communityId", "channelId")
        DO UPDATE SET
          ${onConflictUpdates.join(',')}
      `;
    const params = [
      userId,
      communityId,
      channelId,
      pinType !== undefined ? pinType : ChannelPinTypeEnum.AUTOPIN,
      notifyType !== undefined ? notifyType : ChannelNotificationTypeEnum.WHILE_PINNED,
      pinnedUntil || null,
    ] as any[];
    const result = await pool.query(query, params);
  }

  public async getCommunityChannelRolePermissions(communityId: string, channelId: string) {
    const query = `
      SELECT
        ccrp."permissions",
        r."title" AS "roleTitle",
        r."id" AS "roleId",
        r."type" AS "roleType"
      FROM communities_channels_roles_permissions ccrp
      INNER JOIN roles r
        ON r."id" = ccrp."roleId"
        AND r."deletedAt" IS NULL
      WHERE ccrp."channelId" = $1
        AND ccrp."communityId" = $2
    `;
    const result = await pool.query(query, [
      channelId,
      communityId,
    ]);
    return result.rows as {
      permissions: Common.ChannelPermission[];
      roleTitle: string;
      roleId: string;
      type: Models.Community.Role["type"],
    }[];
  }

  public async getCall(data: API.Community.getCall.Request) {
    const query = `
      SELECT 
        c.id,
        c."channelId",
        c."startedAt",
        c."updatedAt",
        c."callType",
        c."callCreator",
        c.slots,
        c."stageSlots",
        c."audioOnly",
        c."highQuality"
      FROM calls c  
      WHERE c.id = $1
    `;
    const result = await pool.query(query, [data.id]);
    return result.rows[0] as API.Community.getCall.Response;
  }

  public async getCallDataById(callId: string) {
    const query = `
      SELECT
        c."communityId",
        c."channelId",
        c."callServerId",
        c."startedAt",
        c."endedAt"
      FROM calls c
      WHERE c.id = $1
    `;
    const result = await pool.query(query, [callId]);
    return result.rows[0] as {
      communityId: string;
      channelId: string;
      callServerId: string;
      startedAt: string;
      endedAt: string | null;
    } | undefined;
  }

  public async getCallRolePermissions(callId: string, channelId: string) {
    const query = `
      SELECT
        cp."permissions",
        r."title" AS "roleTitle",
        r."id" AS "roleId",
        r."type" AS "roleType",
        r."communityId" AS "communityId"
      FROM callpermissions cp
      INNER JOIN roles r
        ON r."id" = cp."roleId"
        AND r."deletedAt" IS NULL
      INNER JOIN calls c
        ON c."id" = cp."callId"
      WHERE cp."callId" = $1
        AND c."channelId" = $2
    `;
    const result = await pool.query(query, [
      callId,
      channelId,
    ]);
    return result.rows as {
      permissions: Common.CallPermission[];
      roleTitle: string;
      roleId: string;
      communityId: string;
      type: Models.Community.Role["type"],
    }[];
  }

  public async areUsersCommunityMembers(userIds: string[], communityId: string) {
    if (!Array.isArray(userIds) || userIds.length === 0) {
      return [];
    }
    const result = await pool.query(`
      SELECT ruu."userId"
      FROM roles r
      INNER JOIN roles_users_users ruu
        ON r."id" = ruu."roleId"
        AND ruu.claimed = TRUE
      WHERE ruu."userId" = ANY(ARRAY[${format("%L", userIds)}]::UUID[])
        AND r."communityId" = ${format("%L::UUID", communityId)}
        AND r."type" = ${format("%L", RoleType.PREDEFINED)}
        AND r."title" = ${format("%L", PredefinedRole.Member)}
    `);
    const rows = result.rows as { userId: string }[];
    const existingRelations = new Set(rows.map(r => r.userId));
    return userIds.map(userId => ({
      userId,
      isInCommunity: existingRelations.has(userId),
    }));
  }

  public async getTransactionData(communityId: string) {
    const result = await pool.query<{
      id: string;
      userId: string | null;
      communityId: string | null;
      amount: number;
      data: Models.Premium.TransactionData;
      createdAt: string;
    }>(`
      SELECT
        id,
        "userId",
        "communityId",
        amount,
        data,
        "createdAt"
      FROM point_transactions
      WHERE "communityId" = $1
      ORDER BY "createdAt" DESC
    `, [communityId]);
    return result.rows;
  }

  public async getCommunityCount(channel: string) {
    const result = await pool.query<{
      count: number;
    }>(`
    SELECT
      COUNT(id) as "count"
    FROM communities c
    WHERE $1 = ANY(c."tags")
    `, [channel]);

    if (result.rows.length === 1) {
      return result.rows[0];
    }
    throw new Error(errors.server.NOT_ALLOWED);
  }

  public async getCommunityPassword(communityId: string) {
    const query = `
      SELECT "password"
      FROM communities c
      WHERE "id" = $1 AND "deletedAt" IS NULL
    `;

    const result = await pool.query<{ password: string | null }>(query, [communityId]);
    if (result.rows.length === 1) {
      return result.rows[0];
    }

    throw new Error(errors.server.NOT_ALLOWED);
  }

  public async setOnboardingOptions(communityId: string, onboardingOptions: Models.Community.OnboardingOptions, password: string | null): Promise<void> {
    const query = `
      UPDATE communities
      SET "onboardingOptions" = $2, "updatedAt" = NOW(), "password" = $3
      WHERE "id" = $1
      RETURNING "updatedAt"
    `;

    const result = await pool.query<{ updatedAt: string }>(query, [communityId, JSON.stringify(onboardingOptions), password]);
    if (result.rows.length !== 1) {
      throw new Error(errors.server.NOT_ALLOWED);
    }

    const updatedAt = result.rows[0].updatedAt;

    const event: Events.Community.Community = {
      type: "cliCommunityEvent",
      action: "update",
      data: {
        id: communityId,
        onboardingOptions,
        updatedAt,
      },
    };

    await eventHelper.emit(event, { communityIds: [communityId] });
  }

  private async getJoinApproval(communityId: string, userId: string): Promise<Models.Community.PendingApproval & { updatedAt: string } | null> {
    const query = `
      SELECT
        "communityId",
        "userId",
        "questionnaireAnswers",
        "approvalState",
        "approvalUpdatedAt" as "updatedAt"
      FROM user_community_state cid
      WHERE "communityId" = $1 AND "userId" = $2
    `;

    const result = await pool.query<Models.Community.PendingApproval & { updatedAt: string }>(query, [communityId, userId]);
    return result.rows[0] || null;
  }

  public async getPendingJoinApprovals(communityId: string): Promise<Models.Community.PendingApproval[]> {
    const query = `
      SELECT
        "communityId",
        "userId",
        "questionnaireAnswers",
        "approvalState",
        "approvalUpdatedAt" as "updatedAt"
      FROM user_community_state cid
      WHERE "communityId" = $1 AND "approvalState" = 'PENDING'::public.user_community_state_approvalstate_enum
      ORDER BY "updatedAt" ASC
    `;

    const result = await pool.query<Models.Community.PendingApproval>(query, [communityId]);
    return result.rows;
  }

  public async setAllPendingJoinApprovals(communityId: string, approvalState: CommunityApprovalState): Promise<void> {
    const pendingApprovals = await this.getPendingJoinApprovals(communityId);

    for (const approval of pendingApprovals) {
      await this.setPendingJoinApproval(communityId, approval.userId, approvalState, undefined, true);
    }

    const roles = await this.getCommunityRoles(communityId);
    const rolesWithPermission = roles.filter(role => role.permissions.includes('COMMUNITY_MANAGE_USER_APPLICATIONS'));

    eventHelper.emit({
      type: 'cliCommunityEvent',
      action: 'update',
      data: {
        id: communityId,
        updatedAt: new Date().toISOString(),
        membersPendingApproval: 0,
      }
    }, {
      roleIds: rolesWithPermission.map(r => r.id)
    });
  }

  public async setPendingJoinApproval(communityId: string, userId: string, approvalState: CommunityApprovalState, message?: string, skipUpdateEvent?: boolean): Promise<void> {
    const query = `
      UPDATE user_community_state
      SET "approvalState" = $3::"public"."user_community_state_approvalstate_enum", "approvalUpdatedAt" = NOW()
      WHERE "communityId" = $1 AND "userId" = $2
      RETURNING "approvalUpdatedAt"
    `;

    const result = await pool.query<Models.Community.PendingApproval>(query, [communityId, userId, approvalState]);
    if (result.rows.length !== 1) {
      throw new Error(errors.server.NOT_ALLOWED);
    }

    if (approvalState === CommunityApprovalState.APPROVED) {
      const result = await communityHelper.joinCommunity(userId, communityId);
      const event: Events.Community.Community = {
        type: "cliCommunityEvent",
        action: "new-or-full-update",
        data: result,
      };
      eventHelper.emit(event, {
        userIds: [userId],
      });
    }

    if (approvalState === CommunityApprovalState.BLOCKED) {
      await communityHelper.setUserBlockState({
        communityId,
        userId,
        blockState: 'BANNED',
        until: null
      });

      await eventHelper.emit({
        action: "update",
        type: "cliCommunityEvent",
        data: {
          id: communityId,
          updatedAt: new Date().toISOString(),
          myRoleIds: [],
          blockState: {
            state: 'BANNED',
            until: null,
          },
        },
      }, {
        userIds: [userId],
      });
    }

    // Notifications
    if (approvalState !== CommunityApprovalState.PENDING) {
      let notificationText = 'Your membership was approved!';
      if (approvalState === CommunityApprovalState.DENIED) {
        notificationText = `Your membership was denied${!!message ? `: "${message}"` : ''}. You can apply again in 24 hours.`
      } else if (approvalState === CommunityApprovalState.BLOCKED) {
        notificationText = `Your membership was denied${!!message ? `: "${message}"` : ''}. You may no longer apply.`
      }

      const [community] = await this.getCommunitiesById({ ids: [communityId] });

      const preNotification: Omit<Models.Notification.Notification, "id" | "read" | "createdAt" | "updatedAt"> & { userId: string } = {
        type: 'Approval',
        userId,
        text: notificationText,
        subjectCommunityId: communityId,
        extraData: {
          type: 'approvalData',
          approved: approvalState === CommunityApprovalState.APPROVED,
          communityUrl: community.url,
          channelId: ''
        },
        subjectItemId: null,
        subjectUserId: null,
        subjectArticleId: null,
      };

      const [result] = await notificationHelper.createNotifications([preNotification]);
      await eventHelper.sendWsOrWebPushNotificationEvent({
        userId,
        event: {
          type: 'cliNotificationEvent',
          action: 'new',
          data: {
            ...preNotification,
            ...result,
            read: false,
          }
        }
      });
    }

    // Update member counter for users with correct permission
    if (!skipUpdateEvent) {
      const pendingApprovals = await this.getPendingJoinApprovals(communityId);
      const roles = await this.getCommunityRoles(communityId);
      const rolesWithPermission = roles.filter(role => role.permissions.includes('COMMUNITY_MANAGE_USER_APPLICATIONS'));

      eventHelper.emit({
        type: 'cliCommunityEvent',
        action: 'update',
        data: {
          id: communityId,
          updatedAt: new Date().toISOString(),
          membersPendingApproval: pendingApprovals.length,
        }
      }, {
        roleIds: rolesWithPermission.map(r => r.id)
      });
    }
  }

  public async getBannedUsers(communityId: string, limit: number = 100, beforeDate?: string) {
    const result = await pool.query<{
      userId: string;
      blockState: Models.Community.UserBlockState; // can be null in DB, but not in this query
      blockStateUntil: string | null;
      blockStateUpdatedAt: string | null;
    }>(`
      SELECT
        "userId",
        "blockState",
        "blockStateUntil",
        "blockStateUpdatedAt"
      FROM user_community_state
      WHERE "communityId" = $1
        AND "blockState" IS NOT NULL
        AND (
          "blockStateUntil" IS NULL OR "blockStateUntil" >= NOW()
        )
        ${!!beforeDate ? `AND "blockStateUpdatedAt" < ${format("%L::timestamp", beforeDate)}` : ''}
      ORDER BY "blockStateUpdatedAt" DESC
      LIMIT $2
    `, [communityId, limit]);
    return result.rows;
  }

  public async updateNotificationState(userId: string, data: API.Community.updateNotificationState.Request) {
    for (const entry of data.data) {
      const { communityId, ...newNotificationState } = entry;
      const query = `
        UPDATE user_community_state
        SET 
          "notifyMentions" = $3,
          "notifyReplies" = $4,
          "notifyPosts" = $5,
          "notifyEvents" = $6,
          "notifyCalls" = $7
        WHERE "userId" = $1 AND "communityId" = $2
        RETURNING 1
      `;

      const result = await pool.query(query, [
        userId,
        communityId,
        entry.notifyMentions,
        entry.notifyReplies,
        entry.notifyPosts,
        entry.notifyEvents,
        entry.notifyCalls
      ]);

      if (result.rows.length !== 1) {
        throw new Error(errors.server.NOT_ALLOWED);
      }

      const updatedAt = new Date().toISOString();

      const event: Events.Community.Community = {
        type: "cliCommunityEvent",
        action: "update",
        data: {
          id: communityId,
          notificationState: newNotificationState,
          updatedAt,
        },
      };

      await eventHelper.emit(event, { userIds: [userId] });
    }
  }

  private filterCommunitiesVisibility(communities: (Pick<Models.Community.DetailViewFromApi, "myRoleIds" | "roles" | "membersPendingApproval"> & {
    channels: Pick<Models.Community.Channel, "rolePermissions">[],
    calls: Pick<Models.Calls.Call, "rolePermissions">[],
  })[]): void {
    for (const community of communities) {
      const myRoleIds = new Set(community.myRoleIds);
      const myRoles = community.roles.filter(r => myRoleIds.has(r.id) || r.title === "Public");
      community.channels = community.channels.filter(channel => {
        for (const myRole of myRoles) {
          const permissions = channel.rolePermissions.find(rp => rp.roleId === myRole.id)?.permissions;
          if (!!permissions && permissions.some(p => p === ChannelPermission.CHANNEL_EXISTS)) {
            return true;
          }
        }
        return false;
      });
      community.calls = community.calls.filter(call => {
        for (const myRole of myRoles) {
          const permissions = call.rolePermissions.find(rp => rp.roleId === myRole.id)?.permissions;
          if (!!permissions && permissions.some(p => p === CallPermission.CALL_EXISTS)) {
            return true;
          }
        }
        return false;
      });
      const canApproveUsers = myRoles.some(role => role.permissions.includes('COMMUNITY_MANAGE_USER_APPLICATIONS'));
      if (!canApproveUsers) {
        community.membersPendingApproval = undefined;
      }
    }
  }

  public async getCommunityPremiumTier(communityId: string): Promise<Models.Community.PremiumName | "FREE"> {
    const result = await pool.query<{
      featureName: Models.Community.PremiumName;
    }>(`
      SELECT "featureName"
      FROM communities_premium
      WHERE "communityId" = $1
        AND "activeUntil" > now()
      ORDER BY "activeUntil" DESC
      LIMIT 1
    `, [communityId]);
    if (result.rows.length === 0) {
      return "FREE";
    }
    return result.rows[0].featureName;
  }

  public async isCommunityWhitelisted(communityId: string) {
    const result = await pool.query(`
      SELECT 1
      FROM communities
      WHERE id = $1 AND "enablePersonalNewsletter" = TRUE
    `, [communityId]);
    return result.rows.length === 1;
  }

  public async getAirdropClaimHistory(communityId: string, roleId: string) {
    const roleData = await this.getRole(roleId);
    if (!roleData.airdropConfig || roleData.communityId !== communityId) {
      throw new Error(errors.server.INVALID_REQUEST);
    }

    if (!roleData.airdropConfig.airdropExecuted) {
      const result = await pool.query<{
        userId: string;
        claimedAt: string;
      }>(`
        SELECT "userId", "updatedAt" AS "claimedAt"
        FROM roles_users_users
        WHERE "roleId" = $1
          AND "claimed" = TRUE
          AND "updatedAt" <= $3::timestamp
        ORDER BY "updatedAt" ASC
        LIMIT $2
      `, [roleId, Number(roleData.airdropConfig.maximumUsers), roleData.airdropConfig.endDate]);
      return result.rows;
    }
    else {
      const result = await pool.query<{
        userId: string;
        claimedAt: string;
      }>(`
        SELECT "userId", "airdropData"->>'claimedAt' AS "claimedAt"
        FROM user_community_airdrops
        WHERE "roleId" = $1
      `, [roleId]);
      const returnData = [...result.rows].sort((a, b) => {
        return new Date(a.claimedAt).getTime() - new Date(b.claimedAt).getTime();
      });
      return returnData;
    }
  }

  public async getAirdropCommunities(state: "ongoing" | "finished", userId?: string) {
    const query = `
      WITH found_aidrdop_roles AS (
        SELECT
          r."id",
          r."communityId",
          r."title",
          r."type",
          r."assignmentRules",
          r."updatedAt",
          r."permissions",
          r."imageId",
          r."description",
          r."airdropConfig"
        FROM roles r
        WHERE (r."airdropConfig"->>'endDate')::timestamp ${state === "ongoing" ? ">" : "<="} NOW()
      )
      SELECT 
        json_build_object(
          'id', c."id",
          'url', c."url",
          'title', c."title", 
          'logoSmallId', c."logoSmallId",
          'logoLargeId', c."logoLargeId",
          'headerImageId', c."headerImageId",
          'shortDescription', c."shortDescription",
          'tags', c."tags",
          'official', c."official",
          'allowUserBots', c."allowUserBots",
          'updatedAt', c."updatedAt",
          'createdAt', c."createdAt",
          'memberCount', c."memberCount",
          'premium', (CASE WHEN cp."featureName" IS NOT NULL THEN json_build_object(
            'featureName', cp."featureName",
            'activeUntil', cp."activeUntil",
            'autoRenew', cp."autoRenew"
          ) ELSE NULL END)
        ) as "community",
        json_build_object(
          'id', far."id",
          'communityId', far."communityId",
          'title', far."title",
          'type', far."type",
          'assignmentRules', far."assignmentRules",
          'updatedAt', far."updatedAt",
          'permissions', far."permissions",
          'imageId', far."imageId",
          'description', far."description",
          'airdropConfig', far."airdropConfig"
        ) as "role",
        ${!!userId ? `COALESCE((
          SELECT "airdropData"
          FROM user_community_airdrops uca
          WHERE uca."communityId" = c."id"
            AND uca."roleId" = far."id" 
            AND uca."userId" = ${format('%L::UUID', userId)}
        ), NULL)` : 'NULL'} as "userAirdropData",
        (SELECT COUNT(*) FROM user_community_airdrops uca WHERE uca."communityId" = c."id" AND uca."roleId" = far."id") as "airdropUserCount"
      FROM communities c
      INNER JOIN found_aidrdop_roles far
        ON far."communityId" = c."id"
      LEFT JOIN LATERAL (
        SELECT "featureName", "activeUntil", "autoRenew"
        FROM communities_premium
        WHERE "featureName" = ANY(ARRAY[${format("%L", [CommunityPremiumFeatureName.BASIC, CommunityPremiumFeatureName.PRO, CommunityPremiumFeatureName.ENTERPRISE])}]::"public"."communities_premium_featurename_enum"[])
          AND "communityId" = c."id"
        ORDER BY "activeUntil" DESC
        LIMIT 1
      ) cp ON TRUE
      WHERE c."deletedAt" IS NULL`;

    const result = await pool.query<{
      community: {
        id: string;
        url: string;
        title: string;
        logoSmallId: string | null;
        logoLargeId: string | null;
        headerImageId: string | null;
        shortDescription: string;
        tags: string[];
        official: boolean;
        allowUserBots: boolean;
        updatedAt: string;
        createdAt: string;
        memberCount: number;
        premium: Models.Community.Premium | null;
      };
      role: Models.Community.Role;
      userAirdropData: Models.Community.UserAirdropData | null;
      airdropUserCount: number;
    }>(query);

    return result.rows;
  }

  public async isWizardCodeAvailable({ wizardId, code }: { wizardId: string, code: string }) {
    const result = await pool.query(`
      SELECT 1
      FROM wizard_claimable_codes
      WHERE "wizardId" = $1
        AND "code" = $2
        AND "claimedBy" IS NULL
    `, [wizardId, code]);

    return result.rows.length === 1;
  }

  public async redeemAndInvalidateWizardCode({ wizardId, code, userId }: { wizardId: string, code: string, userId: string }) {
    const result = await pool.query(`
      UPDATE wizard_claimable_codes
      SET "claimedBy" = $1
      WHERE "wizardId" = $2
        AND "code" = $3
        AND "claimedBy" IS NULL
    `, [userId, wizardId, code]);

    if (result.rowCount !== 1) {
      throw new Error(errors.server.NOT_FOUND)
    }
  }

  public async wizardVerifyWallet({ wizardId, wallet }: { wizardId: string, wallet: string }): Promise<Models.Wizard.WizardStep> {
    throw new Error(errors.server.NOT_IMPLEMENTED);
  }

  public async checkWizardAccessAllowedOrThrow(wizardId: string, userId?: string) {
    const result = await pool.query(`
      SELECT 1
      FROM roles r
      INNER JOIN wizard_role_permission wrp
        ON r."id" = wrp."roleId"
        AND wrp."wizardId" = $1
      LEFT JOIN roles_users_users ruu
        ON r."id" = ruu."roleId"
        AND ruu.claimed = TRUE
      WHERE r."deletedAt" IS NULL
        AND (
          ${!!userId ? format('ruu."userId" = %L OR', userId) : ''}
          r."title" = ${format('%L', PredefinedRole.Public)}
        )
    `, [wizardId]);

    if (result.rows.length === 0) {
      throw new Error(errors.server.NOT_ALLOWED);
    }
  }

  public async getWizardData(wizardId: string, userId?: string): Promise<{
    wizardData: Models.Wizard.Wizard;
    userData?: Models.Wizard.WizardUserData;
  }> {
    await this.checkWizardAccessAllowedOrThrow(wizardId, userId);

    const result = await pool.query<{ wizardData: Models.Wizard.Wizard, userData?: Models.Wizard.WizardUserData }>(`
      SELECT 
        w.data AS "wizardData",
        wud.data AS "userData"
      FROM wizards w
      LEFT JOIN wizard_user_data wud ON w.id = wud."wizardId" AND wud."userId" = $2
      WHERE w.id = $1
    `, [wizardId, userId]);

    if (result.rows.length < 1) {
      throw new Error(errors.server.NOT_FOUND);
    }

    const { wizardData, userData } = result.rows[0];

    return { wizardData, userData };
  }

  public async wizardClaimInvestmentTransaction(options: {
    wizardId: string,
    userId: string,
    chain: Models.Contract.ChainIdentifier,
    txHash: string,
    fromAddress: Common.Address,
    toAddress: Common.Address,
    amount: string,
    target: Models.Wizard.ValidInvestmentTarget
  }): Promise<{
    newInvestmentAmount: string;
  }> {
    await this.checkWizardAccessAllowedOrThrow(options.wizardId, options.userId);

    if (!options.amount.match(/^\d+$/) || BigInt(options.amount) <= 0n) {
      throw new Error(errors.server.INVALID_REQUEST);
    }

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const query = `
        INSERT INTO wizard_investment_data (
          "wizardId",
          "userId",
          "chain",
          "fromAddress",
          "toAddress",
          "amount",
          "txHash",
          "target"
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      `;
      const values = [
        options.wizardId,
        options.userId,
        options.chain,
        options.fromAddress.toLowerCase(),
        options.toAddress.toLowerCase(),
        options.amount,
        options.txHash.toLowerCase(),
        options.target
      ];

      await client.query(query, values);

      // Select all amounts from wizard_investment_data for this userId and add them up
      const selectQuery = `
        SELECT amount
        FROM wizard_investment_data
        WHERE "userId" = $1 AND "target" = $2
      `;
      const selectValues = [
        options.userId,
        options.target
      ];

      const result = await client.query<{ amount: string }>(selectQuery, selectValues);

      const newInvestmentAmount = result.rows.reduce((sum, row) => {
        return sum + BigInt(row.amount);
      }, 0n).toString();

      await client.query('COMMIT');

      return { newInvestmentAmount };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async wizardFinishedSuccess(wizardId: string, userId: string) {
    await this.checkWizardAccessAllowedOrThrow(wizardId, userId);

    //check if user has already finished the wizard by looking into the wizard_user_data data field and then update the data.state to 'success'	
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query<{
        wizardData: Models.Wizard.Wizard;
        communityId: string;
        userData: Models.Wizard.WizardUserData | null;
        redeemedCode: boolean;
        userExtraData: Models.User.ExtraData;
      }>(`
        SELECT
          w."data" AS "wizardData",
          w."communityId",
          wud."data" AS "userData",
          wcc.code IS NOT NULL AS "redeemedCode",
          (SELECT "extraData" FROM users u WHERE u.id = $2) AS "userExtraData"
        FROM wizards w
        LEFT JOIN wizard_user_data wud
          ON wud."wizardId" = w.id
          AND wud."userId" = $2
        LEFT JOIN wizard_claimable_codes wcc
          ON wcc."wizardId" = w.id
          AND wcc."claimedBy" = $2
        WHERE w.id = $1
      `, [wizardId, userId]);

      if (result.rows.length === 0) {
        throw new Error(errors.server.NOT_FOUND);
      }
      else {
        const { wizardData, communityId, userData, redeemedCode, userExtraData } = result.rows[0];

        if (!!userData && userData.state !== 'active') {
          throw new Error(errors.server.NOT_ALLOWED);
        }

        // check all success conditions
        for (const successCondition of wizardData.successConditions) {
          if (
            (successCondition.type === "kycLiveness" && !userExtraData.kycLivenessSuccess) ||
            (successCondition.type === "kycFull" && !userExtraData.kycFullSuccess) ||
            (successCondition.type === "kycCgTokensale" && !userExtraData.kycCgTokensaleSuccess) ||
            (successCondition.type === "redeemedCode" && !redeemedCode)
          ) {
            throw new Error(errors.server.NOT_ALLOWED);
          }

          if (successCondition.type === "invested") {
            const investmentStep = wizardData.steps.find(s => s.type === "invest") as (Models.Wizard.WizardStep & { type: "invest" }) | undefined;
            if (!investmentStep) {
              throw new Error(errors.server.INVALID_REQUEST);
            }
            const investmentTarget = investmentTargets[investmentStep.target];
            if (!investmentTarget) {
              throw new Error(errors.server.INVALID_REQUEST);
            }

            // Fetch all investments for the current user and target
            const investmentsResult = await client.query<{ amount: string }>(`
              SELECT amount
              FROM wizard_investment_data
              WHERE "userId" = $1 AND "target" = $2
            `, [userId, investmentStep.target]);

            // Sum up all investments using bigint
            const totalInvestment = investmentsResult.rows.reduce((sum, row) => {
              return sum + BigInt(row.amount);
            }, BigInt(0));

            if (totalInvestment < BigInt(parseUnits(investmentTarget.minimumAmount, investmentTarget.decimals))) {
              console.log("Insufficient investment amount", totalInvestment.toString(), investmentTarget.minimumAmount);
              throw new Error(errors.server.NOT_ALLOWED);
            }
          }

          if (successCondition.type === "step_ndaAccepted" || successCondition.type === "step_investorDetailsFilled" || successCondition.type === "step_americanSelfCertification") {
            const keys = Object.keys(userData?.stepData ?? {}) as `${number}`[];
            let stepData: Models.Wizard.WizardStepData | undefined;
            for (const key of keys) {
              let data = userData?.stepData[key];
              if (successCondition.type === "step_ndaAccepted" && data?.type === "ndaAccepted") {
                stepData = data;
                break;
              }
              else if (successCondition.type === "step_investorDetailsFilled" && data?.type === "investorDetailsFilled") {
                stepData = data;
                break;
              }
              else if (successCondition.type === "step_americanSelfCertification" && data?.type === "americanSelfCertification") {
                stepData = data;
                break;
              }
            }
            if (!stepData) {
              throw new Error(errors.server.WIZARD_STEP_DATA_MISSING);
            }
          }
        }

        const updateResult = await client.query<Models.Wizard.WizardUserData>(`
          INSERT INTO wizard_user_data ("wizardId", "userId", "data")
          VALUES ($1, $2, jsonb_build_object('state', 'success'))
          ON CONFLICT ("wizardId", "userId")
          DO UPDATE SET
            data = jsonb_set(wizard_user_data.data, '{state}', '"success"'),
            "updatedAt" = NOW()
          RETURNING *
        `, [wizardId, userId]);

        if (updateResult.rowCount < 1) {
          throw new Error(errors.server.EXISTS_ALREADY);
        }

        // update wizard successfulUsers
        const wizardUpdateResult = await client.query<Models.Wizard.Wizard>(`
          UPDATE wizards
          SET data = jsonb_set(
            data,
            '{successfulUsers}',
            ((data->>'successfulUsers')::int + 1)::text::jsonb
          ),
          "updatedAt" = NOW()
          WHERE id = $1
            AND (
              (data->>'successLimit')::int IS NULL OR
              (data->>'successfulUsers')::int < (data->>'successLimit')::int
            )
        `, [wizardId]);

        if (wizardUpdateResult.rowCount < 1) {
          throw new Error(errors.server.WIZARD_SUCCESS_LIMIT_EXCEEDED);
        }

        // execute successAction
        for (const successAction of wizardData.successActions) {
          if (successAction.type === "joinWizardCommunity") {
            // Check if the user already has the member role
            const memberRoleResult = await client.query(`
              SELECT 1
              FROM roles_users_users ruu
              JOIN roles r ON ruu."roleId" = r.id
              WHERE ruu."userId" = $1
                AND r."communityId" = $2
                AND r.title = ${format('%L', PredefinedRole.Member)}
                AND r.type = ${format('%L', RoleType.PREDEFINED)}
                AND ruu.claimed = TRUE
            `, [userId, communityId]);

            // If the user already has the member role, skip joining the community
            if (memberRoleResult.rowCount > 0) {
              continue;
            }

            const result = await this.joinCommunity(userId, communityId);
            const event: Events.Community.Community = {
              type: "cliCommunityEvent",
              action: "new-or-full-update",
              data: result,
            };
            eventHelper.emit(event, {
              userIds: [userId],
            });
          }
          else if (successAction.type === "gainRole") {
            const memberRoleResult = await client.query(`
              SELECT 1
              FROM roles_users_users ruu
              JOIN roles r ON ruu."roleId" = r.id
              WHERE ruu."userId" = $1
                AND r."communityId" = $2
                AND r.id = $3
                AND ruu.claimed = TRUE
            `, [userId, communityId, successAction.roleId]);

            if (memberRoleResult.rowCount > 0) {
              continue;
            }

            await this.addUserToRoles({ communityId, userId, roleIds: [successAction.roleId] });
          }

          else if (successAction.type === "generateCodes") {
            const wizardResult = await client.query<{ communityId: string }>(`
              SELECT "communityId" FROM wizards
              WHERE id = ANY(ARRAY[${format('%L', [wizardId, successAction.wizardId])}]::uuid[])
            `);

            if (wizardResult.rows.length === 2 && wizardResult.rows[0].communityId !== wizardResult.rows[1].communityId) {
              console.log("Create codes: Wizard community ids do not match", wizardResult.rows[0].communityId, wizardResult.rows[1].communityId);
              throw new Error(errors.server.INVALID_REQUEST);
            }

            const codes = Array.from({ length: successAction.numberOfCodes }, () => getRandomReadableString(8));
            const insertQuery = `
              INSERT INTO wizard_claimable_codes ("wizardId", "code", "createdBy")
              SELECT $1, unnest($2::text[]), $3
            `;
            await client.query(insertQuery, [successAction.wizardId, codes, userId]);
          }
        }
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async wizardFinishedFailure(wizardId: string, userId: string) {
    await this.checkWizardAccessAllowedOrThrow(wizardId, userId);

    const client = await pool.connect();

    try {
      await client.query('BEGIN');

      const userDataResult = await client.query<{ data: Models.Wizard.WizardUserData }>(`
        SELECT data
        FROM wizard_user_data
        WHERE "wizardId" = $1 AND "userId" = $2
      `, [wizardId, userId]);

      if (userDataResult.rows.length > 0) {
        const userData = userDataResult.rows[0].data;
        if (userData.state !== 'active') {
          throw new Error(errors.server.INVALID_REQUEST);
        }
      }

      await client.query<Models.Wizard.Wizard>(`
        UPDATE wizards
        SET data = jsonb_set(
          data,
          '{failedUsers}',
          ((data->>'failedUsers')::int + 1)::text::jsonb
        ),
        "updatedAt" = NOW()
        WHERE id = $1
      `, [wizardId]);

      const updateResult = await client.query<Models.Wizard.WizardUserData>(`
        INSERT INTO wizard_user_data ("wizardId", "userId", data)
        VALUES ($1, $2, jsonb_build_object('state', 'failed'))
        ON CONFLICT ("wizardId", "userId")
        DO UPDATE SET
          data = jsonb_set(wizard_user_data.data, '{state}', '"failed"'),
          "updatedAt" = NOW()
        RETURNING *
      `, [wizardId, userId]);

      if (updateResult.rowCount < 1) {
        throw new Error(errors.server.INVALID_REQUEST);
      }

      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async getMyReferralCodes(wizardId: string, userId: string): Promise<{ code: string, used: boolean }[]> {
    const result = await pool.query<{ code: string, used: boolean }>(`
      SELECT code, "claimedBy" IS NOT NULL AS used
      FROM wizard_claimable_codes
      WHERE "wizardId" = $1 AND "createdBy" = $2
    `, [wizardId, userId]);
    return result.rows;
  }

  public async setWizardStepData(
    wizardId: string,
    userId: string,
    stepId: number,
    value: Models.Wizard.WizardStepData & { serverTimestamp?: never }
  ): Promise<Models.Wizard.WizardUserData> {
    await this.checkWizardAccessAllowedOrThrow(wizardId, userId);

    // Check if a wizard_user_data object already exists and its state
    const existingDataResult = await pool.query<{ state: Models.Wizard.WizardUserData['state'] | null }>(`
      SELECT data->>'state' AS state
      FROM wizard_user_data
      WHERE "wizardId" = $1 AND "userId" = $2
    `, [wizardId, userId]);

    if (existingDataResult.rows.length > 0) {
      const state = existingDataResult.rows[0].state;
      if (!!state && state !== 'active') {
        throw new Error(errors.server.NOT_ALLOWED);
      }
    }

    (value as Models.Wizard.WizardStepData).serverTimestamp = Date.now();

    // Proceed with the update if the state check passes
    await pool.query(`
      INSERT INTO wizard_user_data ("wizardId", "userId", data)
      VALUES ($1, $2, jsonb_build_object('stepData', jsonb_build_object($3::text, $4::jsonb), 'state', 'active'))
      ON CONFLICT ("wizardId", "userId")
      DO UPDATE SET data = 
        CASE 
          WHEN wizard_user_data.data ? 'stepData' THEN 
            jsonb_set(
              wizard_user_data.data,
              '{stepData}',
              wizard_user_data.data->'stepData' || jsonb_build_object($3::text, $4::jsonb)
            )
          ELSE 
            jsonb_set(
              COALESCE(wizard_user_data.data, '{}'::jsonb),
              '{stepData}',
              jsonb_build_object($3::text, $4::jsonb)
            )
        END
    `, [wizardId, userId, stepId.toString(), JSON.stringify(value)]);

    const newUserDataResult = await pool.query<{ data: Models.Wizard.WizardUserData }>(`
      SELECT data
      FROM wizard_user_data
      WHERE "wizardId" = $1 AND "userId" = $2
    `, [wizardId, userId]);

    if (newUserDataResult.rows.length < 1) {
      throw new Error(errors.server.NOT_FOUND);
    }

    return newUserDataResult.rows[0].data;
  }

  public async wizardGetInvestmentTargetBeneficiaryBalance(target: Models.Wizard.ValidInvestmentTarget): Promise<{ balance: string }> {
    const investmentTarget = investmentTargets[target];
    if (!investmentTarget || investmentTarget.token.type !== 'erc20') {
      throw new Error(errors.server.INVALID_REQUEST);
    }

    // Fetch all investments for the current target
    const investmentsResult = await pool.query<{ amount: string }>(`
      SELECT amount
      FROM wizard_investment_data
      WHERE "target" = $1
    `, [target]);

    // Sum up all investments using bigint
    const claimedBalance = investmentsResult.rows.reduce((sum, row) => {
      return sum + BigInt(row.amount);
    }, BigInt(0));

    return { balance: claimedBalance.toString() };
  }

  public async wizardGetInvestmentTargetPersonalContribution(target: Models.Wizard.ValidInvestmentTarget, userId: string): Promise<{ contribution: string }> {
    const investmentTarget = investmentTargets[target];
    if (!investmentTarget) {
      throw new Error(errors.server.INVALID_REQUEST);
    }

    // Fetch all investments for the current user and target
    const investmentsResult = await pool.query<{ amount: string }>(`
      SELECT amount
      FROM wizard_investment_data
      WHERE "userId" = $1 AND "target" = $2
    `, [userId, target]);

    // Sum up all investments using bigint
    const contribution = investmentsResult.rows.reduce((sum, row) => {
      return sum + BigInt(row.amount);
    }, BigInt(0));

    return { contribution: contribution.toString() };
  }

  public async getUserRoles(userId: string, communityId: string): Promise<string[]> {
    const result = await pool.query<{ id: string }>(`
      SELECT r."id" FROM roles r
      JOIN roles_users_users ruu ON (r."id" = ruu."roleId" AND ruu.claimed = TRUE)
      WHERE r."communityId" = $1 AND ruu."userId" = $2 AND r."deletedAt" IS NULL
    `, [communityId, userId]);
    return result.rows.map((row) => row.id);
  }
}

const communityHelper = new CommunityHelper();
export default communityHelper;
