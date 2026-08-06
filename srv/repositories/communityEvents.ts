// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import format from "pg-format";
import errors from "../common/errors";
import pool from "../util/postgres";
import { Pool, PoolClient } from "pg";
import { CommunityEventPermission, CommunityPremiumFeatureName, PredefinedRole, RoleType } from "../common/enums";
import config from "../common/config";
import callHelper from "./calls";
import { convertEventPermissionToCallPermission } from "../api/util";
import { EventEmailOptions } from "../api/emails";
import fileHelper from "./files";

export const MEMBER_PERMISSIONS: CommunityEventPermission[] = [
  CommunityEventPermission.EVENT_PREVIEW,
  CommunityEventPermission.EVENT_ATTEND
];

export const MODERATOR_PERMISSIONS: CommunityEventPermission[] = [
  ...MEMBER_PERMISSIONS,
  CommunityEventPermission.EVENT_MODERATE
];

async function _getEventCTE(
  db: Pool | PoolClient,
  data: {
    where?: string;
    userId?: string;
    params?: any[];
    selfOnly?: boolean;
    order?: 'ASC' | 'DESC'
    limit?: number;
    onlyVerifiedOrFollowing?: 'verified' | 'following';
    scheduledBefore?: string | null;
    scheduledAfter?: string | null;
    beforeAfterId?: string | null;
    tags?: string[] | null;
    anyTags?: string[] | null;
  }
) {

  if (!data.userId && data.onlyVerifiedOrFollowing === 'following') {
    return [];
  }

  const followingSubquery = `
    SELECT ruu2.claimed
    FROM roles r3
    INNER JOIN roles_users_users ruu2
      ON ruu2."roleId" = r3.id
    WHERE
      r3."communityId" = c.id AND
      r3."title" = ${format("%L", PredefinedRole.Member)} AND
      r3."type" = ${format("%L", RoleType.PREDEFINED)} AND
      ${format('ruu2."userId" = %L::UUID', data.userId)}
  `;

  const result = await db.query(`
    SELECT
      ce.id,
      ce."communityId",
      ce."url",
      ce."eventCreator",
      ce."callId",
      ce."type",
      ce."imageId",
      ce."title",
      ce."description",
      ce."externalUrl",
      ce."location",
      ce."scheduleDate",
      ce."duration",
      ce."createdAt",
      ce."updatedAt",
      ce."deletedAt",
      array(SELECT cep."userId" FROM communities_events_participants cep where cep."eventId" = ce.id limit 6) AS "participantIds",
      (select count(*) FROM communities_events_participants cep where cep."eventId" = ce.id) as "participantCount",
      (case when ${data.userId ? format("%L::UUID", data.userId) : null} is null then
        false
      else (CASE WHEN (SELECT count(*) FROM communities_events_participants cep where cep."eventId" = ce.id and cep."userId" = ${format("%L::UUID", data.userId)}) = 1 THEN
          TRUE
        ELSE
          FALSE
        END) 
      end) AS "isSelfAttending",
      (
        SELECT COALESCE(ARRAY_TO_JSON(ARRAY_AGG("item")), '[]'::JSON)
        FROM (
          SELECT JSON_BUILD_OBJECT(
            'roleId', r."id",
            'roleTitle', r."title",
            'permissions', cep."permissions"
          ) AS "item"
          FROM "communities_events_permissions" cep
          INNER JOIN roles r
            ON r."id" = cep."roleId"
            AND r."deletedAt" IS NULL
          WHERE cep."communityEventId" = ce."id"
        ) sub
      ) as "rolePermissions"
      FROM communities_events ce
      INNER JOIN "communities_events_permissions" cep
        ON ce.id = cep."communityEventId"
      INNER JOIN roles r
        ON cep."roleId" = r.id
        AND r."deletedAt" IS NULL
      ${!!data.selfOnly
      ? `INNER JOIN "communities_events_participants" cep2
          ON (cep2."userId" = ${format("%L::UUID", data.userId)} AND cep2."eventId" = ce.id)`
      : ''}
      ${!!data.userId
      ? `LEFT JOIN roles_users_users ruu
          ON (r."id" = ruu."roleId" AND ruu.claimed = TRUE)`
      : ''}
      ${!!data.onlyVerifiedOrFollowing || !!data.tags?.length
      ? `INNER JOIN communities c
           ON c."id" = ce."communityId"
         LEFT JOIN communities_premium cpr
           ON c."id" = cpr."communityId"
           AND cpr."featureName" = ANY(ARRAY[${format("%L", [CommunityPremiumFeatureName.BASIC, CommunityPremiumFeatureName.PRO, CommunityPremiumFeatureName.ENTERPRISE])}]::"public"."communities_premium_featurename_enum"[])`
      : ''}
      WHERE
        (
          ${!!data.userId
          ? format('ruu."userId" = %L::UUID OR', data.userId)
          : ''}
          (
            r."title" = ${format("%L", PredefinedRole.Public)}
            AND r."type" = ${format("%L", RoleType.PREDEFINED)}
          )
        )
        ${data.onlyVerifiedOrFollowing === 'following' || data.onlyVerifiedOrFollowing === 'verified' ? `AND (
          (${followingSubquery})
          ${data.onlyVerifiedOrFollowing === 'verified'
          ? `OR cpr."activeUntil" >= now()`
          : ''}
        )`: ''}
        AND ce."deletedAt" IS NULL
        AND cep."permissions" @> ${format(
          'ARRAY[%L]::"public"."communities_events_permissions_permissions_enum"[]',
          CommunityEventPermission.EVENT_PREVIEW
        )}
        ${!!data.scheduledAfter
        ? ` AND (${!!data.beforeAfterId
              ? `(${format('ce."scheduleDate" = %L::timestamptz', data.scheduledAfter)} AND ce.id > ${format('%L::UUID', data.userId)}) OR `
              : ''}
            ${format('ce."scheduleDate" > %L::timestamptz', data.scheduledAfter)})`
        : ''}
        ${!!data.scheduledBefore
          ? ` AND (${!!data.beforeAfterId
            ? `(${format('ce."scheduleDate" = %L::timestamptz', data.scheduledAfter)} AND ce.id < ${format('%L::UUID', data.userId)}) OR `
            : ''}
            ${format(' AND ce."scheduleDate" < %L::timestamptz ', data.scheduledBefore)})`
          : ''}
        ${!!data.tags?.length
          ? format(' AND c."tags" @> ARRAY[%s]::varchar[]', data.tags.map(tag => format('%L', tag)).join(','))
          : ''
        }
        ${!!data.anyTags?.length
          ? format(' AND c."tags" && ARRAY[%s]::varchar[]', data.anyTags.map(tag => format('%L', tag)).join(','))
          : ''
        }
        ${data.where ? `AND ${data.where}` : ''}
      GROUP BY ce."id"
      ORDER BY
        ce."scheduleDate" ${data.order || 'DESC'}
        ${(!!data.scheduledBefore || !!data.scheduledAfter)
        ? `, ce.id ${data.order || 'DESC'}`
        : ''}
      ${data.limit ? `LIMIT ${data.limit}` : ''}
  `, data.params);

  return result.rows as {
    id: string;
    communityId: string;
    url: string;
    eventCreator: string;
    callId: string | null;
    type: Models.Community.EventType;
    imageId: string;
    title: string;
    description: Models.BaseArticle.ContentV2;
    externalUrl: string | null;
    location: string | null;
    scheduleDate: string;
    duration: number;
    createdAt: string;
    updatedAt: string;
    deletedAt: string | null;
    participantIds: string[];
    participantCount: number;
    isSelfAttending: boolean;
    rolePermissions: {
      roleId: string;
      roleTitle: string;
      permissions: CommunityEventPermission[];
    }[];
  }[];
}

