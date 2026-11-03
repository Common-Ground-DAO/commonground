// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from "../common/errors";
import config from "../common/config";
import format from "pg-format";
import pool from "../util/postgres";
import { type Pool, type PoolClient } from "pg";
import { ChannelNotificationTypeEnum, ChannelPinTypeEnum } from "../common/enums";
import fileHelper from "./files";

async function _getMessages<T extends boolean>(
  db: Pool | PoolClient,
  options: {
    channelId: string;
    userId?: string;
    where?: string;
    limit: number | null;
    order?: 'DESC' | 'ASC';
    includeDeleted: T;
  }
): Promise<T extends true ? (Models.Message.ApiMessage & { deletedAt: string | null })[] : Models.Message.ApiMessage[]> {
  const query = `
    SELECT
      m."id",
      m."creatorId",
      m."channelId",
      m."body",
      m."attachments",
      m."createdAt",
      m."editedAt",
      m."updatedAt",
      m."parentMessageId",
      m."reactions",
      ${!!options.userId
        ? `rea."reaction" AS "ownReaction"`
        : `NULL AS "ownReaction"`
      }
      ${options.includeDeleted ? ', m."deletedAt" ' : ''}
    FROM messages m
    ${!!options.userId
      ? `
      LEFT JOIN reactions rea
        ON rea."itemId" = m.id
        AND rea."deletedAt" IS NULL
        AND rea."userId" = ${format("%L::UUID", options.userId)}`
      : ``
    }
    WHERE
      m."channelId" = ${format("%L::UUID", options.channelId)}
      ${!options.includeDeleted ? 'AND m."deletedAt" IS NULL' : ''}
      ${options.where ? `AND ${options.where}` : ''}
    ORDER BY m."createdAt" ${options.order || 'DESC'}
    ${options.limit !== null ? `LIMIT ${+options.limit}` : ''}
  `;
  const result = await db.query(query);
  return result.rows as {
    id: string;
    creatorId: string;
    channelId: string;
    body: Models.Message.ApiMessage["body"];
    attachments: Models.Message.ApiMessage["attachments"];
    createdAt: string;
    editedAt: string | null;
    updatedAt: string;
    deletedAt: string | null;
    parentMessageId: string | null;
    reactions: Models.Message.ApiMessage["reactions"];
    ownReaction: string | null;
  }[];
}

async function _createMessage(
  db: Pool | PoolClient,
  userId: string,
  data: API.Messages.createMessage.Request
): Promise<{
  message: Models.Message.ApiMessage;
  userAlias: string;
}> {
  const query = `
    WITH update_readstate AS (
      INSERT INTO channelreadstate (
        "userId",
        "channelId",
        "lastRead"
      )
      VALUES (
        $2::uuid,
        $3::uuid,
        now()
      )
      ON CONFLICT ("userId", "channelId")
      DO UPDATE SET "lastRead" = GREATEST(channelreadstate."lastRead", EXCLUDED."lastRead")
    ), creator_data AS (
      SELECT "displayAccount", coalesce((SELECT json_agg(
        json_build_object(
          'type', ua."type",
          'displayName', ua."displayName",
          'imageId', ua."imageId"
        )
      ) from user_accounts ua WHERE ua."userId" = u."id"), '[]'::json) AS "accounts"
      FROM users u
      WHERE id = $2::uuid
    )
    INSERT INTO messages (
      "id",
      "creatorId",
      "channelId",
      "body",
      "attachments",
      "parentMessageId"
    ) VALUES (
      $1::uuid,
      $2::uuid,
      $3::uuid,
      $4::json,
      $5::json,
      $6::uuid
    )
    RETURNING "createdAt", "updatedAt", "id", (SELECT "accounts" FROM creator_data) AS "userAccounts", (SELECT "displayAccount" FROM creator_data) AS "userDisplayAccount"
  `;
  const result = await db.query(query, [
    data.id,
    userId,
    data.access.channelId,
    JSON.stringify(data.body),
    JSON.stringify(data.attachments),
    data.parentMessageId,
  ]);
  if (result.rows.length === 1) {
    const row = result.rows[0] as {
      createdAt: string;
      updatedAt: string;
      id: string;
      userAccounts: Models.User.ProfileItem[];
      userDisplayAccount: Models.User.ProfileItemType | null;
    };
    const { userAccounts, userDisplayAccount, ...messageData } = row;
    const message: Models.Message.ApiMessage = {
      ...messageData,
      creatorId: userId,
      channelId: data.access.channelId,
      body: data.body,
      attachments: data.attachments || [],
      parentMessageId: data.parentMessageId,
      reactions: {},
      ownReaction: null,
      editedAt: null
    }

    let userAlias = '';
    if (userDisplayAccount) {
      userAlias = userAccounts.find(acc => acc.type === userDisplayAccount)?.displayName || userAlias;
    }

    return {
      message,
      userAlias,
    };
  }
  throw new Error(errors.server.NOT_ALLOWED);
}

