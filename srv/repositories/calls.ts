// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import format from "pg-format";
import config from "../common/config";
import { CallPermission, CallType, CommunityPermission, CommunityPremiumFeatureName, PredefinedRole, RoleType, UserBlockState } from "../common/enums";
import errors from "../common/errors";
import pool from "../util/postgres";

export const MEMBER_PERMISSIONS: CallPermission[] = [
  CallPermission.CALL_EXISTS,
  CallPermission.CALL_JOIN,
  CallPermission.CHANNEL_READ,
  CallPermission.CHANNEL_WRITE,
  CallPermission.AUDIO_SEND,
  CallPermission.VIDEO_SEND,
  CallPermission.SHARE_SCREEN,
];
export const MODERATOR_PERMISSIONS: CallPermission[] = [
  ...MEMBER_PERMISSIONS,
  CallPermission.CALL_MODERATE,
  CallPermission.PIN_FOR_EVERYONE,
  CallPermission.END_CALL_FOR_EVERYONE,
];

type CallCommunityExtraData = {
  communityId: string;
  communityUrl: string;
  communityTitle: string;
}

/**
 * The users with an open membership in the call `callId` whose claimed roles
 * plus the predefined Public role (title `publicTitle`), both of the call's
 * community, hold every permission of
 * `permissions` on it (the union over the roles, as
 * `permissionHelper.hasPermissions` evaluates call permissions). Arguments
 * are SQL expressions (placeholders or columns).
 */
function activeMembersWithPermissionsSql(callId: string, publicTitle: string, permissions: string) {
  return `
    SELECT DISTINCT cm."userId"
    FROM callmembers cm
    WHERE cm."callId" = ${callId}
      AND cm."leftAt" IS NULL
      AND (
        SELECT COALESCE(array_agg(DISTINCT perm), '{}')
        FROM callpermissions cp
        INNER JOIN calls cl
          ON  cl."id" = cp."callId"
        INNER JOIN roles r
          ON  r."id" = cp."roleId"
          AND r."deletedAt" IS NULL
          AND r."communityId" = cl."communityId"
        LEFT JOIN roles_users_users ruu
          ON  ruu."roleId" = r."id"
          AND ruu."claimed" = TRUE
          AND ruu."userId" = cm."userId"
        CROSS JOIN LATERAL unnest(cp."permissions") AS perm
        WHERE cp."callId" = cm."callId"
          AND (ruu."userId" IS NOT NULL OR (r."type" = ${format('%L', RoleType.PREDEFINED)} AND r."title" = ${publicTitle}))
      ) @> ${permissions}::"public"."callpermissions_permissions_enum"[]
  `;
}

class CallHelper {
  private async getCallServerForScheduling() {
    const result = await pool.query(`
      SELECT
        id,
        url
      FROM callservers
      WHERE
        "updatedAt" > now() - interval '${config.CALLSERVER_STALE_AFTER_MILLISECONDS} milliseconds'
      ORDER BY (status->>'traffic')::bigint ASC
      LIMIT 1
    `);
    if (result.rows.length === 0) {
      throw new Error(errors.server.SERVICE_UNAVAILABLE);
    }
    return result.rows[0] as {
      id: string;
      url: string;
    };
  }

  public async getCallServerByUrl(url: string) {
    const result = await pool.query(`
      SELECT
        id,
        status,
        url,
        "createdAt",
        "updatedAt",
        "deletedAt"
      FROM callservers
      WHERE url = $1
    `, [url]);
    return (result.rows[0] || null) as ({
      id: string;
      status: Models.Server.CallServerStatus;
      url: string;
      createdAt: string;
      updatedAt: string;
      deletedAt: string | null;
    } | null);
  }

  public async getCallServers(): Promise<Models.Server.CallServer[]> {
    const result = await pool.query(`
      SELECT
        id,
        status,
        url,
        "createdAt",
        "updatedAt",
        "deletedAt"
      FROM callservers
    `);
    return result.rows as {
      id: string;
      status: Models.Server.CallServerStatus;
      url: string;
      createdAt: string;
      updatedAt: string;
      deletedAt: string | null;
    }[];
  }

  public async upsertCallServer(
    status: Models.Server.CallServerStatus,
    url: string,
    deleted: boolean,
  ) {
    const result = await pool.query(`
      INSERT INTO callservers (status, url)
      VALUES ($1, $2)
      ON CONFLICT (url) DO UPDATE SET
        status = excluded.status,
        "updatedAt" = NOW(),
        "deletedAt" = ${deleted ? 'COALESCE("deletedAt", now())' : 'NULL'}
      RETURNING id
    `, [status, url]);
    return result.rows[0].id as string;
  }