class CommunityEventHelper {
  public async getCommunityEvents(communityId: string, userId: string): Promise<API.Community.getEventList.Response> {
    return _getEventCTE(pool, {
      where: 'ce."communityId" = $1',
      userId,
      params: [communityId]
    });
  }

  public async getMyEvents(userId: string, scheduledBefore: string | null, beforeId: string | null): Promise<API.Community.getEventList.Response> {
    return _getEventCTE(pool, {
      userId,
      selfOnly: true,
      scheduledBefore,
      beforeAfterId: beforeId,
      limit: config.EVENTS_BATCH_SIZE
    });
  }

  public async getUpcomingEvents(userId: string | undefined, data: API.Community.getUpcomingEvents.Request): Promise<API.Community.getUpcomingEvents.Response> {
    return _getEventCTE(pool, {
      userId,
      where: `current_timestamp < (ce."scheduleDate" + (ce.duration ||' minutes')::interval)`,
      order: 'ASC',
      limit: config.EVENTS_BATCH_SIZE,
      onlyVerifiedOrFollowing: data.type,
      scheduledAfter: data.scheduledAfter,
      beforeAfterId: data.afterId,
      anyTags: data.anyTags,
      tags: data.tags
    });
  }

  public async createCommunityEvent(data: API.Community.createCommunityEvent.Request, callId: string | null, userId: string): Promise<API.Community.createCommunityEvent.Response> {
    const convertedDescription: Models.BaseArticle.ContentV2 | null = {
      version: '2',
      content: [{ type: 'text', value: data?.description || '' }]
    };

    let roleInsert: string = ``;
    if (data.rolePermissions === undefined) {
      roleInsert = `, (
        (SELECT id FROM insert_event),
        (SELECT id FROM member_role),
        ARRAY[${format("%L", MEMBER_PERMISSIONS)}]::"public"."communities_events_permissions_permissions_enum"[]
      )`;
    } else if (data.rolePermissions.length > 0) {
      const adminRoleQuery = await pool.query(`
        SELECT id
        FROM roles
        WHERE "communityId" = $1
          AND "type" = ${format("%L", RoleType.PREDEFINED)}
          AND "title" = ${format("%L", PredefinedRole.Admin)}
      `, [data.communityId]);

      const adminRole = adminRoleQuery.rows[0] as {
        id: string;
      };
      if (!adminRole) {
        throw new Error(errors.server.UNKNOWN);
      }
      data.rolePermissions = data.rolePermissions.filter(p => p.roleId !== adminRole.id);
      roleInsert = `,` + data.rolePermissions.map(role =>
        format(`(
          (SELECT id FROM insert_event),
          %L::uuid, 
          ARRAY[${format("%L", role.permissions)}]::"public"."communities_events_permissions_permissions_enum"[])
        `, role.roleId)).join(",");
    }

    const result = await pool.query(`
      WITH insert_event AS (
        INSERT INTO communities_events (
          "communityId",
          "eventCreator",
          "url",
          "title",
          "description",
          "scheduleDate",
          "duration",
          "type",
          "imageId",
          "callId",
          "externalUrl",
          "location"
        ) VALUES (
          $1,
          $2,
          $3,
          $4,
          $5,
          $6,
          $7,
          $8,
          $9,
          $10,
          $11,
          $12
        ) RETURNING
          id,
          "communityId",
          "eventCreator",
          "url",
          "title",
          "description",
          "scheduleDate",
          "duration",
          "createdAt",
          "updatedAt",
          "deletedAt",
          "type",
          "imageId",
          "callId",
          "externalUrl",
          "location"
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
      ), insert_participants AS (
        INSERT INTO communities_events_participants (
          "eventId",
          "userId"
        ) VALUES (
          (SELECT "id" FROM insert_event),
          $2
        )
      ), permission_insert AS (
        INSERT INTO communities_events_permissions (
          "communityEventId",
          "roleId",
          "permissions"
        )
        VALUES (
          (SELECT id FROM insert_event),
          (SELECT id FROM admin_role),
          ARRAY[${format("%L", MODERATOR_PERMISSIONS)}]::"public"."communities_events_permissions_permissions_enum"[]
        ) 
        ${roleInsert}
        RETURNING
          "roleId",
          "permissions"
      )
      SELECT 
        ie.id,
        ie."communityId",
        ie."eventCreator",
        ie."url",
        ie."title",
        ie."description",
        ie."externalUrl",
        ie."location",
        ie."scheduleDate",
        ie."duration",
        ie."createdAt",
        ie."updatedAt",
        ie."deletedAt",
        ie."type",
        ie."imageId",
        ie."callId",
        (SELECT array_to_json(array_agg(json_build_object(
          'roleId', "roleId",
          'roleTitle', (SELECT "title" FROM roles r WHERE r."id" = "roleId"),
          'permissions', "permissions"
        ))) FROM permission_insert) AS "rolePermissions",
        (SELECT array_agg("userId") FROM communities_events_participants WHERE "eventId" = ie.id) AS "participantIds",
        (SELECT count(*) FROM communities_events_participants WHERE "eventId" = ie.id) AS "participantCount",
        TRUE AS "isSelfAttending"
      FROM insert_event ie`,
      [
        data.communityId,
        userId,
        data.url,
        data.title,
        convertedDescription,
        data.scheduleDate,
        data.duration,
        data.type,
        data.imageId,
        callId,
        data.externalUrl,
        data.location
      ]
    );

    if (result.rows.length === 1) {
      return result.rows[0] as {
        id: string;
        communityId: string;
        eventCreator: string;
        url: string;
        title: string;
        description: Models.BaseArticle.ContentV2;
        externalUrl: string | null;
        location: string | null;
        scheduleDate: string;
        duration: number;
        createdAt: string;
        updatedAt: string;
        deletedAt: string | null;
        type: Models.Community.EventType;
        imageId: string;
        callId: string;
        rolePermissions: {
          roleId: string;
          roleTitle: string;
          permissions: CommunityEventPermission[];
        }[];
        participantIds: string[];
        participantCount: number;
        isSelfAttending: boolean;
      };
    }

    throw new Error("Community Event creation failed");
  }

