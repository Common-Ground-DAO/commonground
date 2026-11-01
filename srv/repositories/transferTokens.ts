// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import pool from "../util/postgres";
import { hashTransferToken, newTransferToken } from "../util/transferLink";

/** rows are kept this long after they expired (or were used), then deleted */
const RETENTION = "1 day";

/**
 * a token is only good for a live human account, and only while the account
 * did not sign out its other devices since it was minted
 */
const LIVE_USER = `EXISTS (
  SELECT 1 FROM users u
  WHERE u."id" = t."userId" AND u."deletedAt" IS NULL AND u.is_bot = FALSE
    AND t."generation" >= u."sessionGeneration"
)`;

class TransferTokenHelper {
  /**
   * Mints a token for `userId` (always the session's own user), with the
   * minting session's generation. Returns the token itself — the only time
   * it exists outside the link.
   */
  public async create(userId: string, nextPath: string | null, ttlMs: number, generation: number): Promise<{ token: string; expiresAt: Date }> {
    await pool.query(`DELETE FROM transfer_tokens WHERE "expiresAt" < now() - interval '${RETENTION}'`);
    const token = newTransferToken();
    const result = await pool.query<{ expiresAt: Date }>(`
      INSERT INTO transfer_tokens ("userId", "tokenHash", "nextPath", "expiresAt", "generation")
      VALUES ($1, $2, $3, now() + ($4::integer * interval '1 millisecond'), $5)
      RETURNING "expiresAt"
    `, [userId, hashTransferToken(token), nextPath, ttlMs, generation]);
    return { token, expiresAt: result.rows[0].expiresAt };
  }

  /** The account a usable token belongs to, without using it up (confirmation screen). */
  public async peek(token: string): Promise<{ userId: string; expiresAt: Date } | null> {
    const result = await pool.query<{ userId: string; expiresAt: Date }>(`
      SELECT t."userId", t."expiresAt"
      FROM transfer_tokens t
      WHERE t."tokenHash" = $1
        AND t."usedAt" IS NULL
        AND t."expiresAt" > now()
        AND ${LIVE_USER}
    `, [hashTransferToken(token)]);
    return result.rows[0] ?? null;
  }

  /**
   * Uses the token up: one statement, so of two concurrent redemptions
   * exactly one gets the row. Null when unknown, expired or already used.
   */
  public async consume(token: string): Promise<{ userId: string; nextPath: string | null } | null> {
    const result = await pool.query<{ userId: string; nextPath: string | null }>(`
      UPDATE transfer_tokens t
      SET "usedAt" = now()
      WHERE t."tokenHash" = $1
        AND t."usedAt" IS NULL
        AND t."expiresAt" > now()
        AND ${LIVE_USER}
      RETURNING t."userId", t."nextPath"
    `, [hashTransferToken(token)]);
    return result.rows[0] ?? null;
  }

  /**
   * Clean-up after a sign-out of other devices: the user's unused tokens
   * below `generation` (they no longer redeem anyway) are deleted.
   */
  public async deleteStale(userId: string, generation: number): Promise<number> {
    const result = await pool.query(`
      DELETE FROM transfer_tokens
      WHERE "userId" = $1 AND "usedAt" IS NULL AND "generation" < $2
    `, [userId, generation]);
    return result.rowCount ?? 0;
  }
}

const transferTokenHelper = new TransferTokenHelper();
export default transferTokenHelper;
