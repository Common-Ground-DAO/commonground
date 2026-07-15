// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { isMainThread } from 'worker_threads';
import pool from '../util/postgres';

if (isMainThread) {
  throw new Error("OnlineStatusCheck can only be run as a worker job");
}

async function setStaleUsersToOffline() {
  const result = await pool.query(`
    WITH stale_users AS (
      UPDATE users
      SET
        "onlineStatus" = 'offline',
        "updatedAt" = now(),
        "onlineStatusUpdatedAt" = now()
      WHERE "onlineStatusUpdatedAt" < now() - interval '90s'
        AND "onlineStatus" <> 'offline'
      RETURNING id
    ), reset_bot_presence AS (
      UPDATE bots b
      SET "connectedSocketCount" = 0
      FROM stale_users stale
      WHERE b."userId" = stale.id
        AND b."connectedSocketCount" <> 0
      RETURNING b."userId"
    )
    SELECT id FROM stale_users
  `);
  const updatedUserIds = (result.rows as {
    id: string;
  }[]).map(d => d.id);
  return {
    updatedUserIds,
  };
}

(async () => {
    const { updatedUserIds } = await setStaleUsersToOffline();
    if (updatedUserIds.length > 0) {
        console.log("Setting userIds to offline due to > 90s stale: ", JSON.stringify(updatedUserIds));
    }
})();