  public async deleteCommunityEvent(eventId: string): Promise<API.Community.deleteCommunityEvent.Response> {
    await pool.query(`
      WITH event_call AS (
        SELECT "callId"
        FROM communities_events
        WHERE id = $1
      ) UPDATE calls
      SET "endedAt" = NOW(), "updatedAt" = NOW()
      WHERE id = (SELECT "callId" FROM event_call)
    `, [eventId]);

    const result = await pool.query(`
      UPDATE communities_events
      SET
        "deletedAt" = NOW(), "updatedAt" = NOW()
      WHERE id = $1
      RETURNING id
    `, [eventId]);
    if (result.rows.length === 1) {
      return;
    }
    throw new Error(errors.server.NOT_FOUND);
  }

  public async updateCommunityEvent(data: API.Community.updateCommunityEvent.Request): Promise<Models.Community.Event & {
    participantIds: string[];
    participantCount: number;
    isSelfAttending: boolean;
  }> {
    //check if the event schedule date is changed
    const eventData = await pool.query<{
      scheduleDate: string;
      callId: string | null;
      type: Models.Community.EventType;
      communityId: string;
      eventCreator: string;
    }>(`
      SELECT
        "scheduleDate",
        "callId",
        "type",
        "communityId",
        "eventCreator"
      FROM communities_events
      WHERE id = $1
    `, [data.id]);
    if (eventData.rows.length === 0) {
      throw new Error(errors.server.NOT_FOUND);
    }
    const { scheduleDate, callId, type: eventType, communityId, eventCreator } = eventData.rows[0];
    if (
      (eventType === 'reminder' && data.type !== 'reminder') ||
      (eventType !== 'reminder' && data.type === 'reminder')
    ) {
      // Todo: To fix this, we need to create or delete the call on the fly
      console.error("Cannot change the event type from reminder to another type or vice versa.");
      throw new Error(errors.server.NOT_ALLOWED);
    }
    let callIdUpdate: string | undefined | null = undefined;
    if (eventType !== 'external' && data.type === 'external') {
      //delete the call
      if (!!callId) {
        await pool.query(`
          UPDATE calls
          SET "endedAt" = NOW(), "updatedAt" = NOW()
          WHERE id = $1
        `, [callId]);
        callIdUpdate = null;
      }
      else {
        console.warn(`Call id is already null for event ${data.id}, but event is meant to be changed from non-external to external, so callId should not be null.`);
      }
    } else if (eventType === 'external' && data.type !== 'external') {
      if (!data.callData) {
        throw new Error(errors.server.MISSING_CALL_DATA);
      }
      //create a call
      const callResult = await callHelper.createCall({
        communityId,
        title: data.title,
        description: data.description,
        callType: data.type === 'broadcast' ? 'broadcast' : 'default',
        audioOnly: data.callData.audioOnly,
        callCreator: eventCreator,
        hd: data.callData.hd,
        stageSlots: data.callData.stageSlots,
        slots: data.callData.slots,
        rolePermissions: convertEventPermissionToCallPermission(data.rolePermissions),
      }, data.scheduleDate);
      if (callResult === null) {
        throw new Error(errors.server.UPDATE_EVENT_CREATE_CALL_FAILED);
      }
      callIdUpdate = callResult.id;
    }
    if (scheduleDate !== data.scheduleDate && callId !== null) {
      // update the call schedule date
      try {
        await pool.query(`
          UPDATE calls
          SET
            "scheduleDate" = $1, "updatedAt" = NOW()
          WHERE id = $2
          RETURNING id
        `, [data.scheduleDate, callId]);
      } catch (error) {
        throw new Error(errors.server.INTERNAL);
      }
    }

    //update the call permissions
    if (!!callId && !callIdUpdate) {
      await callHelper.updateCallPermissions(callId, communityId, convertEventPermissionToCallPermission(data.rolePermissions));
    }

    let roleInsert: string = await this.getRoles(communityId, data.rolePermissions);

    const convertedDescription: Models.BaseArticle.ContentV2 | null = {
      version: '2',
      content: [{ type: 'text', value: data?.description || '' }]
    };

    //delete the old permissions
    await pool.query(`
      DELETE FROM communities_events_permissions
      WHERE "communityEventId" = $1
    `, [data.id]);

    const result = await pool.query(`
      WITH update_event AS (
        UPDATE communities_events
        SET
          "title" = $1,
          "description" = $2,
          "scheduleDate" = $3,
          "duration" = $4,
          "type" = $5,
          "imageId" = $6,
          "externalUrl" = $8,
          "location" = $9
          ${callIdUpdate !== undefined ? format(', "callId" = %L', callIdUpdate) : ''}
        WHERE id = $7
        RETURNING
          id,
          "communityId",
          "eventCreator",
          "url",
          "title",
          "description",
          "scheduleDate",
          "duration",
          "createdAt",
          "updatedAt",
          "deletedAt",  
          "type",
          "imageId",
          "callId",
          "externalUrl",
          "location"
      ), member_role AS (
        SELECT id
        FROM roles
        WHERE "communityId" = (SELECT "communityId" FROM update_event)
          AND "type" = ${format("%L", RoleType.PREDEFINED)}
          AND "title" = ${format("%L", PredefinedRole.Member)}
      ), admin_role AS (
        SELECT id
        FROM roles
        WHERE "communityId" = (SELECT "communityId" FROM update_event)
          AND "type" = ${format("%L", RoleType.PREDEFINED)}
          AND "title" = ${format("%L", PredefinedRole.Admin)}
      ), permission_insert AS (
        INSERT INTO communities_events_permissions (
          "communityEventId",
          "roleId",
          "permissions"
        )
        VALUES (
          (SELECT id FROM update_event),
          (SELECT id FROM admin_role),
          ARRAY[${format("%L", MODERATOR_PERMISSIONS)}]::"public"."communities_events_permissions_permissions_enum"[]
        ) 
        ${roleInsert}
        RETURNING
          "roleId",
          "permissions"
      )
      SELECT 
        ue.id,
        ue."communityId",
        ue."eventCreator",
        ue."url",
        ue."title",
        ue."description",
        ue."scheduleDate",
        ue."duration",
        ue."createdAt",
        ue."updatedAt",
        ue."deletedAt",
        ue."type",
        ue."imageId",
        ue."callId",
        ue."externalUrl",
        ue."location",
        (SELECT array_to_json(array_agg(json_build_object(
          'roleId', "roleId",
          'roleTitle', (SELECT "title" FROM roles r WHERE r."id" = "roleId"),
          'permissions', "permissions"
        ))) FROM permission_insert) AS "rolePermissions",
        (SELECT array_agg("userId") FROM communities_events_participants WHERE "eventId" = ue.id) AS "participantIds",
        (SELECT count(*) FROM communities_events_participants WHERE "eventId" = ue.id) AS "participantCount",
        TRUE AS "isSelfAttending"
      FROM update_event ue
    `, [
      data.title,
      convertedDescription,
      data.scheduleDate,
      data.duration,
      data.type,
      data.imageId,
      data.id,
      data.externalUrl,
      data.location,
    ]);

    if (result.rows.length === 1) {
      const successResult = result.rows[0] as {
        id: string;
        communityId: string;
        eventCreator: string;
        url: string | null;
        title: string;
        description: Models.BaseArticle.ContentV2;
        externalUrl: string | null;
        location: string | null;
        scheduleDate: string;
        duration: number;
        createdAt: string;
        updatedAt: string;
        type: Models.Community.EventType;
        imageId: string;
        rolePermissions: {
          roleId: string;
          roleTitle: string;
          permissions: CommunityEventPermission[];
        }[];
        participantIds: string[];
        participantCount: number;
        isSelfAttending: boolean;
        callId: string;
        deletedAt: string | null;
      };

      const updateEventMembers = await pool.query(`
        DELETE FROM communities_events_participants
        WHERE "eventId" = $1
        AND NOT EXISTS (
          SELECT 1
          FROM roles_users_users ruu
          INNER JOIN communities_events_permissions cep
            ON cep."roleId" = ruu."roleId"
          WHERE ruu."userId" = communities_events_participants."userId"
            AND cep."communityEventId" = $1
            AND cep."permissions" @> ARRAY['EVENT_ATTEND']::"public"."communities_events_permissions_permissions_enum"[]
        ) RETURNING "userId"`, [data.id]);
      if ((updateEventMembers.rowCount ?? 0) > 0) {
        //update the successResult.participantIds and successResult.participantCount
        successResult.participantIds = successResult.participantIds.filter(id => !updateEventMembers.rows.find(row => row.userId === id));
        successResult.participantCount = successResult.participantIds.length;
      }
      return successResult;
    }
    throw new Error("Community Event update failed");
  }

