// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from "../common/errors";
import pool from "../util/postgres";
import { type Pool, type PoolClient } from "pg";
import { countLoginMethods } from "./loginMethods";

// Every query is scoped to one relying party (rpId): a process only ever sees
// the credentials of its own RP ID, and a NULL rpId matches nothing
// (`"rpId" = $x` is never true for NULL).

export type PasskeyRow = {
  id: string;
  userId: string | null;
  rpId: string;
  data: Models.Passkey.FullData;
  counter: number;
  name: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  deletedAt: string | null;
};

export type NewPasskey = {
  rpId: string;
  origin: string;
  name: string | null;
  webAuthnUserID: string;
  credentialID: string;
  credentialPublicKeyBase64: string;
  credentialDeviceType: string;
  credentialBackedUp: boolean;
  transports?: Models.Passkey.FullData["transports"];
  counter: number;
};

const ROW_FIELDS = `
  "id",
  "userId",
  "rpId",
  "data",
  "counter",
  "name",
  "createdAt",
  "updatedAt",
  "lastUsedAt",
  "deletedAt"
`;

function toFullData(passkey: NewPasskey): Models.Passkey.FullData {
  // no debugData any more: the registration options/response are not kept
  return {
    webAuthnUserID: passkey.webAuthnUserID,
    credentialID: passkey.credentialID,
    credentialPublicKeyBase64: passkey.credentialPublicKeyBase64,
    credentialDeviceType: passkey.credentialDeviceType,
    credentialBackedUp: passkey.credentialBackedUp,
    transports: passkey.transports,
  };
}

/** SQL (for a CTE) + params that insert a passkey for a user created in the same statement. */
export function passkeyInsertParams(passkey: NewPasskey) {
  return [
    passkey.rpId,
    passkey.origin,
    passkey.name,
    JSON.stringify(toFullData(passkey)),
    passkey.counter,
  ];
}

function isUniqueViolation(e: unknown) {
  return !!e && typeof e === "object" && (e as { code?: string }).code === "23505";
}

class PasskeyHelper {
  public async addPasskey(userId: string, passkey: NewPasskey, db: Pool | PoolClient = pool): Promise<string> {
    try {
      const result = await db.query<{ id: string }>(`
        INSERT INTO passkeys ("userId", "rpId", "origin", "name", "data", "counter")
        VALUES ($1, $2, $3, $4, $5::jsonb, $6)
        RETURNING id
      `, [userId, ...passkeyInsertParams(passkey)]);
      return result.rows[0].id;
    }
    catch (e) {
      if (isUniqueViolation(e)) {
        throw new Error(errors.server.EXISTS_ALREADY);
      }
      throw e;
    }
  }

  /** Includes removed credentials: deletion never reopens migration setup. */
  public async hasUserPasskeys(userId: string, rpId: string, db: Pool | PoolClient = pool): Promise<boolean> {
    const result = await db.query(`SELECT 1 FROM passkeys WHERE "userId" = $1 AND "rpId" = $2 LIMIT 1`, [userId, rpId]);
    return result.rows.length > 0;
  }