  public async createCall(data: API.Community.startCall.Request): Promise<Models.Calls.Call & CallCommunityExtraData>;
  public async createCall(data: API.Community.startCall.Request, scheduleDate: string): Promise<Omit<Models.Calls.Call, "callServerUrl"> & CallCommunityExtraData>;
  public async createCall(data: API.Community.startCall.Request, scheduleDate?: string): Promise<(Models.Calls.Call & CallCommunityExtraData) | (Omit<Models.Calls.Call, "callServerUrl"> & CallCommunityExtraData)> {
    // get callserver id for scheduling
    let callServer: Awaited<ReturnType<CallHelper["getCallServerForScheduling"]>> | null = null;
    if (!scheduleDate) {
      callServer = await this.getCallServerForScheduling();
    }

    let roleInsert: string = await this.getRoles(data.communityId, data.rolePermissions);

    const result = await pool.query(`
      WITH insert_channel AS (
        INSERT INTO channels
        DEFAULT VALUES
        RETURNING "id"
      ), insert_call AS (
        INSERT INTO calls (
          "channelId",
          "communityId",
          "callServerId",
          "title",
          "description",
          "previewUserIds",
          "callType",
          "callCreator",
          "scheduleDate",
          "slots",
          "stageSlots",
          "audioOnly",
          "highQuality"
        )
        VALUES (
          (SELECT "id" FROM insert_channel),
          $1, $2::UUID, $3, $4, ARRAY[]::UUID[], $5, $6, ${scheduleDate ? format("%L::timestamptz", scheduleDate) : 'NULL'}, $7, $8, $9, $10
        )
        RETURNING
          id,
          "channelId",
          "communityId",
          slots,
          "startedAt",
          "updatedAt",
          "callType",
          "callCreator",
          "stageSlots",
          "audioOnly",
          "highQuality"
      ), member_role AS (
        SELECT id
        FROM roles
        WHERE "communityId" = $1
          AND "type" = ${format("%L", RoleType.PREDEFINED)}
          AND "title" = ${format("%L", PredefinedRole.Member)}
      ), admin_role AS (
        SELECT id
        FROM roles
        WHERE "communityId" = $1
          AND "type" = ${format("%L", RoleType.PREDEFINED)}
          AND "title" = ${format("%L", PredefinedRole.Admin)}
      ), permission_insert AS (
        INSERT INTO callpermissions (
          "callId",
          "roleId",
          "permissions"
        )
        VALUES (
          (SELECT id FROM insert_call),
          (SELECT id FROM admin_role),
          ARRAY[${format("%L", MODERATOR_PERMISSIONS)}]::"public"."callpermissions_permissions_enum"[]
        ) 
        ${roleInsert}
        RETURNING "roleId", "permissions"
      )
      SELECT 
        ic.id,
        ic."channelId",
        ic.slots,
        ic."startedAt",
        ic."updatedAt",
        ic."callType",
        ic."callCreator",
        (
          SELECT array_to_json(array_agg(json_build_object(
          'roleId', "roleId",
          'permissions', "permissions"
        )))
        FROM permission_insert) AS "rolePermissions",
        (
          SELECT url
          FROM communities
          WHERE id = ic."communityId"
        ) AS "communityUrl",
        (
          SELECT title
          FROM communities
          WHERE id = ic."communityId"
        ) AS "communityTitle",
        ic."stageSlots",
        ic."audioOnly",
        ic."highQuality"
      FROM insert_call ic
    `, [
      data.communityId,
      callServer?.id || null,
      data.title,
      data.description,
      data.callType,
      data.callCreator,
      data.slots,
      data.stageSlots,
      data.audioOnly,
      data.hd
    ]);
    const row = result.rows[0] as {
      id: string;
      channelId: string;
      slots: number;
      startedAt: string;
      updatedAt: string;
      callType: Common.CallType;
      callCreator: string;
      communityUrl: string;
      communityTitle: string;
      rolePermissions: {
        roleId: string;
        permissions: CallPermission[];
      }[];
      scheduleDate: string | null;
      stageSlots: number;
      audioOnly: boolean;
      highQuality: boolean;
    };
    if (!!callServer) {
      const callData: Models.Calls.Call & CallCommunityExtraData = {
        id: row.id,
        communityId: data.communityId,
        communityUrl: row.communityUrl,
        communityTitle: row.communityTitle,
        channelId: row.channelId,
        callServerUrl: callServer.url,
        previewUserIds: [] as string[],
        title: data.title,
        description: data.description,
        callMembers: 0,
        slots: row.slots,
        startedAt: row.startedAt,
        endedAt: null as string | null,
        updatedAt: row.updatedAt,
        rolePermissions: row.rolePermissions,
        callType: row.callType,
        callCreator: row.callCreator,
        scheduleDate: row.scheduleDate,
        stageSlots: row.stageSlots,
        audioOnly: row.audioOnly,
        highQuality: row.highQuality
      };
      return callData;
    }
    else {
      const callData: Omit<Models.Calls.Call, "callServerUrl"> & CallCommunityExtraData = {
        id: row.id,
        communityId: data.communityId,
        communityUrl: row.communityUrl,
        communityTitle: row.communityTitle,
        channelId: row.channelId,
        previewUserIds: [] as string[],
        title: data.title,
        description: data.description,
        callMembers: 0,
        slots: row.slots,
        startedAt: row.startedAt,
        endedAt: null as string | null,
        updatedAt: row.updatedAt,
        rolePermissions: row.rolePermissions,
        callType: row.callType,
        callCreator: row.callCreator,
        scheduleDate: row.scheduleDate,
        stageSlots: row.stageSlots,
        audioOnly: row.audioOnly,
        highQuality: row.highQuality
      };
      return callData;
    }
  }