  public async getCommunityEvent(data: API.Community.getEvent.Request, userId?: string): Promise<API.Community.getEvent.Response> {
    const result = await _getEventCTE(pool, {
      userId,
      where: `${'id' in data
        ? format("ce.id = %L::UUID", data.id)
        : format("ce.url = %L", data.url)
        }`,
    });

    if (result.length === 1) {
      return result[0];
    }

    throw new Error(errors.server.NOT_FOUND);
  }

  public async getEventParticipants(eventId: string): Promise<API.Community.getEventParticipants.Response> {
    // Leaving an event DELETEs the participant row (eventParticipantLeave), so
    // there is no "leftAt" column to filter on — the table has only eventId,
    // userId, createdAt. The stale "leftAt IS NULL" clause errored 42703.
    const result = await pool.query(`
      SELECT
        "userId"
      FROM communities_events_participants
      WHERE "eventId" = $1
    `, [eventId]);

    if (result.rows.length === 0) {
      return [];
    }

    return result.rows.map((row) => row.userId);
  }

  public async insertEventParticipantByCallId(userId: string, data: API.Community.addEventParticipantByCallId.Request) {
    const result = await pool.query(`
      INSERT INTO communities_events_participants (
        "eventId",
        "userId"
      ) VALUES (
        (SELECT "id" FROM communities_events WHERE "callId" = $1),
        $2
      ) ON CONFLICT ("eventId", "userId")
        DO NOTHING
      RETURNING
        "eventId",
        "userId"
    `, [
      data.callId,
      userId
    ]);
    if (result.rows.length === 1) {
      return result.rows[0];
    } else {
      return null;
    }
  }

