// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from '../common/errors';
import config from '../common/config';
import format from "pg-format";
import pool from "../util/postgres";
import { NotificationType } from '../common/enums';
import { dockerSecret } from '../util';
import webPush, { WebPushError } from 'web-push';
import eventHelper from './event';

const __vapidKeyData = dockerSecret('vapid_keys_json');
const vapidKeyData =
  !!__vapidKeyData
    ? JSON.parse(__vapidKeyData) as {
      publicKey: string;
      privateKey: string;
    }
    : undefined;

if (!!vapidKeyData) {
  webPush.setVapidDetails(
    "mailto:ola@dao.cg",
    vapidKeyData.publicKey,
    vapidKeyData.privateKey,
  );
}

class NotificationHelper {
  public async createNotifications(
    data: (Omit<Models.Notification.Notification, "id" | "read" | "createdAt" | "updatedAt"> & { userId: string })[],
  ) {
    if (data.length === 0) {
      return [];
    }
    const values = data.map(d => format(`(
        %L::UUID,
        %L,
        %L::"public"."notifications_type_enum",
        %L::UUID,
        %L::UUID,
        %L::UUID,
        %L::JSONB
      )`,
      d.userId,
      d.text,
      d.type,
      d.subjectItemId,
      d.subjectCommunityId,
      d.subjectUserId,
      JSON.stringify(d.extraData),
    ));
    const result = await pool.query(`
      INSERT INTO notifications (
        "userId",
        "text",
        "type",
        "subjectItemId",
        "subjectCommunityId",
        "subjectUserId",
        "extraData"
      )
      VALUES ${values.join(",")}
      RETURNING "id", "createdAt", "updatedAt"
    `);
    if (result.rows.length > 0) {
      const rows: { id: string, createdAt: string, updatedAt: string }[] = result.rows;
      return rows;
    } else {
      throw new Error("Could not create or update user notifications");
    }
  }

  public async updateNotification(
    userId: string,
    data: Omit<Models.Notification.Notification, "id" | "read" | "createdAt" | "updatedAt">
  ) {
    throw new Error("Todo");
    const query = `
      WITH update_notification AS (
        UPDATE notifications
        SET
          "text" = $2::TEXT,
          "extraData" = $7::JSONB,
          "updatedAt" = now()
        WHERE
          "userId" = $1::UUID AND
          "type" = $3 AND
          "subjectItemId" = $4::UUID AND
          "subjectCommunityId" = $5::UUID AND
          "subjectUserId" = $6::UUID
        RETURNING "id", "createdAt", "updatedAt", 1 AS "inserted"
      ), insert_select AS (
        SELECT ($1::UUID, $2::TEXT, $3, $4::UUID, $5::UUID, $6::UUID, $7::JSONB)
        WHERE NOT EXISTS (SELECT 1 FROM update_notification)
      ), insert_notification AS (
        INSERT INTO notifications (
          "userId",
          "text",
          "type",
          "subjectItemId",
          "subjectCommunityId",
          "subjectUserId",
          "extraData"
        )
        VALUES (SELECT * FROM insert_select)
        RETURNING "id", "createdAt", "updatedAt", 0 AS "inserted"
      )
      SELECT * FROM update_notification
      UNION
      SELECT * FROM insert_notification
    `;
    const params: any[] = [
      userId,
      data.text,
      data.type,
      'subjectItemId' in data ? data.subjectItemId : null,
      'subjectCommunityId' in data ? data.subjectCommunityId : null,
      'subjectUserId' in data ? data.subjectUserId : null,
      'extraData' in data ? data.extraData : null,
    ];
    const result = await pool.query(query, params);
    if (result.rows.length > 0) {
      const rows: { id: string, createdAt: string, updatedAt: string, inserted: 0 | 1 }[] = result.rows;
      return rows.reduce<{
        inserted: Models.Notification.Notification[],
        updated: Models.Notification.Notification[],
      }>((agg, row) => {
        const { inserted, ...rest } = row;
        if (inserted === 1) {
          agg.inserted.push({ ...data, ...rest, read: false } as any);
        } else {
          agg.updated.push({ ...data, ...rest, read: false } as any);
        }
        return agg;
      }, { inserted: [], updated: [] });
    } else {
      console.error("Could not create or update user notifications");
    }
  }

