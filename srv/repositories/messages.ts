// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from "../common/errors";
import config from "../common/config";
import format from "pg-format";
import pool from "../util/postgres";
import { type Pool, type PoolClient, type QueryResult } from "pg";
import { ChannelNotificationTypeEnum, ChannelPinTypeEnum } from "../common/enums";
import fileHelper from "./files";

/** Changes a `getChanges` cursor may be behind before the answer is a reset. */
export const SYNC_MAX_CHANGES_BEHIND = 500;
/** Default (and maximum) page size of `getChanges`. */
export const SYNC_CHANGES_DEFAULT_LIMIT = 200;
/** Ceiling of every unread count (API.Messages.UnreadCap). */
export const UNREAD_CAP = 999;
/** The only cursor format the server understands: version 1, channel seq. */
const SYNC_CURSOR_PATTERN = /^1:(\d{1,18})$/;

/** columns of an ApiMessage (plus "deletedAt" on request), for `FROM messages m` */
function messageSelectColumns(options: { userId?: string; includeDeleted: boolean }) {
  return `
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
      m."syncSeq",
      ${!!options.userId
        ? `rea."reaction" AS "ownReaction"`
        : `NULL AS "ownReaction"`
      }
      ${options.includeDeleted ? ', m."deletedAt" ' : ''}
  `;
}

/** the requesting user's own reaction, joined as `rea` (needs `FROM messages m`) */
function ownReactionJoin(userId?: string) {
  return !!userId
    ? `
      LEFT JOIN reactions rea
        ON rea."itemId" = m.id
        AND rea."deletedAt" IS NULL
        AND rea."userId" = ${format("%L::UUID", userId)}`
    : ``;
}

type MessageRow = Omit<Models.Message.ApiMessage, "syncSeq"> & {
  syncSeq: string | number | null;
  deletedAt?: string | null;
};

/**
 * `syncSeq` is a bigint (a string from node-postgres) and NULL for rows not
 * written since the sync-sequence migration. The API sends a number; a NULL
 * is left out (`'omit'`) or sent as 0 (`'zero'`, older than every change).
 */
function withNumericSyncSeq<R extends MessageRow>(
  row: R,
  nullSeq: 'omit' | 'zero' = 'omit',
): Omit<R, "syncSeq"> & { syncSeq?: number } {
  const { syncSeq, ...rest } = row;
  if (syncSeq === null || syncSeq === undefined) {
    return nullSeq === 'zero' ? { ...rest, syncSeq: 0 } : rest;
  }
  return { ...rest, syncSeq: Number(syncSeq) };
}