async function _updateMessage(
  db: Pool | PoolClient,
  userId: string,
  data: API.Messages.editMessage.Request
) {
  if (!data.access?.channelId) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  const params: any[] = [
    userId,
    data.id,
    data.access.channelId,
  ];
  let i = 4;
  const setArray: string[] = [];
  if (data.attachments !== undefined) {
    setArray.push(`attachments = $${i++}`);
    params.push(JSON.stringify(data.attachments));
  }
  if (data.body !== undefined) {
    setArray.push(`body = $${i++}`);
    params.push(data.body);
  }
  if (setArray.length > 0) {
    const query = `
      UPDATE messages
      SET ${setArray.join(',')}, "updatedAt" = NOW(), "editedAt" = NOW()
      WHERE id = $2 AND "creatorId" = $1 AND "channelId" = $3 AND "deletedAt" IS NULL
      RETURNING "updatedAt", "editedAt"
    `;
    const result = await db.query(query, params);
    if (result.rows.length === 1) {
      return result.rows[0] as { updatedAt: string, editedAt: string };
    }
  }
  throw new Error(errors.server.NOT_ALLOWED);
}

/**
 * Soft-deletes messages of one creator in one channel: either all of them, or
 * the single message `messageId`. The channel is always part of the filter.
 */
async function _deleteMessages(
  db: Pool | PoolClient,
  where: {
    creatorId: string;
    channelId: string;
    messageId?: string;
  }
) {
  if (!where.creatorId || !where.channelId) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  const query = `
    WITH removed_messages AS (
      UPDATE messages m
      SET "updatedAt" = NOW(),
        "deletedAt" = NOW(),
        "reactions" = '{}'::jsonb
      WHERE m."creatorId" = $1
        AND m."channelId" = $2
        AND m."deletedAt" IS NULL
        ${where.messageId !== undefined ? 'AND m."id" = $3' : ''}
      RETURNING m.id
    ), removed_message_reactions AS (
      UPDATE reactions r
      SET "updatedAt" = NOW(), "deletedAt" = NOW()
      FROM removed_messages rm
      WHERE r."itemId" = rm.id
    ), cleaned_parent_messages AS (
      UPDATE messages
      SET "parentMessageId" = NULL, "updatedAt" = NOW()
      WHERE "parentMessageId" = ANY(SELECT id FROM removed_messages)
      AND NOT "id" = ANY(SELECT id FROM removed_messages)
      RETURNING "id"
    )
    SELECT json_build_object(
      'deletedIds', (SELECT json_agg("id") FROM removed_messages),
      'updatedParentIdToNull', COALESCE((SELECT json_agg("id") FROM cleaned_parent_messages), '[]'::json),
      'dbNow', NOW()
    ) AS "deleteData"
  `;
  const params: any[] = [where.creatorId, where.channelId];
  if (where.messageId !== undefined) {
    params.push(where.messageId);
  }
  const result = await db.query(query, params);
  if (result.rows.length !== 1) {
    throw new Error("Query did not return 1 row");
  }
  return result.rows[0].deleteData as { deletedIds: string[], updatedParentIdToNull: string[], dbNow: string };
}