  public async insertEventParticipant(userId: string, data: API.Community.addEventParticipant.Request) {
    //check wether the user has a role with the COMMUNITY event attend permission
    const hasPermissionQuery = await pool.query(`
      SELECT
        "roleId"
      FROM communities_events_permissions
      WHERE "communityEventId" = $1
      AND "roleId" IN (
        SELECT "roleId"
        FROM roles_users_users
        WHERE "userId" = $2
        AND "claimed" = TRUE
      )
      AND "permissions" @> ARRAY[${format("%L", CommunityEventPermission.EVENT_ATTEND)}]::"public"."communities_events_permissions_permissions_enum"[]
    `, [data.eventId, userId]);
    const hasPermission = hasPermissionQuery.rows.length > 0;

    if (!hasPermission) {
      throw new Error(errors.server.NOT_ALLOWED);
    }

    const result = await pool.query(`
      INSERT INTO communities_events_participants (
        "eventId",
        "userId"
      ) VALUES (
        $1,
        $2
      ) ON CONFLICT ("eventId", "userId")
        DO UPDATE SET "createdAt" = now()
      RETURNING
        "eventId",
        "userId"
    `, [
      data.eventId,
      userId
    ]);
    if (result.rows.length === 1) {
      return result.rows[0];
    } else {
      throw new Error(errors.server.INTERNAL);
    }
  }

