// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Emitter } from "@socket.io/redis-emitter";
import {
  articleRoomKey,
  botTokenRoomKey,
  cgIdRequestRoomKey,
  communityRoomKey,
  deviceRoomKey,
  expressSessionRoomKey,
  roleRoomKey,
  userRoomKey,
} from "../util";
import redisManager from "../redis";
import { socketIoKey } from "../util/gateway";
import notificationHelper from "./notifications";
import { deviceSocketRoomKey, type RequestSockets } from "../util/requestSocket";

type JoinTarget = {
  roleIds?: string[];
  communityIds?: string[];
  articleIds?: string[];
};

function joinTargetRooms(target: JoinTarget) {
  return [
    ...(target.roleIds || []).map(roleRoomKey),
    ...(target.communityIds || []).map(communityRoomKey),
    ...(target.articleIds || []).map(articleRoomKey),
  ];
}

/**
 * The room that holds the sockets a request speaks for: one socket of the
 * session's device when the request names it, otherwise the whole device
 * (srv/util/requestSocket.ts).
 */
function requestSocketsRoom(sockets: RequestSockets) {
  return sockets.socketId !== null
    ? deviceSocketRoomKey(sockets.deviceId, sockets.socketId)
    : deviceRoomKey(sockets.deviceId);
}

class EventHelper {
  // created on first emit, so importing this module opens no connection.
  // It does not wait for the connection: PUBLISH queues until it is up and
  // fails after node-redis' command timeout, so an emit never blocks a
  // request for the length of an outage.
  #emitter: Emitter<API.Server.ClientToServerEvents> | undefined;
  get #io() {
    return Promise.resolve(this.#emitter ??= new Emitter<API.Server.ClientToServerEvents>(redisManager.getClient('socketIOPub'), { key: socketIoKey() }));
  }

  public async emit(
    event: Events.ClientEvent,
    target: {
      userIds?: string[];
      roleIds?: string[];
      communityIds?: string[];
      deviceIds?: string[];
      sessionIds?: string[];
      articleIds?: string[];
      // legacy CG ID: the socket that watches the popup request
      cgIdRequestIds?: string[];
    },
    except?: {
      userIds?: string[];
      roleIds?: string[];
      communityIds?: string[];
      deviceIds?: string[];
      sessionIds?: string[];
      articleIds?: string[];
      // one socket of a device (srv/util/requestSocket.ts): excludes nothing
      // unless that socket is logged in with that device
      deviceSockets?: { deviceId: string; socketId: string }[];
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
    for (const frontendRequestId of target.cgIdRequestIds || []) {
      rooms.push(cgIdRequestRoomKey(frontendRequestId));
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
      for (const { deviceId, socketId } of except.deviceSockets || []) {
        exceptRooms.push(deviceSocketRoomKey(deviceId, socketId));
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

  /**
   * Joins the sockets a request speaks for to the given rooms: only the
   * requesting socket when the request names one (nothing joins unless it is
   * a logged-in socket of the session's device), otherwise the whole device
   * as before.
   */
  public async requestSocketsJoinRooms(sockets: RequestSockets, target: JoinTarget) {
    const io = await this.#io;
    io.in(requestSocketsRoom(sockets)).socketsJoin(joinTargetRooms(target));
  }

  /** Counterpart of `requestSocketsJoinRooms`. */
  public async requestSocketsLeaveRooms(sockets: RequestSockets, target: JoinTarget) {
    const io = await this.#io;
    io.in(requestSocketsRoom(sockets)).socketsLeave(joinTargetRooms(target));
  }

  /**
   * Logout of a device: none of its sockets keeps the logged-out account's
   * rooms. When the request names its socket, the device's other sockets
   * (other tabs) get `cliSignedOut` and are disconnected, and the requesting
   * socket is left out (its tab finishes the logout itself and leaves its
   * rooms with the socket `logout`). A request that names no socket (old
   * clients) disconnects every socket of the device, without `cliSignedOut`:
   * the old client would take it for a sign-out from elsewhere.
   */
  public async logoutDeviceSockets(sockets: RequestSockets) {
    const { deviceId, socketId } = sockets;
    if (socketId === null) {
      const io = await this.#io;
      io.in(deviceRoomKey(deviceId)).disconnectSockets(false);
      return;
    }
    await this.emit({ type: 'cliSignedOut' }, { deviceIds: [deviceId] }, { deviceSockets: [{ deviceId, socketId }] });
    const io = await this.#io;
    io.in(deviceRoomKey(deviceId)).except(deviceSocketRoomKey(deviceId, socketId)).disconnectSockets(false);
  }

  /**
   * Tells the given devices that they were signed out (cliSignedOut) and then
   * disconnects their sockets, so none of them keeps receiving the account's
   * events. Both go out through the same publisher, in this order.
   */
  public async signOutDeviceSockets(deviceIds: string[]) {
    if (deviceIds.length === 0) {
      return;
    }
    await this.emit({ type: 'cliSignedOut' }, { deviceIds });
    const io = await this.#io;
    io.in(deviceIds.map(deviceRoomKey)).disconnectSockets(false);
  }

  public async disconnectBotTokenSockets(tokenId: string) {
    const io = await this.#io;
    io.in(botTokenRoomKey(tokenId)).disconnectSockets(true);
  }
}

const eventHelper = new EventHelper();
export default eventHelper;