  /** Serializes first-passkey setup across transfers, including concurrent inserts. */
  public async addFirstPasskey(userId: string, passkey: NewPasskey): Promise<string> {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('SELECT "id" FROM users WHERE "id" = $1 FOR UPDATE', [userId]);
      if (await this.hasUserPasskeys(userId, passkey.rpId, client)) {
        throw new Error(errors.server.REAUTH_REQUIRED);
      }
      const id = await this.addPasskey(userId, passkey, client);
      await client.query('COMMIT');
      return id;
    }
    catch (e) {
      await client.query('ROLLBACK');
      throw e;
    }
    finally {
      client.release();
    }
  }

  /** Lookup for an assertion: one credential of one RP, deleted rows included (→ DELETED). */
  public async getByCredentialId(rpId: string, credentialID: string): Promise<PasskeyRow | null> {
    const result = await pool.query<PasskeyRow>(`
      SELECT ${ROW_FIELDS}
      FROM passkeys
      WHERE "rpId" = $1
        AND "data"->>'credentialID' = $2
      ORDER BY ("deletedAt" IS NULL) DESC
      LIMIT 1
    `, [rpId, credentialID]);
    return result.rows[0] || null;
  }

  public async getById(rpId: string, id: string): Promise<PasskeyRow | null> {
    const result = await pool.query<PasskeyRow>(`
      SELECT ${ROW_FIELDS}
      FROM passkeys
      WHERE "rpId" = $1 AND "id" = $2
    `, [rpId, id]);
    return result.rows[0] || null;
  }

  /** Legacy CG ID login hand-off: the row a successful ceremony left in the session. */
  public async getByIdAnyRp(id: string): Promise<PasskeyRow | null> {
    const result = await pool.query<PasskeyRow>(`
      SELECT ${ROW_FIELDS}
      FROM passkeys
      WHERE "id" = $1
    `, [id]);
    return result.rows[0] || null;
  }

  public async listUserPasskeys(userId: string, rpId: string): Promise<PasskeyRow[]> {
    const result = await pool.query<PasskeyRow>(`
      SELECT ${ROW_FIELDS}
      FROM passkeys
      WHERE "userId" = $1
        AND "rpId" = $2
        AND "deletedAt" IS NULL
      ORDER BY "createdAt" ASC
    `, [userId, rpId]);
    return result.rows;
  }

  /**
   * The account's WebAuthn user handle for this RP: the one its existing
   * credentials use (deleted ones included, so it never changes), or null.
   */
  public async getUserHandle(userId: string, rpId: string): Promise<string | null> {
    const result = await pool.query<{ webAuthnUserID: string }>(`
      SELECT "data"->>'webAuthnUserID' AS "webAuthnUserID"
      FROM passkeys
      WHERE "userId" = $1
        AND "rpId" = $2
      ORDER BY "createdAt" ASC
      LIMIT 1
    `, [userId, rpId]);
    return result.rows[0]?.webAuthnUserID || null;
  }

  public async recordUse(id: string, counter: number): Promise<void> {
    const result = await pool.query(`
      UPDATE passkeys
      SET "counter" = GREATEST("counter", $2), "lastUsedAt" = now(), "updatedAt" = now()
      WHERE "id" = $1 AND "deletedAt" IS NULL
    `, [id, counter]);
    if (result.rowCount !== 1) {
      throw new Error(errors.server.NOT_FOUND);
    }
  }

  public async rename(userId: string, rpId: string, id: string, name: string): Promise<void> {
    const result = await pool.query(`
      UPDATE passkeys
      SET "name" = $4, "updatedAt" = now()
      WHERE "id" = $3 AND "userId" = $1 AND "rpId" = $2 AND "deletedAt" IS NULL
    `, [userId, rpId, id, name]);
    if (result.rowCount !== 1) {
      throw new Error(errors.server.NOT_FOUND);
    }
  }

  /**
   * Soft-deletes one of the user's passkeys unless it is the account's last
   * sign-in method on this instance (srv/repositories/loginMethods.ts).
   */
  public async removeUnlessLastMethod(userId: string, rpId: string, id: string, beforeCommit?: (client: PoolClient) => Promise<void>): Promise<'removed' | 'last' | 'not-found'> {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const target = await client.query(`
        SELECT "id" FROM passkeys
        WHERE "id" = $3 AND "userId" = $1 AND "rpId" = $2 AND "deletedAt" IS NULL
      `, [userId, rpId, id]);
      if (target.rowCount !== 1) {
        await client.query("ROLLBACK");
        return 'not-found';
      }
      if (await countLoginMethods(client, userId, rpId, { passkeyId: id }) === 0) {
        await client.query("ROLLBACK");
        return 'last';
      }
      await client.query(`
        UPDATE passkeys
        SET "deletedAt" = now(), "updatedAt" = now()
        WHERE "id" = $1
      `, [id]);
      // the caller's own step in the same transaction (signing out the
      // other devices: srv/util/signOutOtherDevices.ts)
      await beforeCommit?.(client);
      await client.query("COMMIT");
      return 'removed';
    }
    catch (e) {
      await client.query("ROLLBACK");
      throw e;
    }
    finally {
      client.release();
    }
  }
}

const passkeyHelper = new PasskeyHelper();
export default passkeyHelper;