  public async updateCall(
    data: API.Community.updateCall.Request,
    scheduleDate: string
  ): Promise<API.Community.updateCall.Response> {
    let roleInsert: string = await this.getRoles(data.communityId, data.rolePermissions);

    // Update call query is called insert_call for compatibility reasons
    const result = await pool.query(`
      WITH delete_permissions AS (
        DELETE FROM callpermissions
        WHERE "callId" = $1
      ), insert_call AS (
        UPDATE calls
        SET
          "title" = $2,
          "description" = $3,
          "callType" = $4,
          "scheduleDate" = ${format("%L::timestamptz", scheduleDate)},
          "slots" = $5,
          "stageSlots" = $6,
          "audioOnly" = $7,
          "highQuality" = $8,
          "updatedAt" = NOW()
        WHERE id = $1
        RETURNING "id"
      ), member_role AS (
        SELECT id
        FROM roles
        WHERE "communityId" = $9
          AND "type" = ${format("%L", RoleType.PREDEFINED)}
          AND "title" = ${format("%L", PredefinedRole.Member)}
      ), admin_role AS (
        SELECT id
        FROM roles
        WHERE "communityId" = $9
          AND "type" = ${format("%L", RoleType.PREDEFINED)}
          AND "title" = ${format("%L", PredefinedRole.Admin)}
      ), reinsert_permissions AS (
        INSERT INTO callpermissions (
          "callId",
          "roleId",
          "permissions"
        )
        VALUES (
          $1,
          (SELECT id FROM admin_role),
          ARRAY[${format("%L", MODERATOR_PERMISSIONS)}]::"public"."callpermissions_permissions_enum"[]
        )${roleInsert}
        ON CONFLICT ("callId", "roleId")
          DO UPDATE SET "permissions" = EXCLUDED."permissions")
      SELECT * FROM insert_call
    `, [
      data.id,
      data.title,
      data.description,
      data.callType,
      data.slots,
      data.stageSlots,
      data.audioOnly,
      data.hd,
      data.communityId
    ]);

    if (result.rows.length !== 1) {
      throw new Error('Call update failed');
    }
  }

  /**
   * The role permissions to store for a call of `communityId`, without the
   * Admin role (it always gets MODERATOR_PERMISSIONS). Every role id must be
   * a live role of that community; otherwise the request is refused with
   * NOT_ALLOWED.
   */
  private async getCheckedRolePermissions(communityId: string, rolePermissions: { roleId: string; permissions: Common.CallPermission[] }[]) {
    const rolesResult = await pool.query(`
      SELECT "id", "type", "title"
      FROM roles
      WHERE "communityId" = $1
        AND "deletedAt" IS NULL
    `, [communityId]);
    const roles = rolesResult.rows as { id: string; type: RoleType; title: string }[];
    const adminRole = roles.find(r => r.type === RoleType.PREDEFINED && r.title === PredefinedRole.Admin);
    if (!adminRole) {
      throw new Error(errors.server.UNKNOWN);
    }
    const communityRoleIds = new Set(roles.map(r => r.id));
    for (const rolePermission of rolePermissions) {
      if (!communityRoleIds.has(rolePermission.roleId)) {
        throw new Error(errors.server.NOT_ALLOWED);
      }
    }
    return rolePermissions.filter(p => p.roleId !== adminRole.id);
  }

  private async getRoles(communityId: string, rolePermissions?: { roleId: string; permissions: Common.CallPermission[] }[]) {
    let roleInsert: string = ``;
    if (rolePermissions === undefined) {
      roleInsert = `, (
        (SELECT id FROM insert_call),
        (SELECT id FROM member_role),
        ARRAY[${format("%L", MEMBER_PERMISSIONS)}]::"public"."callpermissions_permissions_enum"[]
      )`;
    } else if (rolePermissions.length > 0) {
      rolePermissions = await this.getCheckedRolePermissions(communityId, rolePermissions);
      if (rolePermissions.length > 0) {
        roleInsert = `,` + rolePermissions.map(role => format(`(
            (SELECT id FROM insert_call),
            %L::uuid,
            ARRAY[${format("%L", role.permissions)}]::"public"."callpermissions_permissions_enum"[])
          `, role.roleId)).join(",");
      }
    }
    return roleInsert;
  }

  private async getRolesForExistingCalls(callId: string, communityId: string, rolePermissions?: { roleId: string; permissions: Common.CallPermission[] }[]) {
    let roleInsert: string = ``;
    if (rolePermissions === undefined) {
      roleInsert = `, (
        ${format("%L::UUID", callId)},
        (SELECT id FROM member_role),
        ARRAY[${format("%L", MEMBER_PERMISSIONS)}]::"public"."callpermissions_permissions_enum"[]
      )`;
    } else if (rolePermissions.length > 0) {
      rolePermissions = await this.getCheckedRolePermissions(communityId, rolePermissions);
      if (rolePermissions.length > 0) {
        roleInsert = `,` + rolePermissions.map(role => format(`(
            ${format("%L::UUID", callId)},
            %L::uuid,
            ARRAY[${format("%L", role.permissions)}]::"public"."callpermissions_permissions_enum"[])
          `, role.roleId)).join(",");
      }
    }
    return roleInsert;
  }

