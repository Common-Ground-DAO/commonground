// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import format from "pg-format";
import errors from "../common/errors";
import pool from "../util/postgres";
import { type Pool, type PoolClient } from "pg";

async function _getChats(
  db: Pool | PoolClient,
  where: string,
  userId: string | undefined
) {
  const result = await db.query(`
    SELECT
      c."id",
      c."channelId",
      c."userIds",
      c."adminIds",
      c."createdAt",
      c."updatedAt"
      ${!!userId 
        ? `,
        chrs."lastRead",
        (
          SELECT count(*)
          FROM messages m
          WHERE m."channelId" = c."channelId"
            AND m."deletedAt" IS NULL
            AND (
              chrs."lastRead" IS NULL
              OR m."createdAt" > chrs."lastRead"
            )
        )::int AS "unread",
        (
          SELECT json_build_object(
              'id', m."id",
              'creatorId', m."creatorId",
              'channelId', m."channelId",
              'body', m."body",
              'attachments', m."attachments",
              'createdAt', m."createdAt",
              'editedAt', m."editedAt",
              'updatedAt', m."updatedAt",
              'parentMessageId', m."parentMessageId",
              'reactions', m."reactions",
              'ownReaction', rea."reaction"
            )
          FROM messages m
          LEFT JOIN reactions rea
            ON rea."itemId" = m.id
            AND rea."deletedAt" IS NULL
            AND rea."userId" = ${format("%L::UUID", userId)}
          WHERE m."channelId" = c."channelId"
            AND m."deletedAt" IS NULL
          ORDER BY m."createdAt" DESC
          LIMIT 1
        ) as "lastMessage"`
        : ',now() AS "lastRead", 0::int AS "unread"'
      }
    FROM chats c
    ${!!userId
      ? `
      LEFT JOIN channelreadstate chrs
        ON chrs."channelId" = c."channelId"
        AND chrs."userId" = ${format("%L::UUID", userId)}
      `
      : ''
    }
    WHERE c."deletedAt" IS NULL
      AND ${where}
  `);
  return result.rows as {
    id: string;
    channelId: string;
    userIds: string[];
    adminIds: string[];
    createdAt: string;
    updatedAt: string;
    unread: number;
    lastRead: string | null;
    lastMessage: {
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
    } | null;
  }[];
}

async function _createChat(
  db: Pool | PoolClient,
  userIds: string[]
) {
  const query = `
    WITH insert_channel AS (
      INSERT INTO channels
      DEFAULT VALUES
      RETURNING "id"
    )
    INSERT INTO chats (
      "channelId",
      "userIds",
      "adminIds"
    ) VALUES (
      (SELECT "id" FROM insert_channel),
      $1,
      $2
    ) RETURNING
      "id",
      "channelId",
      "userIds",
      "adminIds",
      "createdAt",
      "updatedAt"
  `;
  const result = await db.query(query, [
    userIds,
    []
  ])
  if (result.rows.length === 1) {
    return result.rows[0] as {
      id: string;
      channelId: string;
      userIds: string[];
      adminIds: string[];
      createdAt: string;
      updatedAt: string;
    };
  }
  throw new Error(errors.server.NOT_ALLOWED);
}

async function _isUserInChat(
  db: Pool | PoolClient,
  userId: string,
  chatId: string
) {
  const result = await db.query(`
    SELECT 1 FROM chats
    WHERE id = $1
      AND "userIds" @> ${format('ARRAY[%L::UUID]', userId)}
  `, [chatId]);
  return result.rows.length === 1;
}

