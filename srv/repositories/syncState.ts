// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import format from "pg-format";
import pool from "../util/postgres";
import { ChannelPermission, PredefinedRole } from "../common/enums";
import notificationHelper from "./notifications";

/** Ceiling of every `unread` count (`API.Messages.UnreadCap`). */
export const UNREAD_CAP: API.Messages.UnreadCap = 999;

type SyncStateRow = {
  channelId: string;
  communityId: string | null;
  chatId: string | null;
  /** bigint, sent as text */
  syncSeq: string | number;
  lastRead: Date | string | null;
  lastMessageDate: Date | string | null;
  unread: number | string;
};

function toIsoOrNull(value: Date | string | null): string | null {
  if (value === null) {
    return null;
  }
  return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
}

/**
 * Read state of every community channel and DM a user can read, in one
 * statement (one snapshot: `syncSeq`, `lastRead` and `unread` of a channel
 * belong together).
 *
 * - Community channels: in communities where the user holds a claimed role
 *   (the communities `getOwnCommunities` lists), channels for which the
 *   user's claimed roles plus the community's Public role together grant
 *   CHANNEL_EXISTS and CHANNEL_READ — the check `loadMessages` makes.
 * - DMs: chats the user is a member of that are not deleted.
 * - `unread`: non-deleted messages of others after `lastRead`, capped at
 *   UNREAD_CAP. Without a `lastRead`: `0` for community channels, every
 *   message of others for DMs (the semantics of the community detail view and
 *   of `getChats`).
 * - `syncSeq`: the channel's row in `channel_sync_state`, `0` without one.
 *
 * Read-only: unlike `getOwnCommunities` and `getChats` it writes no read
 * state rows.
 *
 * `$1` is the user id, `$2` (only with a filter) the channel ids.
 */
export function buildSyncStateQuery(filtered: boolean): string {
  const channelFilter = (column: string) => filtered ? `AND ${column} = ANY($2::uuid[])` : '';
  return `
    WITH my_roles AS (
      SELECT r."id", r."communityId"
      FROM roles_users_users ruu
      INNER JOIN roles r
        ON r."id" = ruu."roleId"
        AND r."deletedAt" IS NULL
      WHERE ruu."userId" = $1
        AND ruu."claimed" = TRUE
    ),
    my_communities AS (
      SELECT DISTINCT c."id"
      FROM my_roles mr
      INNER JOIN communities c
        ON c."id" = mr."communityId"
        AND c."deletedAt" IS NULL
    ),
    reading_roles AS (
      SELECT mr."id", mr."communityId"
      FROM my_roles mr
      INNER JOIN my_communities mc ON mc."id" = mr."communityId"
      UNION
      SELECT r."id", r."communityId"
      FROM roles r
      INNER JOIN my_communities mc ON mc."id" = r."communityId"
      WHERE r."title" = ${format('%L', PredefinedRole.Public)}
        AND r."deletedAt" IS NULL
    ),
    readable AS (
      SELECT ch."channelId", ch."communityId", NULL::uuid AS "chatId"
      FROM communities_channels ch
      INNER JOIN communities_channels_roles_permissions ccrp
        ON ccrp."communityId" = ch."communityId"
        AND ccrp."channelId" = ch."channelId"
      INNER JOIN reading_roles rr
        ON rr."id" = ccrp."roleId"
        AND rr."communityId" = ch."communityId"
      WHERE ch."deletedAt" IS NULL
        ${channelFilter('ch."channelId"')}
      GROUP BY ch."communityId", ch."channelId"
      HAVING bool_or(${format('%L', ChannelPermission.CHANNEL_EXISTS)} = ANY(ccrp."permissions"))
        AND bool_or(${format('%L', ChannelPermission.CHANNEL_READ)} = ANY(ccrp."permissions"))
      UNION ALL
      SELECT c."channelId", NULL::uuid AS "communityId", c."id" AS "chatId"
      FROM chats c
      WHERE c."userIds" @> ARRAY[$1::uuid]
        AND c."deletedAt" IS NULL
        ${channelFilter('c."channelId"')}
    )
    SELECT
      rd."channelId",
      rd."communityId",
      rd."chatId",
      COALESCE(css."seq", 0)::text AS "syncSeq",
      chrs."lastRead",
      (
        SELECT m."createdAt"
        FROM messages m
        WHERE m."channelId" = rd."channelId"
          AND m."deletedAt" IS NULL
        ORDER BY m."createdAt" DESC
        LIMIT 1
      ) AS "lastMessageDate",
      CASE
        WHEN chrs."lastRead" IS NOT NULL THEN (
          SELECT COUNT(*)::int FROM (
            SELECT 1
            FROM messages m
            WHERE m."channelId" = rd."channelId"
              AND m."createdAt" > chrs."lastRead"
              AND m."deletedAt" IS NULL
              AND m."creatorId" <> $1
            LIMIT ${UNREAD_CAP}
          ) unread_after
        )
        WHEN rd."chatId" IS NOT NULL THEN (
          SELECT COUNT(*)::int FROM (
            SELECT 1
            FROM messages m
            WHERE m."channelId" = rd."channelId"
              AND m."deletedAt" IS NULL
              AND m."creatorId" <> $1
            LIMIT ${UNREAD_CAP}
          ) unread_all
        )
        ELSE 0
      END AS "unread"
    FROM readable rd
    LEFT JOIN channel_sync_state css
      ON css."channelId" = rd."channelId"
    LEFT JOIN channelreadstate chrs
      ON chrs."userId" = $1
      AND chrs."channelId" = rd."channelId"
  `;
}

function toChannelState(row: SyncStateRow): API.Messages.getSyncState.ChannelState {
  const state: API.Messages.getSyncState.ChannelState = {
    channelId: row.channelId,
    syncSeq: Number(row.syncSeq),
    lastMessageDate: toIsoOrNull(row.lastMessageDate),
    lastRead: toIsoOrNull(row.lastRead),
    unread: Math.min(Number(row.unread), UNREAD_CAP),
  };
  if (row.communityId !== null) {
    state.communityId = row.communityId;
  }
  if (row.chatId !== null) {
    state.chatId = row.chatId;
  }
  return state;
}

class SyncStateHelper {
  public async getChannelStates(
    userId: string,
    channelIds?: string[],
  ): Promise<API.Messages.getSyncState.ChannelState[]> {
    const filtered = channelIds !== undefined;
    if (filtered && channelIds.length === 0) {
      return [];
    }
    const params: unknown[] = filtered ? [userId, channelIds] : [userId];
    const result = await pool.query<SyncStateRow>(buildSyncStateQuery(filtered), params);
    return result.rows.map(toChannelState);
  }

  /**
   * `Message/getSyncState`: the channel states and the notification count.
   * `serverTime` is the database `now()` the count was read at.
   */
  public async getSyncState(
    userId: string,
    data: API.Messages.getSyncState.Request,
  ): Promise<API.Messages.getSyncState.Response> {
    const [channels, { unreadCount, unreadCountAt }] = await Promise.all([
      this.getChannelStates(userId, data.channelIds),
      notificationHelper.getUnreadCountWithTime(userId),
    ]);
    return {
      serverTime: unreadCountAt,
      notificationUnreadCount: unreadCount,
      channels,
    };
  }
}

const syncStateHelper = new SyncStateHelper();
export default syncStateHelper;