/** a bigint from node-postgres (string) as a number; NULL -> undefined */
function seqNumber(value: string | number | null | undefined): number | undefined {
  return value === null || value === undefined ? undefined : Number(value);
}

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
      ${messageSelectColumns(options)}
    FROM messages m
    ${ownReactionJoin(options.userId)}
    WHERE
      m."channelId" = ${format("%L::UUID", options.channelId)}
      ${!options.includeDeleted ? 'AND m."deletedAt" IS NULL' : ''}
      ${options.where ? `AND ${options.where}` : ''}
    ORDER BY m."createdAt" ${options.order || 'DESC'}
    ${options.limit !== null ? `LIMIT ${+options.limit}` : ''}
  `;
  const result = await db.query<MessageRow>(query);
  return result.rows.map(row => withNumericSyncSeq(row)) as any;
}

/** pg error of a unique violation on `messages` other than the primary key */
function isMessageUniqueViolation(error: unknown): boolean {
  const e = error as { code?: string; table?: string } | null;
  return !!e && e.code === '23505' && e.table === 'messages';
}

/**
 * The stored, not deleted message `id` if it was written by `userId` in
 * `channelId`, else `undefined`. Used to answer a repeated create.
 */
async function _getOwnStoredMessage(
  db: Pool | PoolClient,
  userId: string,
  channelId: string,
  id: string,
): Promise<Models.Message.ApiMessage | undefined> {
  const [message] = await _getMessages(db, {
    userId,
    channelId,
    includeDeleted: false,
    limit: 1,
    where: format('m."id" = %L::UUID AND m."creatorId" = %L::UUID', id, userId),
  });
  return message;
}

/**
 * Inserts the message, idempotent on its client-chosen `id`: when a message
 * with that id exists already, nothing is written (not even the creator's
 * read state) and the stored message is returned with `created: false` if
 * it is the same creator's, not deleted, in the same channel; otherwise
 * NOT_ALLOWED.
 *
 * A known id is answered from a plain lookup without an INSERT: the sync
 * sequence trigger fires before ON CONFLICT is resolved, so an INSERT that
 * inserts nothing would still take a channel seq (a gap without a change).
 *
 * The insert runs in a transaction that first locks the channel's sync
 * sequence row (the lock the trigger would take anyway, taken before the
 * row's values are computed). Under that lock it checks the id again (a
 * same-id create in this channel has committed by then) and takes
 * `createdAt` = max(clock_timestamp(), the channel's newest createdAt + 1 ms),
 * so creates in one channel get distinct, increasing timestamps however
 * close together they arrive — `UNIQUE(channelId, createdAt)` at ms
 * precision. A collision is still possible with a writer that does not take
 * the lock first (an API process from before this change, during a deploy);
 * the insert is tried up to CREATE_ATTEMPTS times. ON CONFLICT (id)
 * stays for a same-id create in another channel racing this one.
 *
 * The "+ 1 ms" chain is used only while it stays within
 * CREATE_CHAIN_MAX_AHEAD_SECONDS of the clock. After the server clock was
 * ahead and then corrected, the channel's newest message lies in the future;
 * following the chain would date every new message in the future as well
 * (and `setChannelLastRead`, clamped to now(), could not mark them read), so
 * a new message then takes the clock time. The retry covers the
 * exact-millisecond collision that leaves possible.
 */
const CREATE_ATTEMPTS = 3;
const CREATE_CHAIN_MAX_AHEAD_SECONDS = 5;

async function _createMessage(
  db: Pool,
  userId: string,
  data: API.Messages.createMessage.Request
): Promise<{
  message: Models.Message.ApiMessage;
  userAlias: string;
  created: boolean;
}> {
  const existingAnswer = async () => {
    const stored = await _getOwnStoredMessage(db, userId, data.access.channelId, data.id);
    if (stored) {
      return { message: stored, userAlias: '', created: false };
    }
    throw new Error(errors.server.NOT_ALLOWED);
  };
  const known = await db.query(`SELECT 1 FROM messages WHERE "id" = $1::uuid`, [data.id]);
  if (known.rows.length > 0) {
    return existingAnswer();
  }

  const query = `
    WITH creator_data AS (
      SELECT "displayAccount", coalesce((SELECT json_agg(
        json_build_object(
          'type', ua."type",
          'displayName', ua."displayName",
          'imageId', ua."imageId"
        )
      ) from user_accounts ua WHERE ua."userId" = u."id"), '[]'::json) AS "accounts"
      FROM users u
      WHERE id = $2::uuid
    ), created_at AS (
      SELECT CASE
        WHEN n."next" <= c."clock" + interval '${CREATE_CHAIN_MAX_AHEAD_SECONDS} seconds'
        THEN GREATEST(c."clock", n."next")
        ELSE c."clock"
      END AS "at"
      FROM (SELECT clock_timestamp() AS "clock") c,
        (SELECT max(m."createdAt") + interval '1 millisecond' AS "next" FROM messages m WHERE m."channelId" = $3::uuid) n
    ), inserted AS (
      INSERT INTO messages (
        "id",
        "creatorId",
        "channelId",
        "body",
        "attachments",
        "parentMessageId",
        "createdAt",
        "updatedAt"
      ) VALUES (
        $1::uuid,
        $2::uuid,
        $3::uuid,
        $4::json,
        $5::json,
        $6::uuid,
        (SELECT "at" FROM created_at),
        (SELECT "at" FROM created_at)
      )
      ON CONFLICT ("id") DO NOTHING
      RETURNING "createdAt", "updatedAt", "id", "syncSeq"
    ), update_readstate AS (
      -- the message's own createdAt (not the transaction start), so the
      -- creator's own message never counts as unread
      INSERT INTO channelreadstate (
        "userId",
        "channelId",
        "lastRead"
      )
      SELECT $2::uuid, $3::uuid, i."createdAt"
      FROM inserted i
      ON CONFLICT ("userId", "channelId")
      DO UPDATE SET "lastRead" = GREATEST(channelreadstate."lastRead", EXCLUDED."lastRead")
    )
    SELECT
      i."createdAt",
      i."updatedAt",
      i."id",
      i."syncSeq",
      (SELECT "accounts" FROM creator_data) AS "userAccounts",
      (SELECT "displayAccount" FROM creator_data) AS "userDisplayAccount"
    FROM inserted i
  `;
  const params = [
    data.id,
    userId,
    data.access.channelId,
    JSON.stringify(data.body),
    JSON.stringify(data.attachments),
    data.parentMessageId,
  ];
  const lockChannelQuery = `
    INSERT INTO channel_sync_state AS s ("channelId", "seq")
    VALUES ($1::uuid, 0)
    ON CONFLICT ("channelId") DO UPDATE SET "seq" = s."seq" WHERE false
  `;
  let result: QueryResult | undefined;
  for (let attempt = 0; ; attempt++) {
    const client = await db.connect();
    try {
      await client.query('BEGIN');
      // locks the row even though the WHERE false updates nothing
      await client.query(lockChannelQuery, [data.access.channelId]);
      const raced = await client.query(`SELECT 1 FROM messages WHERE "id" = $1::uuid`, [data.id]);
      result = raced.rows.length > 0 ? undefined : await client.query(query, params);
      await client.query('COMMIT');
      break;
    }
    catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if (!isMessageUniqueViolation(error) || attempt + 1 >= CREATE_ATTEMPTS) {
        throw error;
      }
    }
    finally {
      client.release();
    }
  }
  if (result && result.rows.length === 1) {
    const row = result.rows[0] as {
      createdAt: string;
      updatedAt: string;
      id: string;
      syncSeq: string | null;
      userAccounts: Models.User.ProfileItem[];
      userDisplayAccount: Models.User.ProfileItemType | null;
    };
    const { userAccounts, userDisplayAccount, syncSeq, ...messageData } = row;
    const message: Models.Message.ApiMessage = {
      ...messageData,
      creatorId: userId,
      channelId: data.access.channelId,
      body: data.body,
      attachments: data.attachments || [],
      parentMessageId: data.parentMessageId,
      reactions: {},
      ownReaction: null,
      editedAt: null,
      syncSeq: seqNumber(syncSeq),
    }

    let userAlias = '';
    if (userDisplayAccount) {
      userAlias = userAccounts.find(acc => acc.type === userDisplayAccount)?.displayName || userAlias;
    }

    return {
      message,
      userAlias,
      created: true,
    };
  }
  // a concurrent create with the same id won the race
  return existingAnswer();
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
      RETURNING "updatedAt", "editedAt", "syncSeq"
    `;
    const result = await db.query(query, params);
    if (result.rows.length === 1) {
      const row = result.rows[0] as { updatedAt: string, editedAt: string, syncSeq: string | null };
      return { updatedAt: row.updatedAt, editedAt: row.editedAt, syncSeq: seqNumber(row.syncSeq) };
    }
  }
  throw new Error(errors.server.NOT_ALLOWED);
}