class ChatHelper {
  public async createChat(
    userId: string,
    data: API.Chat.startChat.Request
  ): Promise<API.Chat.startChat.Response> {
    const userIds = [userId, data.otherUserId];

    // check if mutual follower relationship exists
    const followerRows = await pool.query(`
      SELECT count(*) FROM followers
      WHERE "deletedAt" IS NULL AND (
        ("userId" = $1 AND "otherUserId" = $2) OR ("userId" = $2 AND "otherUserId" = $1)
      )
    `, userIds);
    if (followerRows.rows[0].count !== '2') {
      throw new Error(errors.server.NOT_ALLOWED);
    }

    // restore chat if it has been deleted
    const deletedChat = await pool.query(format(`
      SELECT c."id" FROM chats c
      WHERE c."userIds" @> ARRAY[%L]::UUID[]
        AND c."userIds" <@ ARRAY[%L]::UUID[]
        AND c."deletedAt" IS NOT NULL
    `, userIds, userIds));
    if (deletedChat.rows.length > 0) {
      // restore the chat
      await pool.query(format(`
        UPDATE chats
        SET "deletedAt" = NULL
        WHERE id = %L::uuid
      `, deletedChat.rows[0].id));
    }

    // check if chat already exists and return it
    const existing = await _getChats(
      pool,
      format(`
        c."userIds" @> ARRAY[%L]::UUID[]
        AND c."userIds" <@ ARRAY[%L]::UUID[]
      `, userIds, userIds),
      userId,
    );
    if (existing.length > 0) {
      const item = existing[0];
      if (item.lastRead === null) {
        await pool.query(`
          INSERT INTO channelreadstate ("channelId", "userId", "lastRead")
          VALUES ${format("(%L::UUID, %L::UUID, %L::TIMESTAMPTZ)", item.channelId, userId, item.createdAt)}
          ON CONFLICT ("channelId", "userId") DO UPDATE SET "lastRead" = GREATEST(channelreadstate."lastRead", EXCLUDED."lastRead")
        `);
      }
      return {
        ...item,
        lastRead: item.lastRead || item.createdAt,
      };
    }
    const result = await _createChat(pool, [userId, data.otherUserId]);
    return {
      ...result,
      lastRead: result.createdAt,
      lastMessage: null,
    };
  }

  public async getChats(userId: string): Promise<API.Chat.getChats.Response> {
    const result = await _getChats(pool, format(`
      c."userIds" @> ARRAY[%L]::UUID[]
    `, [userId]), userId);
    const inserts: string[] = [];
    for (const chat of result) {
      if (chat.lastRead === null) {
        chat.lastRead = chat.createdAt;
        inserts.push(format("(%L::UUID, %L::UUID, %L::TIMESTAMPTZ)", chat.channelId, userId, chat.createdAt))
      }
    }
    if (inserts.length > 0) {
      await pool.query(`
        INSERT INTO channelreadstate ("channelId", "userId", "lastRead")
        VALUES ${inserts.join(',')}
        ON CONFLICT ("channelId", "userId") DO UPDATE SET "lastRead" = GREATEST(channelreadstate."lastRead", EXCLUDED."lastRead")
      `);
    }
    return result as (typeof result[0] & {
      lastRead: string;
    })[];
  }

  public async getChatById(chatId: string) {
    const chats = await _getChats(pool, format(`
      c."id" = %L::uuid
    `, chatId), undefined);
    if (chats.length === 1) {
      return chats[0];
    }
    else {
      throw new Error(errors.server.NOT_FOUND);
    }
  }

  public async getChatByChannelId(channelId: string) {
    const chats = await _getChats(pool, format(`
      c."channelId" = %L::uuid
    `, channelId), undefined);
    if (chats.length === 1) {
      return chats[0];
    }
    else {
      return undefined;
    }
  }

  public async closeChat(userId: string, chatId: string) {
    await pool.query(format(`
      UPDATE chats
      SET "deletedAt" = NOW()
      WHERE id = %L::uuid
    `, chatId));
  }

  public async isUserInChat(userId: string, chatId: string): Promise<boolean> {
    return await _isUserInChat(pool, userId, chatId);
  }
}

const chatHelper = new ChatHelper();
export default chatHelper;