  public async startScheduledCall({ communityEventId, callStarter }: { communityEventId: string, callStarter: string }): Promise<Models.Calls.Call & CallCommunityExtraData> {
    const callServer = await this.getCallServerForScheduling();
    const result = await pool.query<{
      id: string;
      title: string;
      description: string | null;
      communityId: string;
      channelId: string;
      slots: number;
      startedAt: string;
      updatedAt: string;
      callType: Common.CallType;
      callCreator: string;
      scheduleDate: string;
      communityUrl: string;
      communityTitle: string;
      rolePermissions: {
        roleId: string;
        permissions: CallPermission[];
      }[];
      stageSlots: number;
      highQuality: boolean;
      audioOnly: boolean;
    }>(
      `
      WITH get_call AS (
        SELECT
          ca.id,
          c.title AS "communityTitle",
          c.url AS "communityUrl"
        FROM communities_events ce
        INNER JOIN calls ca
          ON ce."callId" = ca."id"
        INNER JOIN communities c
          ON ce."communityId" = c."id"
        WHERE ce.id = $1
      ),
      -- an event call that was ended (its call server restarted or went
      -- away, or everyone left after the scheduled end) can be started
      -- again: memberships left open by the ended call are closed, and
      -- "endedAt" is reset below
      close_stale_members AS (
        UPDATE callmembers
        SET "leftAt" = COALESCE("leftAt", NOW())
        WHERE "callId" = (SELECT id FROM get_call)
          AND "leftAt" IS NULL
          AND EXISTS (
            SELECT 1 FROM calls
            WHERE id = (SELECT id FROM get_call)
              AND "endedAt" IS NOT NULL
          )
      ),
      update_call AS (
        UPDATE calls
        SET
          "callCreator" = $3,
          "callServerId" = $2,
          "startedAt" = NOW(),
          "updatedAt" = NOW(),
          "endedAt" = NULL
        WHERE id = (SELECT id FROM get_call)
        RETURNING
          id,
          "title",
          "description",
          "communityId",
          "channelId",
          "slots",
          "startedAt",
          "updatedAt",
          "callType",
          "callCreator",
          "scheduleDate",
          "stageSlots",
          "audioOnly",
          "highQuality"	
      ),
      get_role_permissions AS (
        SELECT json_agg(json_build_object(
          'roleId', cp."roleId",
          'permissions', cp."permissions"
        )) AS "rolePermissions"
        FROM callpermissions cp
        WHERE cp."callId" = (SELECT id FROM update_call)
      )
      SELECT
        uc.*,
        gc."communityUrl",
        gc."communityTitle",
        rp."rolePermissions"
      FROM update_call uc
      CROSS JOIN get_call gc
      CROSS JOIN get_role_permissions rp
      `,
      [communityEventId, callServer.id, callStarter]
    );
    const row = result.rows[0];
    if (!row || !row.id || !row.communityTitle) {
      throw new Error(errors.server.NOT_FOUND);
    }
    const callData: Models.Calls.Call & CallCommunityExtraData = {
      id: row.id,
      communityId: row.communityId,
      communityUrl: row.communityUrl,
      communityTitle: row.communityTitle,
      channelId: row.channelId,
      callServerUrl: callServer.url,
      previewUserIds: [] as string[],
      title: row.title,
      description: row.description,
      callMembers: 0,
      slots: row.slots,
      startedAt: row.startedAt,
      endedAt: null as string | null,
      updatedAt: row.updatedAt,
      rolePermissions: row.rolePermissions,
      callType: row.callType,
      callCreator: row.callCreator,
      scheduleDate: row.scheduleDate,
      stageSlots: row.stageSlots,
      audioOnly: row.audioOnly,
      highQuality: row.highQuality
    };
    return callData;
  }


  public async softEndCall(callId: string) {
    //update leftAt for all members from that call
    await pool.query(`
      UPDATE callmembers
      SET
        "leftAt" = COALESCE("leftAt", NOW())
      WHERE "callId" = $1
    `, [callId]);
    const result = await pool.query(`
      UPDATE calls
      SET
        "endedAt" = NOW(),
        "updatedAt" = NOW()
      WHERE id = $1
        AND "scheduleDate" IS NULL
        AND "endedAt" IS NULL
      RETURNING id
    `, [callId]);
    if (result.rowCount === 0) {
      return null;
    }
    return result.rows[0].id as string;
  }

  public async endCallForEveryone(callId: string) {
    //update leftAt for all members from that call
    await pool.query(`
      UPDATE callmembers
      SET
        "leftAt" = COALESCE("leftAt", NOW())
      WHERE "callId" = $1
    `, [callId]);
    const result = await pool.query(`
      UPDATE calls
      SET
        "endedAt" = NOW(),
        "updatedAt" = NOW()
      WHERE id = $1
        AND "endedAt" IS NULL
      RETURNING id
    `, [callId]);
    if (result.rowCount === 0) {
      return null;
    }
    return result.rows[0].id as string;
  }