async function _setReaction(
  db: Pool | PoolClient,
  userId: string,
  data: API.Messages.setReaction.Request
) {
  let existing: string | undefined;
  const _existing = await db.query(`
    SELECT
      r."reaction"
    FROM messages m
    INNER JOIN reactions r
      ON r."itemId" = m."id"
    WHERE
      r."userId" = $1
      AND m."channelId" = $2
      AND m."id" = $3
      AND r."deletedAt" IS NULL
      AND m."deletedAt" IS NULL
  `, [userId, data.access.channelId, data.messageId]);
  if (_existing.rows.length === 1) {
    existing = _existing.rows[0].reaction;
  }
  if (existing === data.reaction) {
    return;
  }

  const increaseJsonbSet = `
    jsonb_set(
      coalesce("reactions", '{}'::jsonb),
      ${format('ARRAY[%L]', data.reaction)},
      (
        coalesce("reactions"->>${format('%L', data.reaction)}, '0')::int + 1
      )::text::jsonb
    )
  `;
  const increaseDecreaseJsonbSet = `
    jsonb_set(
      ${increaseJsonbSet},
      ${format('ARRAY[%L]', existing)},
      (
        coalesce("reactions"->>${format('%L', existing)}, '1')::int - 1
      )::text::jsonb
    )
  `;

  const query = `
    WITH upsert_reaction AS (
      INSERT INTO reactions ("userId", "itemId", reaction)
      SELECT $1, $2, $3
      WHERE EXISTS (
        SELECT 1 FROM messages m
        WHERE m."deletedAt" IS NULL
        AND m."id" = $2
        AND m."channelId" = $4
      )
      ON CONFLICT ("userId", "itemId")
        DO UPDATE SET
          "deletedAt" = NULL,
          reaction = $3,
          "updatedAt" = now()
      RETURNING 1
    )
    UPDATE messages
    SET "updatedAt" = now(),
    "reactions" = (
      SELECT jsonb_object_agg(key, value)
      FROM jsonb_each(${!!existing ? increaseDecreaseJsonbSet : increaseJsonbSet})
      WHERE value::int != 0
    )
    WHERE "id" = $2
      AND "channelId" = $4
      AND EXISTS (SELECT 1 FROM upsert_reaction)
    RETURNING "updatedAt", "reactions"
  `;
  const result = await db.query(query, [
    userId,
    data.messageId,
    data.reaction,
    data.access.channelId
  ]);
  if (result.rows.length === 1) {
    return result.rows[0] as { updatedAt: string, reactions: Models.Message.ApiMessage["reactions"] };
  }
  throw new Error(errors.server.NOT_ALLOWED);
}

async function _unsetReaction(
  db: Pool | PoolClient,
  userId: string,
  data: API.Messages.unsetReaction.Request
) {
  const query = `
    WITH delete_reaction AS (
      UPDATE reactions
      SET "deletedAt" = now(), "updatedAt" = now()
      WHERE "deletedAt" IS NULL
        AND "userId" = $1
        AND "itemId" = $2
        AND EXISTS (
          SELECT 1 FROM messages m
          WHERE m."id" = $2
            AND m."channelId" = $3
        )
      RETURNING "reaction"
    )
    UPDATE messages
    SET
      "updatedAt" = now(),
      "reactions" =
        CASE
          WHEN "reactions"->>(SELECT "reaction" FROM delete_reaction) = '1'
          THEN "reactions" - (SELECT "reaction" FROM delete_reaction)
          ELSE
            jsonb_set(
              "reactions",
              ARRAY[(SELECT "reaction" FROM delete_reaction LIMIT 1)],
              (
                coalesce("reactions"->>(SELECT "reaction" FROM delete_reaction), '1')::int - 1
              )::text::jsonb
            )
        END
    WHERE "id" = $2
      AND "channelId" = $3
      AND EXISTS (SELECT 1 FROM delete_reaction)
    RETURNING "channelId", "reactions", "updatedAt"
  `;
  if (!data.access?.channelId) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  const result = await db.query(query, [
    userId,
    data.messageId,
    data.access.channelId,
  ]);
  if (result.rows.length === 1) {
    return result.rows[0] as { channelId: string, reactions: Models.Message.ApiMessage["reactions"], updatedAt: string };
  }
  return;
}