  public async eventParticipantLeave(userId: string, data: API.Community.removeEventParticipant.Request) {
    const result = await pool.query(`
      DELETE FROM communities_events_participants
      WHERE "eventId" = $1
      AND "userId" = $2
      RETURNING "eventId"
    `, [
      data.eventId,
      userId
    ]);
    if (result.rows.length === 1) {
      return;
    } else {
      throw new Error(errors.server.NOT_FOUND);
    }
  }

  public async getUserIdsToNotify({ eventId }: { eventId: string }) {
    // return event participants that not left
    const result = await pool.query(`
      SELECT
        "userId"
      FROM communities_events_participants
      WHERE "eventId" = $1
    `, [eventId]);
    return result.rows.map((row) => row.userId);
  }

  public async getUserEmailsToNotify({ eventId }: { eventId: string }): Promise<string[]> {
    // return event participants that not left
    const result = await pool.query(`
      SELECT
        u."email"
      FROM communities_events_participants cep
      INNER JOIN users u
        ON u.id = cep."userId"
      WHERE cep."eventId" = $1 AND u."emailVerified" = TRUE
    `, [eventId]);
    return result.rows.map((row) => row.email);
  }

  public async getCommunityEventSocialPreview(data: { uuid: string } | { url: string }) {
    const result = await pool.query(`
      SELECT
        ce."title",
        ce."scheduleDate",
        ce."type",
        ce."imageId",
        ce."communityId",
        c."title" as "communityTitle",
        c."official" as "communityOfficial",
        c."logoSmallId" as "communityLogoSmallId"
      FROM communities_events ce
      INNER JOIN communities c ON c.id = ce."communityId"
      WHERE ${'uuid' in data
        ? format("ce.id = %L::UUID", data.uuid)
        : format("ce.url = %L", data.url)
      }
    `);

    if (result.rows.length === 1) {
      return result.rows[0] as {
        title: string;
        scheduleDate: string;
        type: Models.Community.EventType;
        imageId: string;
        communityId: string;
        communityTitle: string;
        communityOfficial: boolean
        communityLogoSmallId: string;
      }
    } else {
      throw new Error(errors.server.NOT_FOUND);
    }
  }