  /**
   * Ends calls that nobody is in any more (run periodically by the jobs
   * process, `jobs/callUpdateEmitter.ts`):
   * - non-scheduled calls that never had a member, once they are older than
   *   `END_CALL_AFTER_EMPTY_PERIOD`;
   * - non-scheduled calls whose members have all left, the last one more than
   *   `END_CALL_AFTER_ALL_LEFT_PERIOD` ago. The call server's room normally
   *   ends such a call as soon as its last peer leaves (`softEndCall`); this
   *   catches calls whose room went away without ending them;
   * - event calls whose members have all left, once the event's scheduled end
   *   has passed; a scheduled call without an event row (the event's scheduled
   *   end is unknown, `ce."scheduleDate"` is NULL) as soon as nobody is in it.
   */
  public async endEmptyCalls() {
    const result = await pool.query<{ id: string; communityId: string }>(`
      WITH stale_calls AS (
        SELECT cl.id
        FROM calls cl
        LEFT JOIN callmembers cm
          ON cm."callId" = cl.id
        WHERE cl."scheduleDate" IS NULL
          AND cl."startedAt" < now() - interval '${config.END_CALL_AFTER_EMPTY_PERIOD} milliseconds'
          AND cl."endedAt" IS NULL
        GROUP BY cl.id
        HAVING COUNT(cm.id) = 0
          OR (
            COUNT(cm.id) = COUNT(cm."leftAt")
            AND MAX(cm."leftAt") < now() - interval '${config.END_CALL_AFTER_ALL_LEFT_PERIOD} milliseconds'
          )
      ), event_calls AS (
        SELECT
          cl.id,
          ce."scheduleDate",
          ce."duration" * interval '1 minute' AS "duration"
        FROM calls cl
        LEFT JOIN communities_events ce
          ON ce."callId" = cl.id
        LEFT JOIN callmembers cm
          ON cm."callId" = cl.id
        WHERE (ce.id IS NOT NULL OR cl."scheduleDate" IS NOT NULL)
          AND cl."startedAt" < now() - interval '${config.END_CALL_AFTER_EMPTY_PERIOD} milliseconds'
          AND cl."endedAt" IS NULL
        GROUP BY cl.id, ce."scheduleDate", ce."duration"
        HAVING COUNT(cm.id) = COUNT(cm."leftAt")
      ), end_calls AS (
        SELECT id FROM stale_calls
        UNION
        SELECT id FROM event_calls
        WHERE
          "scheduleDate" IS NULL
          OR "scheduleDate" + "duration" < now()
      )
      UPDATE calls
        SET "endedAt" = now(), "updatedAt" = now()
      WHERE id = ANY(SELECT id FROM end_calls)
        AND "endedAt" IS NULL
      RETURNING id, "communityId"
    `);
    return result.rows;
  }

  /**
   * Ends every open call of a call server that is gone: the server row was
   * deleted (`deletedAt`), no longer exists, or its heartbeat (`updatedAt`,
   * written every `CALLSERVER_UPDATE_DATA_INTERVAL` by the mediasoup process)
   * is older than `CALLSERVER_GONE_AFTER_MILLISECONDS`. Event calls included,
   * like `resetCallServer` does on a call server restart: an ended event call
   * can be started again (`startScheduledCall`). Open memberships are closed
   * and `previewUserIds` cleared.
   *
   * End and leave times are the server's last sign of life (deletion or last
   * heartbeat), not the time of the sweep.
   */
  public async endCallsOfGoneCallServers() {
    const result = await pool.query<{ id: string; communityId: string }>(`
      WITH gone_calls AS (
        SELECT
          c.id,
          GREATEST(c."startedAt", COALESCE(cs."deletedAt", cs."updatedAt", now())) AS "endedAt"
        FROM calls c
        LEFT JOIN callservers cs
          ON cs.id = c."callServerId"
        WHERE c."endedAt" IS NULL
          AND c."callServerId" IS NOT NULL
          AND (
            cs.id IS NULL
            OR cs."deletedAt" IS NOT NULL
            OR cs."updatedAt" < now() - interval '${config.CALLSERVER_GONE_AFTER_MILLISECONDS} milliseconds'
          )
      ), left_members AS (
        UPDATE callmembers cm
        SET "leftAt" = GREATEST(cm."joinedAt", gc."endedAt")
        FROM gone_calls gc
        WHERE cm."callId" = gc.id
          AND cm."leftAt" IS NULL
      )
      UPDATE calls c
      SET
        "endedAt" = gc."endedAt",
        "updatedAt" = now(),
        "previewUserIds" = ARRAY[]::UUID[]
      FROM gone_calls gc
      WHERE c.id = gc.id
        AND c."endedAt" IS NULL
      RETURNING c.id, c."communityId"
    `);
    return result.rows;
  }

  public async getCallState(callId: string) {
    const result = await pool.query(`
      SELECT
        id,
        "communityId",
        "channelId",
        "callServerId",
        "previewUserIds",
        title,
        description,
        slots,
        "startedAt",
        "endedAt",
        "updatedAt",
        "callCreator",
        "stageSlots",
        "audioOnly",
        "highQuality",
        "callType"
      FROM calls
      WHERE id = $1
    `, [callId]);
    if (result.rows.length === 0) {
      return null;
    }
    const row = result.rows[0] as {
      id: string;
      communityId: string;
      channelId: string;
      callServerId: string;
      previewUserIds: string[];
      title: string;
      description: string;
      slots: number;
      startedAt: string;
      endedAt: string | null;
      updatedAt: string;
      callCreator: string;
      stageSlots: number;
      audioOnly: boolean;
      highQuality: boolean;
      callType: CallType;
    };
    const callData = {
      id: row.id,
      communityId: row.communityId,
      channelId: row.channelId,
      callServerUrl: null as string | null,
      previewUserIds: row.previewUserIds,
      title: row.title,
      description: row.description,
      callMembers: 0,
      slots: row.slots,
      startedAt: row.startedAt,
      endedAt: row.endedAt,
      updatedAt: row.updatedAt,
      callCreator: row.callCreator,
      stageSlots: row.stageSlots,
      audioOnly: row.audioOnly,
      highQuality: row.highQuality,
      callType: row.callType,
    };
    return callData;
  }


  public async updateCallPreviewIds(roomId: string, joinedPeers: string[]) {
    const limitedJoinedPeers = joinedPeers.slice(0, 9);
    const result = await pool.query(`
      UPDATE calls
      SET
        "previewUserIds" = $2,
        "updatedAt" = now()
      WHERE id = $1
      RETURNING id
    `, [roomId, limitedJoinedPeers]);
    return result.rows[0].id as string;
  }