/**
 * `$2` is a live channel of the live community `$1` (neither the channel
 * link nor the community deleted).
 */
const LIVE_COMMUNITY_CHANNEL_QUERY = `
  SELECT 1 FROM communities_channels cc
  INNER JOIN communities c
    ON c."id" = cc."communityId"
  WHERE cc."communityId" = $1 AND cc."channelId" = $2
    AND cc."deletedAt" IS NULL
    AND c."deletedAt" IS NULL
`;

class MessageHelper {
  private async ensureAttachmentMetadata(data: {
    id: string;
    attachments?: Models.Message.Attachment[];
  }) {
    if (data.attachments) {
      const imageAttachments = data.attachments
        .filter(attachment => attachment.type === 'image' || attachment.type === 'linkPreview') as (Models.Message.ImageAttachment | Models.Message.LinkPreviewAttachment)[];

      // For giphy, currently the client sets the metadata { previewWidth: number, previewHeight: number }
      // with previewHeight = 200 and previewWidth between 50 and 600, see messages validator

      if (imageAttachments.length > 0) {
        const objectIds: string[] = [];
        for (const attachment of imageAttachments) {
          objectIds.push(attachment.imageId);
          if (attachment.type === 'image') {
            objectIds.push(attachment.largeImageId);
          }
        }
        const imageData = await fileHelper.getFileData({ objectIds });
        const imageDataMap = new Map(imageData.map(data => [data.objectId, data]));
        for (const attachment of imageAttachments) {
          const image = imageDataMap.get(attachment.imageId);
          if (image && image.data) {
            attachment.imageData = {
              mimeType: image.data.mimeType,
              size: {
                width: image.data.size.width,
                height: image.data.size.height,
              },
            };
          }
          if (attachment.type === 'image') {
            const largeImage = imageDataMap.get(attachment.largeImageId);
            if (largeImage && largeImage.data) {
              attachment.largeImageData = {
                mimeType: largeImage.data.mimeType,
                size: {
                  width: largeImage.data.size.width,
                  height: largeImage.data.size.height,
                },
              };
            }
          }
        }
      }
    }
  }

  public async createMessage(
    userId: string,
    data: API.Messages.createMessage.Request
  ): Promise<{
    message: Models.Message.ApiMessage;
    userAlias: string;
  }> {
    await this.ensureAttachmentMetadata(data);
    return _createMessage(pool, userId, data);
  }

  public async editMessage(
    userId: string,
    data: API.Messages.editMessage.Request
  ) {
    await this.ensureAttachmentMetadata(data);
    return await _updateMessage(pool, userId, data);
  }

  /**
   * Creator and channel of a message that is not deleted yet, or `undefined`.
   */
  public async getMessageOwnership(
    messageId: string
  ): Promise<{ creatorId: string, channelId: string } | undefined> {
    const result = await pool.query<{ creatorId: string, channelId: string }>(`
      SELECT "creatorId", "channelId"
      FROM messages
      WHERE id = $1
        AND "deletedAt" IS NULL
    `, [messageId]);
    return result.rows[0];
  }