/**
 * Soft-deletes messages of one creator in one channel: either all of them, or
 * the single message `messageId`. The channel is always part of the filter.
 *
 * The soft delete writes several rows (the messages, their reaction rows and
 * the replies whose parent goes away), and every message write also takes
 * the channel's sync-sequence row (trigger). The other writers lock in this
 * order: reactions (set/unsetReaction) -> message row -> sequence row, and a
 * new reply or a changed parentMessageId takes the sequence row first and
 * then FOR KEY SHARE on the parent (foreign key check). So the delete, in one
 * transaction:
 * 1. selects its targets (no lock);
 * 2. locks the targets' reaction rows (FOR UPDATE, key order);
 * 3. locks the targets and their replies FOR NO KEY UPDATE (id order) —
 *    the strength an UPDATE of non-key columns takes, which does not block
 *    the KEY SHARE of a concurrent reply insert;
 * 4. writes exactly the rows locked in 3, so it never waits for a row lock
 *    while holding the sequence row. A reply committed after step 3 keeps
 *    its parentMessageId (the same outcome as a reply committed after the
 *    delete).
 */
async function _deleteMessages(
  db: Pool,
  where: {
    creatorId: string;
    channelId: string;
    messageId?: string;
  }
) {
  if (!where.creatorId || !where.channelId) {
    throw new Error(errors.server.INVALID_REQUEST);
  }
  const targetParams: any[] = [where.creatorId, where.channelId];
  if (where.messageId !== undefined) {
    targetParams.push(where.messageId);
  }
  const targetQuery = `
    SELECT m.id FROM messages m
    WHERE m."creatorId" = $1
      AND m."channelId" = $2
      AND m."deletedAt" IS NULL
      ${where.messageId !== undefined ? 'AND m."id" = $3' : ''}
    ORDER BY m.id
  `;
  const reactionLockQuery = `
    SELECT 1 FROM reactions
    WHERE "itemId" = ANY($1::uuid[])
    ORDER BY "userId", "itemId"
    FOR UPDATE
  `;
  const messageLockQuery = `
    SELECT id, "parentMessageId", "deletedAt"
    FROM messages
    WHERE id = ANY($1::uuid[])
      OR "parentMessageId" = ANY($1::uuid[])
    ORDER BY id
    FOR NO KEY UPDATE
  `;
  const query = `
    WITH removed_messages AS (
      UPDATE messages m
      SET "updatedAt" = NOW(),
        "deletedAt" = NOW(),
        "reactions" = '{}'::jsonb
      WHERE m."creatorId" = $1
        AND m."channelId" = $2
        AND m."deletedAt" IS NULL
        AND m."id" = ANY($3::uuid[])
      RETURNING m.id, m."syncSeq"
    ), removed_message_reactions AS (
      UPDATE reactions r
      SET "updatedAt" = NOW(), "deletedAt" = NOW()
      FROM removed_messages rm
      WHERE r."itemId" = rm.id
    ), cleaned_parent_messages AS (
      UPDATE messages
      SET "parentMessageId" = NULL, "updatedAt" = NOW()
      WHERE "id" = ANY($4::uuid[])
      AND "parentMessageId" = ANY(SELECT id FROM removed_messages)
      RETURNING "id", "syncSeq"
    )
    SELECT json_build_object(
      'deleted', COALESCE((SELECT json_agg(json_build_object('id', "id", 'syncSeq', "syncSeq")) FROM removed_messages), '[]'::json),
      'updatedParents', COALESCE((SELECT json_agg(json_build_object('id', "id", 'syncSeq', "syncSeq")) FROM cleaned_parent_messages), '[]'::json),
      'dbNow', NOW()
    ) AS "deleteData"
  `;
  const client = await db.connect();
  let result;
  try {
    await client.query('BEGIN');
    const targetIds = (await client.query<{ id: string }>(targetQuery, targetParams)).rows.map(row => row.id);
    if (targetIds.length > 0) {
      await client.query(reactionLockQuery, [targetIds]);
      const locked = (await client.query<{ id: string, parentMessageId: string | null, deletedAt: Date | null }>(messageLockQuery, [targetIds])).rows;
      const targets = new Set(targetIds);
      // rows as they are now that they are locked (a concurrent delete may have won)
      const removedIds = locked.filter(row => targets.has(row.id) && row.deletedAt === null).map(row => row.id);
      const removed = new Set(removedIds);
      const replyIds = locked
        .filter(row => !removed.has(row.id) && row.parentMessageId !== null && removed.has(row.parentMessageId))
        .map(row => row.id);
      if (removedIds.length > 0) {
        result = await client.query(query, [where.creatorId, where.channelId, removedIds, replyIds]);
      }
    }
    await client.query('COMMIT');
  }
  catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  }
  finally {
    client.release();
  }
  if (!result) {
    return {
      deletedIds: [] as string[],
      deletedSyncSeqs: [] as number[],
      updatedParentIdToNull: [] as string[],
      updatedParents: [] as { id: string, syncSeq: number | undefined }[],
      dbNow: new Date().toISOString(),
    };
  }
  if (result.rows.length !== 1) {
    throw new Error("Query did not return 1 row");
  }
  const data = result.rows[0].deleteData as {
    deleted: { id: string, syncSeq: number | null }[],
    updatedParents: { id: string, syncSeq: number | null }[],
    dbNow: string,
  };
  return {
    deletedIds: data.deleted.map(d => d.id),
    /** syncSeq of every deleted row (the delete is a write, so each has one) */
    deletedSyncSeqs: data.deleted.map(d => d.syncSeq).filter((s): s is number => s !== null),
    updatedParentIdToNull: data.updatedParents.map(d => d.id),
    /** the replies whose parent was deleted, with their new syncSeq */
    updatedParents: data.updatedParents.map(d => ({ id: d.id, syncSeq: d.syncSeq ?? undefined })),
    dbNow: data.dbNow,
  };
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
    RETURNING "updatedAt", "reactions", "syncSeq"
  `;
  const result = await db.query(query, [
    userId,
    data.messageId,
    data.reaction,
    data.access.channelId
  ]);
  if (result.rows.length === 1) {
    const row = result.rows[0] as { updatedAt: string, reactions: Models.Message.ApiMessage["reactions"], syncSeq: string | null };
    return { updatedAt: row.updatedAt, reactions: row.reactions, syncSeq: seqNumber(row.syncSeq) };
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
    RETURNING "channelId", "reactions", "updatedAt", "syncSeq"
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
    const row = result.rows[0] as { channelId: string, reactions: Models.Message.ApiMessage["reactions"], updatedAt: string, syncSeq: string | null };
    return { channelId: row.channelId, reactions: row.reactions, updatedAt: row.updatedAt, syncSeq: seqNumber(row.syncSeq) };
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

  /**
   * Idempotent on `data.id`: `created: false` means the same creator stored
   * this message in this channel before (a retry); see `_createMessage`.
   */
  public async createMessage(
    userId: string,
    data: API.Messages.createMessage.Request
  ): Promise<{
    message: Models.Message.ApiMessage;
    userAlias: string;
    created: boolean;
  }> {
    await this.ensureAttachmentMetadata(data);
    return _createMessage(pool, userId, data);
  }

  /**
   * The not deleted message `id` if `userId` wrote it in `channelId`. Lets a
   * repeated create succeed when a precondition of a first create (such as
   * its parent message) is gone by the time it is retried.
   */
  public async getOwnStoredMessage(
    userId: string,
    channelId: string,
    id: string,
  ): Promise<Models.Message.ApiMessage | undefined> {
    return _getOwnStoredMessage(pool, userId, channelId, id);
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
   * ahead cannot mark messages that do not exist yet as read. With
   * `messageId` of a message in the channel, that message's `createdAt`
   * (database clock) is used instead of `lastRead`.
   *
   * Returns the stored (effective) value as an ISO string, the number of
   * other users' messages after it (capped at UNREAD_CAP) and the channel's
   * sync sequence, all from the same statement: the count includes every
   * message with `syncSeq <= syncSeq` and none above it.
   */
  public async setChannelLastRead(
    userId: string,
    data: API.Messages.setChannelLastRead.Request,
  ): Promise<{ lastRead: string, unread: number, syncSeq: number }> {
    const result = await pool.query<{ lastRead: Date | string, unread: number, syncSeq: string }>(`
      WITH upsert AS (
        INSERT INTO channelreadstate (
          "userId",
          "channelId",
          "lastRead"
        )
        VALUES ($1, $2, LEAST(
          COALESCE(
            (SELECT m."createdAt" FROM messages m WHERE m."id" = $4::uuid AND m."channelId" = $2::uuid),
            $3::timestamptz
          ),
          now()
        ))
        ON CONFLICT ("userId", "channelId")
        DO UPDATE SET "lastRead" = GREATEST(channelreadstate."lastRead", EXCLUDED."lastRead")
        RETURNING "lastRead"
      )
      SELECT
        u."lastRead",
        (
          SELECT count(*)::int FROM (
            SELECT 1 FROM messages m
            WHERE m."channelId" = $2::uuid
              AND m."deletedAt" IS NULL
              AND m."createdAt" > u."lastRead"
              AND m."creatorId" <> $1::uuid
            LIMIT ${UNREAD_CAP}
          ) capped
        ) AS "unread",
        COALESCE((SELECT s."seq" FROM channel_sync_state s WHERE s."channelId" = $2::uuid), 0) AS "syncSeq"
      FROM upsert u
    `, [
      userId,
      data.access.channelId,
      data.lastRead,
      data.messageId ?? null,
    ]);
    const row = result.rows[0];
    return {
      lastRead: new Date(row.lastRead).toISOString(),
      unread: row.unread,
      syncSeq: Number(row.syncSeq),
    };
  }

  /**
   * Message changes of one channel after a sync cursor (Message/getChanges,
   * contract in common/types/api/messages.d.ts). The channel sequence and
   * the rows are read in one statement, so they come from one snapshot; the
   * trigger makes writers of a channel commit in sequence order, so that
   * snapshot holds every change up to the sequence it shows.
   */
  public async getChanges(
    userId: string | undefined,
    data: API.Messages.getChanges.Request,
  ): Promise<API.Messages.getChanges.Response> {
    const channelId = data.access.channelId;
    const limit = data.limit ?? SYNC_CHANGES_DEFAULT_LIMIT;
    const cursorMatch = data.cursor === null ? null : SYNC_CURSOR_PATTERN.exec(data.cursor);
    if (cursorMatch) {
      const cursorSeq = BigInt(cursorMatch[1]);
      // no rows at all when the cursor is ahead or too far behind (-> reset)
      const result = await pool.query<MessageRow & { channelSeq: string, serverTime: Date, deletedAt: string | null }>(`
        WITH state AS (
          SELECT COALESCE((SELECT s."seq" FROM channel_sync_state s WHERE s."channelId" = $1::uuid), 0) AS "seq"
        )
        SELECT st."seq" AS "channelSeq", now() AS "serverTime", c.*
        FROM state st
        LEFT JOIN LATERAL (
          SELECT ${messageSelectColumns({ userId, includeDeleted: true })}
          FROM messages m
          ${ownReactionJoin(userId)}
          WHERE m."channelId" = $1::uuid
            AND m."syncSeq" > $2::bigint
            AND $2::bigint <= st."seq"
            AND st."seq" - $2::bigint <= $4::bigint
          ORDER BY m."syncSeq" ASC
          LIMIT $3
        ) c ON true
        ORDER BY c."syncSeq" ASC
      `, [channelId, cursorSeq.toString(), limit + 1, SYNC_MAX_CHANGES_BEHIND]);
      const first = result.rows[0];
      const channelSeq = BigInt(first.channelSeq);
      if (cursorSeq <= channelSeq && channelSeq - cursorSeq <= BigInt(SYNC_MAX_CHANGES_BEHIND)) {
        const changes = result.rows.filter(row => row.id !== null);
        const hasMore = changes.length > limit;
        const page = hasMore ? changes.slice(0, limit) : changes;
        const upTo = hasMore ? BigInt(page[page.length - 1].syncSeq as string) : channelSeq;
        const messages: API.Messages.getChanges.Response["messages"] = [];
        const deletedIds: string[] = [];
        for (const row of page) {
          const { channelSeq: _channelSeq, serverTime: _serverTime, deletedAt, ...message } = row;
          if (deletedAt) {
            deletedIds.push(message.id);
          }
          else {
            messages.push(withNumericSyncSeq(message) as API.Messages.getChanges.Response["messages"][number]);
          }
        }
        return {
          cursor: `1:${upTo.toString()}` as API.Messages.SyncCursor,
          syncSeq: Number(upTo),
          reset: false,
          hasMore,
          serverTime: new Date(first.serverTime).toISOString(),
          messages,
          deletedIds,
        };
      }
    }
    return this.getResetPage(userId, channelId);
  }

  /** the latest page of a channel and the channel sequence, from one snapshot */
  private async getResetPage(
    userId: string | undefined,
    channelId: string,
  ): Promise<API.Messages.getChanges.Response> {
    const result = await pool.query<MessageRow & { channelSeq: string, serverTime: Date }>(`
      WITH state AS (
        SELECT COALESCE((SELECT s."seq" FROM channel_sync_state s WHERE s."channelId" = $1::uuid), 0) AS "seq"
      )
      SELECT st."seq" AS "channelSeq", now() AS "serverTime", p.*
      FROM state st
      LEFT JOIN LATERAL (
        SELECT ${messageSelectColumns({ userId, includeDeleted: false })}
        FROM messages m
        ${ownReactionJoin(userId)}
        WHERE m."channelId" = $1::uuid
          AND m."deletedAt" IS NULL
        ORDER BY m."createdAt" DESC
        LIMIT $2
      ) p ON true
      ORDER BY p."createdAt" DESC
    `, [channelId, config.ITEMLIST_BATCH_SIZE]);
    const first = result.rows[0];
    const channelSeq = BigInt(first.channelSeq);
    const messages = result.rows
      .filter(row => row.id !== null)
      .map(({ channelSeq: _channelSeq, serverTime: _serverTime, ...message }) =>
        // rows not written since the migration: 0, older than every change
        withNumericSyncSeq(message, 'zero') as API.Messages.getChanges.Response["messages"][number]);
    return {
      cursor: `1:${channelSeq.toString()}` as API.Messages.SyncCursor,
      syncSeq: Number(channelSeq),
      reset: true,
      hasMore: false,
      serverTime: new Date(first.serverTime).toISOString(),
      messages,
      deletedIds: [],
    };
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