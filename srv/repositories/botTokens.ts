// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { createHash, randomBytes } from "node:crypto";
import errors from "../common/errors";
import serverconfig from "../serverconfig";
import pool from "../util/postgres";
import botHelper from "./bots";

export type BotTokenPrincipal = {
  kind: 'bot-token';
  user: { id: string; deviceId: string };
  tokenId: string;
};

const TOKEN_PATTERN = /^cgb_[A-Za-z0-9_-]{43}$/;
const LAST_USED_WRITE_INTERVAL_MS = 5 * 60 * 1000;

function _hashToken(token: string) {
  return createHash('sha256').update(token).digest('hex');
}

function _newRawToken() {
  return `cgb_${randomBytes(32).toString('base64url')}`;
}

class BotTokenHelper {
  public async issueToken(
    actorUserId: string,
    botUserId: string,
    name: string | null,
  ): Promise<API.Bot.issueToken.Response> {
    const rawToken = _newRawToken();
    const tokenHash = _hashToken(rawToken);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await botHelper.assertCanManageBot(client, actorUserId, botUserId, true);
      await client.query(`SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`, [`bot-tokens:${botUserId}`]);
      const count = await client.query<{ count: string }>(`
        SELECT count(*)::text AS count
        FROM bot_tokens
        WHERE "botUserId" = $1 AND "revokedAt" IS NULL
      `, [botUserId]);
      if (Number(count.rows[0].count) >= serverconfig.BOT_ACTIVE_TOKEN_LIMIT) {
        throw new Error(errors.server.NOT_ALLOWED);
      }
      const inserted = await client.query<API.Bot.TokenView>(`
        INSERT INTO bot_tokens ("botUserId", "tokenHash", name)
        VALUES ($1, $2, $3)
        RETURNING id, "botUserId", name, "lastUsedAt", "createdAt", "revokedAt"
      `, [botUserId, tokenHash, name]);
      await client.query('COMMIT');
      return { token: rawToken, tokenData: inserted.rows[0] };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async listTokens(actorUserId: string, botUserId: string): Promise<API.Bot.TokenView[]> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await botHelper.assertCanManageBot(client, actorUserId, botUserId, false);
      const result = await client.query<API.Bot.TokenView>(`
        SELECT id, "botUserId", name, "lastUsedAt", "createdAt", "revokedAt"
        FROM bot_tokens
        WHERE "botUserId" = $1
        ORDER BY "createdAt", id
      `, [botUserId]);
      await client.query('COMMIT');
      return result.rows;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async revokeToken(actorUserId: string, botUserId: string, tokenId: string): Promise<void> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await botHelper.assertCanManageBot(client, actorUserId, botUserId, false);
      const result = await client.query(`
        UPDATE bot_tokens
        SET "revokedAt" = now()
        WHERE id = $1 AND "botUserId" = $2 AND "revokedAt" IS NULL
        RETURNING id
      `, [tokenId, botUserId]);
      if (result.rowCount !== 1) throw new Error(errors.server.NOT_FOUND);
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }

  public async authenticate(rawToken: string): Promise<BotTokenPrincipal | null> {
    if (!TOKEN_PATTERN.test(rawToken)) return null;
    const tokenHash = _hashToken(rawToken);
    const result = await pool.query<{
      tokenId: string;
      userId: string;
      deviceId: string;
      lastUsedAt: string | null;
    }>(`
      SELECT
        bt.id AS "tokenId",
        b."userId",
        b."deviceId",
        bt."lastUsedAt"
      FROM bot_tokens bt
      INNER JOIN bots b
        ON b."userId" = bt."botUserId"
        AND b."deletedAt" IS NULL
      INNER JOIN users u
        ON u.id = b."userId"
        AND u.is_bot = TRUE
        AND u."deletedAt" IS NULL
      INNER JOIN devices d
        ON d.id = b."deviceId"
        AND d."userId" = b."userId"
        AND d."deletedAt" IS NULL
      WHERE bt."tokenHash" = $1
        AND bt."revokedAt" IS NULL
        AND (
          b."ownerType" = 'platform'
          OR (
            b."ownerType" = 'user'
            AND EXISTS (
              SELECT 1
              FROM users owner_user
              WHERE owner_user.id = b."ownerId"
                AND owner_user.is_bot = FALSE
                AND owner_user."deletedAt" IS NULL
                AND owner_user."platformBan" IS NULL
            )
          )
          OR (
            b."ownerType" = 'community'
            AND EXISTS (
              SELECT 1
              FROM communities owner_community
              WHERE owner_community.id = b."ownerId"
                AND owner_community."deletedAt" IS NULL
            )
          )
        )
    `, [tokenHash]);
    if (result.rowCount !== 1) return null;
    const row = result.rows[0];
    if (!row.lastUsedAt || Date.now() - new Date(row.lastUsedAt).getTime() >= LAST_USED_WRITE_INTERVAL_MS) {
      await pool.query(`
        UPDATE bot_tokens
        SET "lastUsedAt" = now()
        WHERE id = $1
          AND "revokedAt" IS NULL
          AND ("lastUsedAt" IS NULL OR "lastUsedAt" < now() - interval '5 minutes')
      `, [row.tokenId]);
    }
    return {
      kind: 'bot-token',
      user: { id: row.userId, deviceId: row.deviceId },
      tokenId: row.tokenId,
    };
  }
}

const botTokenHelper = new BotTokenHelper();
export default botTokenHelper;