  /**
   * Whether `access.channelId` is the channel of the community, chat, call
   * or article named in the same access object. Deleted channels, chats and
   * articles, and the channels of a deleted community, do not count. A user article that is not published yet only
   * counts for its author (`userId`).
   */
  public async isChannelInAccessScope(
    access: API.Messages.MessageAccess,
    userId?: string,
  ): Promise<boolean> {
    let query: string;
    let params: (string | null)[];
    if ('communityId' in access) {
      query = LIVE_COMMUNITY_CHANNEL_QUERY;
      params = [access.communityId, access.channelId];
    }
    else if ('chatId' in access) {
      query = `
        SELECT 1 FROM chats
        WHERE id = $1 AND "channelId" = $2
          AND "deletedAt" IS NULL
      `;
      params = [access.chatId, access.channelId];
    }
    else if ('callId' in access) {
      query = `
        SELECT 1 FROM calls
        WHERE id = $1 AND "channelId" = $2
      `;
      params = [access.callId, access.channelId];
    }
    else if ('articleId' in access && 'articleCommunityId' in access) {
      query = `
        SELECT 1 FROM articles a
        INNER JOIN communities_articles ca
          ON ca."articleId" = a.id
        WHERE a.id = $1 AND a."channelId" = $2 AND ca."communityId" = $3
          AND a."deletedAt" IS NULL
          AND ca."deletedAt" IS NULL
      `;
      params = [access.articleId, access.channelId, access.articleCommunityId];
    }
    else if ('articleId' in access && 'articleUserId' in access) {
      query = `
        SELECT 1 FROM articles a
        INNER JOIN users_articles ua
          ON ua."articleId" = a.id
        WHERE a.id = $1 AND a."channelId" = $2 AND ua."userId" = $3
          AND a."deletedAt" IS NULL
          AND ua."deletedAt" IS NULL
          AND (ua."published" < now() OR ua."userId" = $4::uuid)
      `;
      params = [access.articleId, access.channelId, access.articleUserId, userId ?? null];
    }
    else {
      return false;
    }
    const result = await pool.query(query, params);
    return result.rows.length > 0;
  }

  /**
   * The community branch of `isChannelInAccessScope`: whether `channelId` is
   * a live channel of the live community `communityId`.
   */
  public async isChannelInActiveCommunity(communityId: string, channelId: string): Promise<boolean> {
    const result = await pool.query(LIVE_COMMUNITY_CHANNEL_QUERY, [communityId, channelId]);
    return result.rows.length > 0;
  }

  public async deleteMessage(data: {
    messageId: string;
    channelId: string;
    creatorId: string;
  }) {
    return await _deleteMessages(pool, data);
  }

  public async deleteAllUserMessages(
    data: API.Messages.deleteAllUserMessages.Request
  ) {
    return await _deleteMessages(pool, {
      creatorId: data.creatorId,
      channelId: data.access.channelId
    });
  }


  public async loadMessages(
    userId: string | undefined,
    data: API.Messages.loadMessages.Request,
  ) {
    const fragments: string[] = [];
    if (!!data.createdAfter) {
      fragments.push(format('m."createdAt" > %L::timestamptz', data.createdAfter));
    }
    if (!!data.createdBefore) {
      fragments.push(format('m."createdAt" < %L::timestamptz', data.createdBefore));
    }
    return await _getMessages(pool, {
      userId,
      channelId: data.access.channelId,
      includeDeleted: false,
      limit: config.ITEMLIST_BATCH_SIZE,
      order: data.order,
      where: fragments.join(' AND '),
    })
  }

  public async loadMessagesById(
    userId: string | undefined,
    data: API.Messages.messagesById.Request,
  ): Promise<API.Messages.messagesById.Response> {
    const formattedIds = data.messageIds.map(id => format("%L::UUID", id));
    return await _getMessages(pool, {
      userId,
      channelId: data.access.channelId,
      includeDeleted: false,
      limit: null,
      where: `m.id = ANY(ARRAY[${formattedIds.join(',')}])`,
    });
  }