  public async loadNotifications(
    userId: string,
    data: API.Notification.loadNotifications.Request
  ) {
    const fragments: string[] = ['"userId" = $1'];
    if (!!data.createdAfter) {
      fragments.push(format('"createdAt" > %L::timestamptz', data.createdAfter));
    }
    if (!!data.createdBefore) {
      fragments.push(format('"createdAt" < %L::timestamptz', data.createdBefore));
    }
    if (!!data.unreadOnly) {
      fragments.push('"read" = FALSE')
    }
    const query = `
      SELECT
        "id",
        "text",
        "createdAt",
        "updatedAt",
        "type",
        "read",
        "subjectItemId",
        "subjectCommunityId",
        "subjectUserId",
        "subjectArticleId",
        "extraData"
      FROM notifications
      WHERE
        ${fragments.join(' AND ')}
      ORDER BY "createdAt" ${data.order === 'ASC' ? 'ASC' : 'DESC'}
      LIMIT ${+config.NOTIFICATIONS_BATCH_SIZE}
    `;
    const params: any[] = [userId];
    const result = await pool.query(query, params);
    return result.rows as {
      id: string;
      text: string;
      createdAt: string;
      updatedAt: string;
      type: NotificationType;
      read: boolean;
      subjectItemId: string | null;
      subjectCommunityId: string | null;
      subjectUserId: string | null;
      subjectArticleId: string | null;
      extraData: Models.Notification.ExtraData | null;
    }[];
  }
  
  public async loadUpdates(
    userId: string,
    data: API.Notification.loadUpdates.Request
  ) {
    const fragments: string[] = ['"userId" = $1'];
    if (!!data.createdStart) {
      fragments.push(format('"createdAt" >= %L::timestamptz', data.createdStart));
    }
    if (!!data.createdEnd) {
      fragments.push(format('"createdAt" <= %L::timestamptz', data.createdEnd));
    }
    if (!!data.updatedAfter) {
      fragments.push(format('"updatedAt" > %L::timestamptz', data.updatedAfter));
    }
    const query = `
      SELECT
        "id",
        "text",
        "createdAt",
        "updatedAt",
        "type",
        "read",
        "subjectItemId",
        "subjectCommunityId",
        "subjectUserId",
        "subjectArticleId",
        "extraData",
        "deletedAt"
      FROM notifications
      WHERE
        ${fragments.join(' AND ')}
    `;
    const params: any[] = [userId];
    const result = await pool.query(query, params);
    return result.rows as {
      id: string;
      text: string;
      createdAt: string;
      updatedAt: string;
      type: NotificationType;
      read: boolean;
      subjectItemId: string | null;
      subjectCommunityId: string | null;
      subjectUserId: string | null;
      subjectArticleId: string | null;
      extraData: Models.Notification.ExtraData | null;
      deletedAt: string | null;
    }[];
  }

  public async getUnreadCount(userId: string) {
    const query = `
      SELECT COUNT(*) AS "unreadCount"
      FROM notifications
      WHERE "userId" = $1 AND "read" = FALSE
    `;
    const params: any[] = [userId];
    const result = await pool.query(query, params);
    return result.rows[0].unreadCount as number;
  }

  public async markAsRead(userId: string, data: API.Notification.markAsRead.Request) {
    const query = `
      UPDATE notifications
      SET "read" = TRUE, "updatedAt" = now()
      WHERE "userId" = $1 AND "id" = $2
      RETURNING "updatedAt"
    `;
    const params: any[] = [userId, data.notificationId];
    const result = await pool.query(query, params);
    if (result.rows.length !== 1) {
      throw new Error(errors.server.NOT_FOUND);
    }
    return result.rows[0] as {
      updatedAt: string;
    };
  }

  public async markAllAsRead(userId: string) {
    const query = `
      UPDATE notifications
      SET "read" = TRUE, "updatedAt" = now()
      WHERE "userId" = $1
      RETURNING "updatedAt"
    `;
    const params: any[] = [userId];
    const result = await pool.query(query, params);
    return {
      updatedAt: result.rows[0]?.updatedAt || new Date().toISOString(),
    };
  }

  public getPublicVapidKey() {
    if (!vapidKeyData) {
      throw new Error(errors.server.NOT_FOUND);
    }
    return vapidKeyData.publicKey;
  }

  public async registerWebPushSubscription(data: Models.Notification.PushSubscription, deviceId: string) {
    const result = await pool.query(`
      UPDATE devices
      SET "webPushSubscription" = ${format("%L::JSONB", JSON.stringify(data))}
      WHERE "id" = ${format("%L::UUID", deviceId)}
        AND "deletedAt" IS NULL
        -- not a key the account signed out (docs/auth-identity §2)
        AND "generation" >= session_generation_of("userId")
    `);
    if (result.rowCount !== 1) {
      throw new Error(errors.server.NOT_FOUND);
    }
  }