  public async insertCallMember(
    callId: string,
    userId: string,
  ) {
    const result = await pool.query(`
      INSERT INTO callmembers (
        "callId",
        "userId"
      ) VALUES (
        $1,
        $2
      ) RETURNING
        id as "membershipId",
        "callId",
        "userId"
    `, [
      callId,
      userId
    ]);
    return result.rows[0] as {
      membershipId: string;
      callId: string;
      userId: string;
    };
  }

  public async callMemberLeave(
    membershipId: string,
  ) {
    const result = await pool.query(`
      UPDATE callmembers
      SET
        "leftAt" = NOW()
      WHERE id = ${format("%L::UUID", membershipId)}
      RETURNING id
    `);
    return result.rows[0].id as string;
  }

  public async resetCallServer(
    url: string,
    isDeleted: boolean,
  ) {
    const query = `
      WITH update_callserver AS (
        UPDATE callservers
        SET
          "updatedAt" = now(),
          "status" = '{"ongoingCalls":0}'::jsonb,
          "deletedAt" = ${isDeleted ? 'now()' : 'NULL'}
        WHERE url = $1
        RETURNING id
      ), ended_calls AS (
        UPDATE calls c
        SET
          "endedAt" = now(),
          "updatedAt" = now(),
          "previewUserIds" = Array[]::UUID[]
        WHERE c."callServerId" = (SELECT id FROM update_callserver)
          AND c."endedAt" IS NULL
        RETURNING c.id
      )
      UPDATE callmembers
      SET
        "leftAt" = COALESCE("leftAt", now())
      WHERE "callId" = ANY((SELECT id FROM ended_calls))
    `;
    await pool.query(query, [url]);
  }

  /**
   * The users who are in the call right now (an open membership) and hold
   * `permissions` on it through their claimed roles or the Public role,
   * evaluated like `permissionHelper.hasPermissions` for calls.
   */
  public async getActiveMemberUserIds(callId: string, permissions: CallPermission[]): Promise<string[]> {
    const result = await pool.query(
      activeMembersWithPermissionsSql('$1', '$2', '$3'),
      [callId, PredefinedRole.Public, permissions],
    );
    return (result.rows as { userId: string }[]).map(r => r.userId);
  }

  /**
   * Who gets a call's live events beyond its role rooms: the users in the
   * call right now who may see it, and the community (its room holds members
   * and visitors) when the Public role may see the call — nobody joins a
   * Public role room.
   */
  public async getCallEventExtraTargets(callId: string): Promise<{
    activeMemberUserIds: string[];
    publicCommunityId: string | null;
  }> {
    const result = await pool.query(`
      SELECT
        ARRAY(${activeMembersWithPermissionsSql('c."id"', '$2', 'ARRAY[$3]')}) AS "activeMemberUserIds",
        CASE WHEN EXISTS (
          SELECT 1
          FROM callpermissions cp
          INNER JOIN roles r
            ON  r."id" = cp."roleId"
            AND r."deletedAt" IS NULL
            AND r."communityId" = c."communityId"
            AND r."type" = ${format('%L', RoleType.PREDEFINED)}
          WHERE cp."callId" = c."id"
            AND r."title" = $2
            AND cp."permissions" @> ARRAY[$3]::"public"."callpermissions_permissions_enum"[]
        ) THEN c."communityId" ELSE NULL END AS "publicCommunityId"
      FROM calls c
      WHERE c."id" = $1
    `, [callId, PredefinedRole.Public, CallPermission.CALL_EXISTS]);
    const row = result.rows[0] as { activeMemberUserIds: string[]; publicCommunityId: string | null } | undefined;
    return {
      activeMemberUserIds: row?.activeMemberUserIds ?? [],
      publicCommunityId: row?.publicCommunityId ?? null,
    };
  }

  public async getUserIdsToNotify({ communityId, callId }: { communityId: string, callId: string }) {
    const query = `
      SELECT DISTINCT u."id"
      FROM calls c
      INNER JOIN callpermissions cp
        ON  cp."callId" = c."id"
        AND cp."permissions" @> ${format('ARRAY[%L]::"public"."callpermissions_permissions_enum"[]', [
      CallPermission.CALL_EXISTS,
      CallPermission.CALL_JOIN,
    ])}
      INNER JOIN roles r
        ON  cp."roleId" = r."id"
        AND r."deletedAt" IS NULL
      INNER JOIN roles_users_users ruu
        ON  ruu."roleId" = r."id"
        AND ruu."claimed" = TRUE
      INNER JOIN users u
        ON  ruu."userId" = u."id"
      WHERE c."id" = ${format("%L::uuid", callId)}
        AND c."communityId" = ${format("%L::uuid", communityId)}
    `;
    const result = await pool.query(query);
    const rows = result.rows as { id: string }[];
    return rows.map(r => r.id);
  }