  public async loadMessageUpdates(
    userId: string | undefined,
    data: API.Messages.loadUpdates.Request
  ): Promise<API.Messages.loadUpdates.Response> {
    const result = await _getMessages<true>(pool, {
      userId,
      channelId: data.access.channelId,
      limit: null,
      includeDeleted: true,
      where: format(`
        m."createdAt" >= %L::TIMESTAMPTZ
        AND m."createdAt" <= %L::TIMESTAMPTZ
        AND m."updatedAt" > %L::TIMESTAMPTZ`,
        data.createdStart,
        data.createdEnd,
        data.updatedAfter
      )
    });
    const deleted: string[] = [];
    const updated: Models.Message.ApiMessage[] = [];
    for (const post of result) {
      if (post.deletedAt) {
        deleted.push(post.id);
      } else {
        const { deletedAt, ...postData } = post;
        updated.push(postData);
      }
    }
    return {
      deleted,
      updated,
    };
  }

  public async setReaction(
    userId: string,
    data: API.Messages.setReaction.Request,
  ) {
    return await _setReaction(pool, userId, data);
  }

  public async unsetReaction(
    userId: string,
    data: API.Messages.unsetReaction.Request,
  ) {
    return await _unsetReaction(pool, userId, data);
  }

  /**
   * Moves the user's read marker of a channel forward. The stored value never
   * moves backwards: a tab posting an older `lastRead` leaves the newer one in
   * place. A posted time in the future is clamped to the server's `now()`
   * (`EXCLUDED."lastRead"` is the clamped value), so a client clock that runs
   * ahead cannot mark messages that do not exist yet as read. Returns the
   * stored (effective) value as an ISO string.
   */
  public async setChannelLastRead(
    userId: string,
    data: API.Messages.setChannelLastRead.Request,
  ): Promise<string> {
    const result = await pool.query<{ lastRead: Date | string }>(`
      INSERT INTO channelreadstate (
        "userId",
        "channelId",
        "lastRead"
      )
      VALUES ($1, $2, LEAST($3::timestamptz, now()))
      ON CONFLICT ("userId", "channelId")
      DO UPDATE SET "lastRead" = GREATEST(channelreadstate."lastRead", EXCLUDED."lastRead")
      RETURNING "lastRead"
    `, [
      userId,
      data.access.channelId,
      data.lastRead,
    ]);
    return new Date(result.rows[0].lastRead).toISOString();
  }

  public async getChannelMessageNotifyData({ channelId }: { channelId: string }) {
    const query = `
      SELECT
        json_agg(u.id) AS "userIds",
        cc."communityId",
        cc."channelId",
        c.url AS "communityUrl",
        c.title AS "communityTitle",
        cc.url AS "channelUrl",
        cc.title AS "channelTitle"
      FROM users u
      INNER JOIN user_channel_settings ucs
        ON  ucs."userId" = u.id
        AND ucs."channelId" = ${format("%L::uuid", channelId)}
        AND (
          ucs."notifyType" = ${format('%L::"public"."user_channel_settings_notifytype_enum"', ChannelNotificationTypeEnum.ALWAYS)}
          OR (
            ucs."notifyType" = ${format('%L::"public"."user_channel_settings_notifytype_enum"', ChannelNotificationTypeEnum.WHILE_PINNED)}
            AND ((
              ucs."pinType" = ${format('%L::"public"."user_channel_settings_pintype_enum"', ChannelPinTypeEnum.AUTOPIN)}
              AND ucs."pinnedUntil" >= now()
            ) OR (
              ucs."pinType" = ${format('%L::"public"."user_channel_settings_pintype_enum"', ChannelPinTypeEnum.PERMAPIN)}
            ))
          )
        )
      INNER JOIN communities c
        ON  ucs."communityId" = c.id
      INNER JOIN communities_channels cc
        ON  ucs."communityId" = cc."communityId"
        AND ucs."channelId" = cc."channelId"
      GROUP BY cc."communityId", cc."channelId", c.url, c.title, cc.title
    `;
    const result = await pool.query(query);
    return result.rows as {
      userIds: string[];
      communityId: string;
      communityUrl: string;
      communityTitle: string;
      channelId: string;
      channelUrl: string;
      channelTitle: string;
    }[];
  }
}

const messageHelper = new MessageHelper();
export default messageHelper;