  public async isEventOngoingOrInPast(eventId: string) {
    const result = await pool.query(`
      SELECT
        "scheduleDate"
      FROM communities_events ce
      WHERE ce.id = $1
    `, [eventId]);
    if (result.rows.length === 0) {
      throw new Error(errors.server.NOT_FOUND);
    }
    const { scheduleDate } = result.rows[0];
    const scheduleDateObj = new Date(scheduleDate);
    const now = new Date();
    return now >= scheduleDateObj;
  }

  private async getRoles(communityId: string, rolePermissions: API.Community.createCommunityEvent.Request['rolePermissions']) {
    let roleInsert: string = ``;
    if (rolePermissions === undefined) {
      roleInsert = `, (
        (SELECT id FROM update_event),
        (SELECT id FROM member_role),
        ARRAY[${format("%L", MEMBER_PERMISSIONS)}]::"public"."communities_events_permissions_permissions_enum"[]
      )`;
    } else if (rolePermissions.length > 0) {
      const adminRoleQuery = await pool.query(`
        SELECT id
        FROM roles
        WHERE "communityId" = $1
          AND "type" = ${format("%L", RoleType.PREDEFINED)}
          AND "title" = ${format("%L", PredefinedRole.Admin)}
      `, [communityId]);

      const adminRole = adminRoleQuery.rows[0] as {
        id: string;
      };
      if (!adminRole) {
        throw new Error(errors.server.UNKNOWN);
      }
      rolePermissions = rolePermissions.filter(p => p.roleId !== adminRole.id);
      roleInsert = `,` + rolePermissions.map(role =>
        format(`(
          (SELECT id FROM update_event),
          %L::uuid, 
          ARRAY[${format("%L", role.permissions)}]::"public"."communities_events_permissions_permissions_enum"[])
        `, role.roleId)).join(",");
    }
    return roleInsert;
  }

