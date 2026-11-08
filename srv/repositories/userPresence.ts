// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Small, dependency-light part of the user repository: the notify-target
 * query used by every user-data event in `users.ts`, and the presence writes
 * the `onlineStatusCheck` job needs (which therefore does not load all of
 * `users.ts` every 30 s).
 */

import format from "pg-format";
import pool from "../util/postgres";
import eventHelper from "./event";
import { PredefinedRole, RoleType } from "../common/enums";

export type UserWithNotifyIds = {
  userId: string;
  updatedAt: string;
  communityIds: string[];
};

/**
 * Selects, for every id in the CTE `cteName`, the user id, `now()` and the
 * communities the user is a member of (the targets of `cliUserData`).
 */
export function userWithNotifyIdsQuery(cteName: string) {
  return `
    SELECT
      u.id AS "userId",
      now() AS "updatedAt",
      COALESCE(
        (
          SELECT json_agg(r."communityId")
          FROM roles_users_users ruu
          INNER JOIN roles r
            ON ruu."roleId" = r."id"
            AND r."type" = ${format("%L", RoleType.PREDEFINED)}
            AND r."title" = ${format("%L", PredefinedRole.Member)}
          WHERE ruu."userId" = u."id"
        ),
        '[]'::json
      ) AS "communityIds"
    FROM users u
    WHERE u.id = ANY((SELECT id FROM ${cteName}))
  `;
}

/** `cliUserData {onlineStatus: 'offline'}` for users whose status was just changed */
export async function emitOfflineUpdates(updates: UserWithNotifyIds[]) {
  await Promise.allSettled(updates.map(update => eventHelper.emit({
    type: 'cliUserData',
    data: {
      id: update.userId,
      onlineStatus: 'offline',
      updatedAt: update.updatedAt,
    },
  }, {
    communityIds: update.communityIds,
    userIds: [update.userId],
  })));
}

/**
 * Sets users offline whose status has not been refreshed for
 * `staleAfterSeconds` (the `onlineStatusCheck` job: a crashed or stopped wsapi
 * process, a decision lost on shutdown), resets the socket count of stale
 * bots, and emits `cliUserData` for every user it changed, so other clients
 * see the offline too (memberlist learns it through the users trigger).
 * Returns their ids.
 */
export async function setStaleUsersOffline(staleAfterSeconds = 90): Promise<string[]> {
  const result = await pool.query(`
    WITH stale_users AS (
      UPDATE users
      SET
        "onlineStatus" = 'offline',
        "updatedAt" = now(),
        "onlineStatusUpdatedAt" = now()
      WHERE "onlineStatusUpdatedAt" < now() - make_interval(secs => $1)
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
    ${userWithNotifyIdsQuery('stale_users')}
  `, [staleAfterSeconds]);
  const updates = result.rows as UserWithNotifyIds[];
  await emitOfflineUpdates(updates);
  return updates.map(update => update.userId);
}
