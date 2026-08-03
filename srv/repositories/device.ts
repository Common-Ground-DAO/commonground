// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { webcrypto } from "node:crypto";
import errors from "../common/errors";
import pool from "../util/postgres";
import { type Pool, type PoolClient } from "pg";
import format from "pg-format";

async function _createDevice(
  db: Pool | PoolClient,
  userId: string,
  publicKey: any
): Promise<{ deviceId: string }> {
  const query = `
    INSERT INTO devices ("userId", "publicKey")
    VALUES ($1, $2)
    RETURNING "id" AS "deviceId"
  `;
  const result = await db.query(query, [userId, publicKey]);
  if (result.rows.length === 1) {
    return result.rows[0] as { deviceId: string };
  }
  throw new Error(errors.server.INVALID_REQUEST);
}

async function _deleteDevice(
  db: Pool | PoolClient,
  deviceId: string
) {
  const query = `
    UPDATE devices
    SET
      "deletedAt" = NOW(),
      "updatedAt" = NOW(),
      "webPushSubscription" = NULL
    WHERE "id" = $1
  `;
  const result = await db.query(query, [deviceId]);
  if (result.rowCount !== 1) {
    throw new Error(errors.server.NOT_FOUND);
  }
}

async function _updateDeviceInfo(
  db: Pool | PoolClient,
  deviceId: string,
  deviceInfo: Partial<Common.DeviceInfo>
) {
  let wrappedJsonbSet = '"deviceInfo"';

  const setStrings: string[] = [];
  if (deviceInfo.deviceBrowser !== undefined)
    wrappedJsonbSet = `jsonb_set(${wrappedJsonbSet}, '{"deviceBrowser"}', ${format("%L::jsonb", JSON.stringify(deviceInfo.deviceBrowser))})`;
  if (deviceInfo.deviceOS !== undefined)
    wrappedJsonbSet = `jsonb_set(${wrappedJsonbSet}, '{"deviceOS"}', ${format("%L::jsonb", JSON.stringify(deviceInfo.deviceOS))})`;
  if (deviceInfo.webPushConfirmationCode !== undefined)
    wrappedJsonbSet = `jsonb_set(${wrappedJsonbSet}, '{"webPushConfirmationCode"}', ${format("%L::jsonb", JSON.stringify(deviceInfo.webPushConfirmationCode))})`;
  if (deviceInfo.webPushConfirmed !== undefined)
    wrappedJsonbSet = `jsonb_set(${wrappedJsonbSet}, '{"webPushConfirmed"}', ${format("%L::jsonb", JSON.stringify(deviceInfo.webPushConfirmed))})`;

  setStrings.push(`"deviceInfo" = ${wrappedJsonbSet}`);

  const query = `
    UPDATE devices
    SET
      "updatedAt" = NOW(), ${setStrings.join(", ")}
    WHERE "id" = $1
  `;
  const result = await db.query(query, [deviceId]);
  if (result.rowCount !== 1) {
    throw new Error(errors.server.NOT_FOUND);
  }
}

async function _getDeviceData(
  db: Pool | PoolClient,
  deviceId: string
) {
  const query = `
    SELECT
      "publicKey",
      "userId",
      "webPushSubscription"
    FROM devices
    WHERE "id" = $1 AND "deletedAt" IS NULL
  `;
  const result = await db.query(query, [deviceId]);
  if (result.rows.length === 1) {
    return result.rows[0] as {
      userId: string;
      publicKey: any;
      webPushSubscription: Models.Notification.PushSubscription | null;
    };
  }
  throw new Error(errors.server.NOT_FOUND);
}

class DeviceHelper {
  public async createDevice(
    userId: string,
    publicKey: JsonWebKey
  ): Promise<{
    deviceId: string;
  }> {
    return await _createDevice(pool, userId, publicKey);
  }

  public async deleteDevice(
    deviceId: string
  ): Promise<void> {
    await _deleteDevice(pool, deviceId);
  }

  public async updateDeviceInfo(
    deviceId: string,
    deviceInfo: Partial<Common.DeviceInfo>
  ): Promise<void> {
    await _updateDeviceInfo(pool, deviceId, deviceInfo);
  }

  public async verifyDeviceAndGetUserId(
    deviceId: string,
    secret: string,
    base64Signature: string
  ): Promise<{
    userId: string;
    webPushSubscription: Models.Notification.PushSubscription | null;
  }> {
    const data = await _getDeviceData(pool, deviceId);
    const encoder = new TextEncoder();
    const signedData = encoder.encode(secret);
    const buffer = Buffer.from(base64Signature, 'base64');
    const signature = new Uint8Array(buffer.buffer, buffer.byteOffset, buffer.byteLength);
    const key = await webcrypto.subtle.importKey(
      "jwk",
      data.publicKey,
      {
        name: "ECDSA",
        namedCurve: "P-384"
      },
      false,
      ["verify"]
    );
    const valid = await webcrypto.subtle.verify(
      {
        name: "ECDSA",
        hash: "SHA-384"
      },
      key,
      signature,
      signedData
    );
    if (!valid) {
      throw new Error(errors.server.INVALID_SIGNATURE);
    }
    return {
      userId: data.userId,
      webPushSubscription: data.webPushSubscription,
    };
  }

  public async deviceLoggedIn(deviceId: string) {
    await pool.query(`
      UPDATE devices
      SET "updatedAt" = now()
      WHERE id = $1
    `, [deviceId]);
  }
}

const deviceHelper = new DeviceHelper();
export default deviceHelper;