  public async prepareEventToSendEmail(eventId: string, userId: string, type: "attending" | "starting" | "changed" | "cancelled", existingEvent?: Models.Community.Event): Promise<EventEmailOptions> {
    let event;
    if(existingEvent) {
      event = existingEvent;
    } else {
      event = await this.getCommunityEvent({ id: eventId }, userId);
    }
    // query to get the community data (ir, title, image, url)
    const communityDataResult = await pool.query<{id: string, title: string, url: string, imageId?: string, }>(`
      SELECT
        c."id",
        c."title",
        c."logoSmallId" as "imageId",
        c."url"
      FROM communities c
      WHERE c.id = $1
    `, [event.communityId]);
    if (communityDataResult.rows.length === 0) {
      throw new Error(errors.server.NOT_FOUND);
    }
    const communityData = communityDataResult.rows[0];
    const result: EventEmailOptions = {
      type,
      community: communityData.title,
      communityId: event.communityId,
      communityUrl: communityData.url,
      event,
      communityImage: communityData.imageId,
    }

    const newCommunityImage = await fileHelper.getSignedUrls([result.communityImage || '']);
    result.communityImage = newCommunityImage[0]?.url;
    
    return result;
  }

  public async getUpcomingEventsToNotify(): Promise<{eventId: string, userEmails: string[], userParticipantIds: string[]}[]> {
    const query = `
      SELECT
        ce.id as "eventId",
        array_agg(u.email) as "userEmails",
        array_agg(u.id) as "userParticipantIds"
      FROM communities_events ce
      INNER JOIN communities_events_participants cep
        ON ce.id = cep."eventId"
      INNER JOIN users u
        ON cep."userId" = u.id
      WHERE ce."scheduleDate" < now() + interval '15 minutes'
      AND ce."scheduleDate" > now()
      AND ce."eventNotified" = FALSE
      AND u."emailVerified" = TRUE
      GROUP BY ce.id
    `;
    
    // Execute the query and return the results
    const result = await pool.query<{eventId: string, userEmails: string[], userParticipantIds: string[]}>(query);
    return result.rows;
  }

  public async markEventAsNotified(eventId: string) {
    await pool.query(`
      UPDATE communities_events
      SET "eventNotified" = TRUE,
          "updatedAt" = now()
      WHERE id = $1
    `, [eventId]);
  }
}


const communityEventHelper = new CommunityEventHelper();
export default communityEventHelper;