  public async hasPermissionToModerateCall(
    userId: string,
    callId: string,
  ) {
    const query = `
    SELECT SUM("count") > 0 AS "hasPermission"
    FROM (
        SELECT COUNT(*) 
        FROM roles_users_users ruu
        INNER JOIN roles r
          ON ruu."roleId" = r."id"
          AND r."deletedAt" IS NULL
        INNER JOIN callpermissions cp
          ON cp."roleId" = r."id"
          AND cp."callId" = ${format("%L::uuid", callId)}
          AND cp."permissions" @> ${format('ARRAY[%L]::"public"."callpermissions_permissions_enum"[]', [CallPermission.CALL_MODERATE,])}
        WHERE ruu."userId" = ${format("%L::uuid", userId)}
          AND ruu."claimed" = TRUE
      UNION
        SELECT COUNT(*)
        FROM roles_users_users ruu
        INNER JOIN roles r
          ON ruu."roleId" = r."id"
          AND r."deletedAt" IS NULL
        WHERE ruu."userId" = ${format("%L::uuid", userId)}
          AND r."permissions" @> ${format('ARRAY[%L]::"public"."roles_permissions_enum"[]', [CommunityPermission.WEBRTC_MODERATE,])}
          AND ruu."claimed" = TRUE
      ) as "count" 
    `;
    const result = await pool.query(query);
    return result.rows[0].hasPermission as boolean;
  }

  /**
   * Whether the (logged-in) user `userId` may join the room of the call
   * `callId`: the call has not ended, its community is not deleted, and
   * `CALL_JOIN` is granted to one of the user's claimed, live roles or to the
   * predefined Public role of the call's community. A call open to the
   * Public role can be joined by everyone who may see it through that role,
   * members and non-members alike, except users banned from the community.
   */
  public async hasPermissionToJoinCall(
    userId: string,
    callId: string,
  ) {
    const result = await pool.query(`
      SELECT EXISTS (
        SELECT 1
        FROM calls c
        INNER JOIN communities co
          ON  co."id" = c."communityId"
          AND co."deletedAt" IS NULL
        WHERE c."id" = $1
          AND c."endedAt" IS NULL
          AND (
            EXISTS (
              SELECT 1
              FROM callpermissions cp
              INNER JOIN roles r
                ON  r."id" = cp."roleId"
                AND r."deletedAt" IS NULL
              INNER JOIN roles_users_users ruu
                ON  ruu."roleId" = r."id"
                AND ruu."userId" = $2
                AND ruu."claimed" = TRUE
              WHERE cp."callId" = c."id"
                AND cp."permissions" @> ARRAY[$3]::"public"."callpermissions_permissions_enum"[]
            )
            OR (
              EXISTS (
                SELECT 1
                FROM callpermissions cp
                INNER JOIN roles r
                  ON  r."id" = cp."roleId"
                  AND r."deletedAt" IS NULL
                  AND r."communityId" = c."communityId"
                  AND r."type" = $4
                  AND r."title" = $5
                WHERE cp."callId" = c."id"
                  AND cp."permissions" @> ARRAY[$3]::"public"."callpermissions_permissions_enum"[]
              )
              AND NOT EXISTS (
                SELECT 1
                FROM user_community_state ucs
                WHERE ucs."userId" = $2
                  AND ucs."communityId" = c."communityId"
                  AND ucs."blockState" = $6
                  AND (ucs."blockStateUntil" > now() OR ucs."blockStateUntil" IS NULL)
              )
            )
          )
      ) AS "hasPermission"
    `, [callId, userId, CallPermission.CALL_JOIN, RoleType.PREDEFINED, PredefinedRole.Public, UserBlockState.BANNED]);
    return result.rows[0].hasPermission as boolean;
  }

  public async updateCallPermissions(callId: string, communityId: string, rolePermissions?: {
    roleId: string;
    permissions: Common.CallPermission[];
  }[]) {
    let roleInsert: string = await this.getRolesForExistingCalls(callId, communityId, rolePermissions);
    //delete existing permissions, then insert the new ones (one transaction:
    //a failing insert must not leave the call without permissions)
    const deleteQuery = `
      DELETE FROM callpermissions
      WHERE "callId" = $1
    `;
    const updateQuery = format(`
      WITH member_role AS (
        SELECT id
        FROM roles
        WHERE "communityId" = $1
          AND "type" = ${format("%L", RoleType.PREDEFINED)}
          AND "title" = ${format("%L", PredefinedRole.Member)}
      ), admin_role AS (
        SELECT id
        FROM roles
        WHERE "communityId" = $1
          AND "type" = ${format("%L", RoleType.PREDEFINED)}
          AND "title" = ${format("%L", PredefinedRole.Admin)}
      ), permission_insert AS (
        INSERT INTO callpermissions (
          "callId",
          "roleId",
          "permissions"
        )
        VALUES (
          ${format("%L::UUID", callId)},
          (SELECT id FROM admin_role),
          ARRAY[${format("%L", MODERATOR_PERMISSIONS)}]::"public"."callpermissions_permissions_enum"[]
        )
        ${roleInsert})
        SELECT 1;`);
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(deleteQuery, [callId]);
      await client.query(updateQuery, [communityId]);
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
  }