  public async unregisterWebPushSubscription(deviceId: string) {
    await pool.query(`
      UPDATE devices
      SET "webPushSubscription" = NULL
      WHERE "id" = ${format("%L::UUID", deviceId)}
    `);
  }

  public async sendWsOrWebPushNotificationEvent({
    userId,
    event,
    excludeDeviceId,
  }: {
    userId: string;
    event: Events.Notification.Notification & { action: "new" };
    excludeDeviceId?: string;
  }) {
    let devicesWithPush: {
      deviceId: string;
      webPushSubscription: Models.Notification.PushSubscription;
      dmNotifications?: boolean;
    }[] = [];
    const { subjectCommunityId } = event.data;
    if (!!subjectCommunityId) {
      const result = await pool.query<{
        subscriptionData: {
          deviceId: string;
          webPushSubscription: Models.Notification.PushSubscription;
        }[];
        notifyMentions: boolean;
        notifyReplies: boolean;
        notifyPosts: boolean;
        notifyEvents: boolean;
        notifyCalls: boolean;
      }>(`
        SELECT
          json_agg(json_build_object(
            'deviceId', d.id,
            'webPushSubscription', d."webPushSubscription"
          )) AS "subscriptionData",
          ucs."notifyMentions",
          ucs."notifyReplies",
          ucs."notifyPosts",
          ucs."notifyEvents",
          ucs."notifyCalls"

        FROM user_community_state ucs

        INNER JOIN devices d
          ON d."userId" = ucs."userId"
          AND d."deletedAt" IS NULL
          AND d."webPushSubscription" IS NOT NULL
          -- not a key the account signed out (docs/auth-identity §2)
          AND d."generation" >= session_generation_of(d."userId")

        WHERE ucs."communityId" = $1
          AND ucs."userId" = $2

        GROUP BY
          d."userId",
          ucs."notifyMentions",
          ucs."notifyReplies",
          ucs."notifyPosts",
          ucs."notifyEvents",
          ucs."notifyCalls"
      `, [subjectCommunityId, userId]);
      const settingsWithSubscriptions = result.rows[0] as (typeof result.rows[0] | undefined);
      if (settingsWithSubscriptions) {
        switch (event.data.type) {
          case "Call":
            if (!settingsWithSubscriptions.notifyCalls) return;
            break;
          case "Mention":
            if (!settingsWithSubscriptions.notifyMentions) return;
            break;
          case "Reply":
            if (!settingsWithSubscriptions.notifyReplies) return;
            break;
        }
      }
      devicesWithPush = settingsWithSubscriptions?.subscriptionData || [];
    }
    else {
      const result = await pool.query<{
        deviceId: string;
        webPushSubscription: Models.Notification.PushSubscription;
        dmNotifications: boolean;
      }>(`
        SELECT
          d."webPushSubscription",
          d."id" AS "deviceId",
          u."dmNotifications"
        FROM devices d INNER JOIN users u ON d."userId" = u."id"
        WHERE d."userId" = ${format("%L::UUID", userId)}
          AND d."webPushSubscription" IS NOT NULL
          AND d."deletedAt" IS NULL
          -- not a key the account signed out (docs/auth-identity §2)
          AND d."generation" >= u."sessionGeneration"
      `);
      devicesWithPush = result.rows;
    }

    const eventString = JSON.stringify(event);
    for (const item of devicesWithPush) {
      if (item.deviceId === excludeDeviceId) {
        continue;
      }
      if (event.data.type === 'DM' && !item.dmNotifications) {
        continue;
      }

      webPush.sendNotification(
        item.webPushSubscription,
        eventString,
        {
          urgency: "high",
        },
      ).catch(e => {
        if (e instanceof WebPushError) {
          if (e.statusCode === 410 || e.statusCode === 404) {
            // Subscription has been deleted
            console.log(`Received status 410 or 404 for push, removing webPushSubscription from device ${item.deviceId}`);
            return pool.query(`
              UPDATE devices
              SET "webPushSubscription" = NULL
              WHERE id = $1::uuid
            `, [item.deviceId]);
          }
          else {
            console.error(`Received statusCode ${e.statusCode} when trying to send webPush`);
            console.error(e);
          }
        }
        else {
          console.error("Unknown error received from webPush.sendNotification");
          console.error(e);
        }
      });
    }
    // DMs, ChannelMessages and Calls do not create an entry in the notification list
    if (!(
      (event.action === "new" && event.data.type === 'DM') ||
      event.data.type === 'ChannelMessage' ||
      event.data.type === 'Call'
    )) {
      await eventHelper.emit(event, {
        userIds: [userId],
      });
    }
  }
}

const notificationHelper = new NotificationHelper();
export default notificationHelper;