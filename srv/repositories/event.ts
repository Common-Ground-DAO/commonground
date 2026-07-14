// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Emitter } from "@socket.io/redis-emitter";
import {
  articleRoomKey,
  botTokenRoomKey,
  communityRoomKey,
  deviceRoomKey,
  expressSessionRoomKey,
  roleRoomKey,
  userRoomKey,
} from "../util";
import redisManager from "../redis";
import notificationHelper from "./notifications";

class EventHelper {
  #io = (async () => {
    await redisManager.isReady;
    return new Emitter<API.Server.ClientToServerEvents>(redisManager.getClient('socketIOPub'), { key: 'v2:' });
  })();

  public async emit(
    event: Events.ClientEvent,
    target: {
      userIds?: string[];
      roleIds?: string[];
      communityIds?: string[];
      deviceIds?: string[];
      sessionIds?: string[];
      articleIds?: string[];
    },
    except?: {
      userIds?: string[];
      roleIds?: string[];
      communityIds?: string[];
      deviceIds?: string[];
      sessionIds?: string[];
      articleIds?: string[];
    },
  ) {
    const io = await this.#io;
    const rooms: string[] = [];
    const exceptRooms: string[] = [];
    for (const userId of target.userIds || []) {
      rooms.push(userRoomKey(userId));
    }
    for (const roleId of target.roleIds || []) {
      rooms.push(roleRoomKey(roleId));
    }
    for (const communityId of target.communityIds || []) {
      rooms.push(communityRoomKey(communityId));
    }
    for (const deviceId of target.deviceIds || []) {
      rooms.push(deviceRoomKey(deviceId));
    }
    for (const sessionId of target.sessionIds || []) {
      rooms.push(expressSessionRoomKey(sessionId));
    }
    for (const articleId of target.articleIds || []) {
      rooms.push(articleRoomKey(articleId));
    }
    if (!!except) {
      for (const userId of except.userIds || []) {
        exceptRooms.push(userRoomKey(userId));
      }
      for (const roleId of except.roleIds || []) {
        exceptRooms.push(roleRoomKey(roleId));
      }
      for (const communityId of except.communityIds || []) {
        exceptRooms.push(communityRoomKey(communityId));
      }
      for (const deviceId of except.deviceIds || []) {
        exceptRooms.push(deviceRoomKey(deviceId));
      }
      for (const sessionId of except.sessionIds || []) {
        exceptRooms.push(expressSessionRoomKey(sessionId));
      }
      for (const articleId of except.articleIds || []) {
        exceptRooms.push(articleRoomKey(articleId));
      }
    }
    const { type, ..._event } = event;
    if (rooms.length > 0) {
      if (exceptRooms.length === 0) {
        io.to(rooms).emit(type, _event);
      }
      else {
        io.to(rooms).except(exceptRooms).emit(type, _event);
      }
    }
  }

  public async userJoinRooms(
    userId: string,
    target: {
      roleIds?: string[];
      communityIds?: string[];
      articleIds?: string[];
    }
  ) {
    const rooms: string[] = [];
    for (const roleId of target.roleIds || []) {
      rooms.push(roleRoomKey(roleId));
    }
    for (const communityId of target.communityIds || []) {
      rooms.push(communityRoomKey(communityId));
    }
    for (const articleId of target.articleIds || []) {
      rooms.push(articleRoomKey(articleId));
    }
    const io = await this.#io;
    io.in(userRoomKey(userId)).socketsJoin(rooms);
  }

  public async userLeaveRooms(
    userId: string,
    target: {
      roleIds?: string[];
      communityIds?: string[];
      articleIds?: string[];
    }
  ) {
    const rooms: string[] = [];
    for (const roleId of target.roleIds || []) {
      rooms.push(roleRoomKey(roleId));
    }
    for (const communityId of target.communityIds || []) {
      rooms.push(communityRoomKey(communityId));
    }
    for (const articleId of target.articleIds || []) {
      rooms.push(articleRoomKey(articleId));
    }
    const io = await this.#io;
    io.in(userRoomKey(userId)).socketsLeave(rooms);
  }

  public async sendWsOrWebPushNotificationEvent(data: {
    userId: string;
    event: Events.Notification.Notification & { action: "new" };
  }) {
    await notificationHelper.sendWsOrWebPushNotificationEvent(data);
  }

  public async deviceJoinRooms(
    deviceId: string,
    target: {
      roleIds?: string[];
      communityIds?: string[];
      articleIds?: string[];
    }
  ) {
    const rooms: string[] = [];
    for (const roleId of target.roleIds || []) {
      rooms.push(roleRoomKey(roleId));
    }
    for (const communityId of target.communityIds || []) {
      rooms.push(communityRoomKey(communityId));
    }
    for (const articleId of target.articleIds || []) {
      rooms.push(articleRoomKey(articleId));
    }
    const io = await this.#io;
    io.in(deviceRoomKey(deviceId)).socketsJoin(rooms);
  }

  public async deviceLeaveRooms(
    deviceId: string,
    target: {
      roleIds?: string[];
      communityIds?: string[];
      articleIds?: string[];
    }
  ) {
    const rooms: string[] = [];
    for (const roleId of target.roleIds || []) {
      rooms.push(roleRoomKey(roleId));
    }
    for (const communityId of target.communityIds || []) {
      rooms.push(communityRoomKey(communityId));
    }
    for (const articleId of target.articleIds || []) {
      rooms.push(articleRoomKey(articleId));
    }
    const io = await this.#io;
    io.in(deviceRoomKey(deviceId)).socketsLeave(rooms);
  }

  public async disconnectBotTokenSockets(tokenId: string) {
    const io = await this.#io;
    io.in(botTokenRoomKey(tokenId)).disconnectSockets(true);
  }
}

const eventHelper = new EventHelper();
export default eventHelper;