  public getCallSlots(premiumTier: Models.Community.PremiumName | "FREE", callType: CallType) {
    let broadcastLimit: number;
    let callLimit: number;
    let stageLimit: number;

    switch (premiumTier) {
      case "BASIC":
        broadcastLimit = config.PREMIUM.COMMUNITY_BASIC.BROADCAST_STANDARD;
        callLimit = config.PREMIUM.COMMUNITY_BASIC.CALL_STANDARD;
        stageLimit = config.PREMIUM.COMMUNITY_BASIC.BROADCASTERS_SLOTS;
        break;
      case "PRO":
        broadcastLimit = config.PREMIUM.COMMUNITY_PRO.BROADCAST_STANDARD;
        callLimit = config.PREMIUM.COMMUNITY_PRO.CALL_STANDARD;
        stageLimit = config.PREMIUM.COMMUNITY_PRO.BROADCASTERS_SLOTS;
        break;
      case "ENTERPRISE":
        broadcastLimit = config.PREMIUM.COMMUNITY_ENTERPRISE.BROADCAST_STANDARD;
        callLimit = config.PREMIUM.COMMUNITY_ENTERPRISE.CALL_STANDARD;
        stageLimit = config.PREMIUM.COMMUNITY_ENTERPRISE.BROADCASTERS_SLOTS;
        break;
      default:
        broadcastLimit = config.PREMIUM.COMMUNITY_FREE.BROADCAST_STANDARD;
        callLimit = config.PREMIUM.COMMUNITY_FREE.CALL_STANDARD;
        stageLimit = config.PREMIUM.COMMUNITY_FREE.BROADCASTERS_SLOTS;
    }

    switch (callType) {
      case CallType.BROADCAST:
        return {
          stageSlots: stageLimit,
          overallCallSlots: broadcastLimit
        }
      case CallType.DEFAULT:
        return {
          stageSlots: stageLimit,
          overallCallSlots: callLimit
        }
      default:
        throw new Error('Invalid call type');
    }
  }

  public async getCallParticipantEvents(callId: string): Promise<{
    events: {
      eventType: 'join' | 'leave';
      userId: string;
      timestamp: string;
    }[];
  }> {
    const result = await pool.query(`
      SELECT
        cm."userId",
        cm."joinedAt",
        cm."leftAt"
      FROM callmembers cm
      WHERE cm."callId" = $1
      ORDER BY cm."joinedAt" ASC
    `, [callId]);

    const events: {
      eventType: 'join' | 'leave';
      userId: string;
      timestamp: string;
    }[] = [];

    for (const row of result.rows) {
      events.push({
        eventType: 'join',
        userId: row.userId,
        timestamp: row.joinedAt,
      });
      if (row.leftAt) {
        events.push({
          eventType: 'leave',
          userId: row.userId,
          timestamp: row.leftAt,
        });
      }
    }

    // Sort all events by timestamp
    events.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());

    return { events };
  }

  public async getHomepageCalls(userId: string | undefined, offset: number) {
    const followingSubquery = `
      SELECT ruu2.claimed
      FROM roles r3
      INNER JOIN roles_users_users ruu2
        ON ruu2."roleId" = r3.id
      WHERE
        r3."communityId" = cl."communityId" AND
        r3."title" = ${format("%L", PredefinedRole.Member)} AND
        r3."type" = ${format("%L", RoleType.PREDEFINED)} AND
        ${format('ruu2."userId" = %L::UUID', userId)}
    `;

    const query = `
      SELECT
        cl.id,
        cl."communityId",
        cl."channelId",
        cs.url as "callServerUrl",
        cl."previewUserIds",
        cl.title,
        cl.description,
        (
          SELECT COUNT(*)
          FROM callmembers cms
          WHERE cms."callId" = cl.id
            AND cms."leftAt" IS NULL
        ) as "callMembers",
        cl.slots,
        cl."startedAt",
        cl."endedAt",
        cl."updatedAt",
        (
          SELECT array_to_json(array_agg(json_build_object(
            'roleId', cp."roleId",
            'permissions', cp."permissions"
          )))
          FROM callpermissions cp
          WHERE cp."callId" = cl.id
        ) as "rolePermissions",
        cl."callType",
        cl."callCreator",
        cl."scheduleDate",
        cl."stageSlots",
        cl."highQuality",
        cl."audioOnly"
      FROM calls cl
      INNER JOIN callservers cs
        ON cs."id" = cl."callServerId"
      INNER JOIN "callpermissions" cp
        ON cl.id = cp."callId"
      INNER JOIN "roles" r
        ON cp."roleId" = r."id"
        AND r."deletedAt" IS NULL
      LEFT JOIN LATERAL (
        SELECT "communityId", "activeUntil"
        FROM communities_premium
        WHERE "featureName" = ANY(ARRAY[${format("%L", [CommunityPremiumFeatureName.BASIC, CommunityPremiumFeatureName.PRO, CommunityPremiumFeatureName.ENTERPRISE])}]::"public"."communities_premium_featurename_enum"[])
          AND "communityId" = cl."communityId"
        ORDER BY "activeUntil" DESC
        LIMIT 1
      ) cpr ON TRUE
      ${!!userId
        ? `LEFT JOIN roles_users_users ruu
            ON (r."id" = ruu."roleId" AND ruu.claimed = TRUE)`
        : ''}
      WHERE
        cl."endedAt" IS NULL
        AND (
          ${!!userId ? format('ruu."userId" = %L::UUID OR', userId) : ''}
          (
            r."title" = ${format("%L", PredefinedRole.Member)}
            AND r."type" = ${format("%L", RoleType.PREDEFINED)}
          )
        )
        AND cp."permissions" @> ${format(
          'ARRAY[%L]::"public"."callpermissions_permissions_enum"[]',
          CallPermission.CALL_EXISTS
        )}
        AND (
          ${!!userId ? `(${followingSubquery}) OR ` : ''}
          cpr."activeUntil" >= now()
        )
      GROUP BY cl."id", cs.url
      ORDER BY cl."startedAt" DESC
      LIMIT ${config.CALLS_BATCH_SIZE}
      OFFSET $1
    `;

    const result = await pool.query(query, [offset]);
    return result.rows as Models.Calls.Call[];
  }
}

const callHelper = new CallHelper();
export default callHelper;