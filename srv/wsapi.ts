// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import config from './common/config';
import serverconfig from './serverconfig';
import {
  randomString,
  realRandomHexString,
  userRoomKey,
  roleRoomKey,
  communityRoomKey,
  deviceRoomKey,
  expressSessionRoomKey,
  botTokenRoomKey,
  dockerSecret,
} from './util';
import cors from "cors";
import { Server, type Socket } from "socket.io";
import { BOT_PROTOCOL_VERSION } from "./common/botProtocol";
import { createAdapter } from "@socket.io/redis-adapter";
import deviceHelper from "./repositories/device";
import validators from './validators';
import userHelper from './repositories/users';
import redisManager from './redis';
import { fakeHealthcheck } from './healthcheck';
import buildId from './common/random_build_id';
import botTokenHelper from './repositories/botTokens';
import botHelper from './repositories/bots';

import cookieParser from 'cookie-parser';
// import signature from 'cookie-signature';
import cookie from 'cookie';
const secret = dockerSecret('redis_secret') || process.env.REDIS_SECRET as string;

function decodeSessionId(cookieHeader: string) {
  // Parse the cookies
  const cookies = cookieParser.signedCookies(cookie.parse(cookieHeader), secret);

  // `connect.sid` is the default name for the session cookie
  const sessionCookie = cookies[serverconfig.SESSION_COOKIE_NAME] as string;

  return sessionCookie;
  /* if (sessionCookie && sessionCookie.startsWith('s:')) {
    // Remove the 's:' prefix and try to unsign it
    const unsignedSessionId = signature.unsign(sessionCookie.slice(2), secret);

    if (!unsignedSessionId) {
      throw new Error('Failed to unsign the session ID.');
    }
    return unsignedSessionId as string;
  } else {
    return sessionCookie;
  } */
}

const localOnlineUsers = new Set<string>();
const localOnlineBotUsers = new Set<string>();
let shuttingDown = false;

const BOT_PRESENCE_LEASE_MS = 90_000;
const BOT_PRESENCE_SCRIPT = `
  local instance_id = ARGV[1]
  local local_count = tonumber(ARGV[2])
  local redis_time = redis.call('TIME')
  local now_ms = tonumber(redis_time[1]) * 1000 + math.floor(tonumber(redis_time[2]) / 1000)

  if local_count > 0 then
    redis.call('HSET', KEYS[1], instance_id, local_count)
    redis.call('ZADD', KEYS[2], now_ms + tonumber(ARGV[3]), instance_id)
  else
    redis.call('HDEL', KEYS[1], instance_id)
    redis.call('ZREM', KEYS[2], instance_id)
  end

  local expired = redis.call('ZRANGEBYSCORE', KEYS[2], '-inf', now_ms)
  if #expired > 0 then
    redis.call('HDEL', KEYS[1], unpack(expired))
    redis.call('ZREM', KEYS[2], unpack(expired))
  end

  local total = 0
  local counts = redis.call('HVALS', KEYS[1])
  for _, count in ipairs(counts) do
    total = total + tonumber(count)
  end
  return total
`;

const allowedOrigins = [ process.env.BASE_URL ];
if (config.DEPLOYMENT === 'dev') {
  allowedOrigins.push('http://localhost:3000');
  allowedOrigins.push('https://localhost:3000');
  allowedOrigins.push('http://localhost:8000');
  allowedOrigins.push('https://localhost:8001');
  allowedOrigins.push('http://app.cg.local:3000');
  allowedOrigins.push('https://app.cg.local:3000');
  allowedOrigins.push('http://app.cg.local:8000');
  allowedOrigins.push('https://app.cg.local:8001');
  allowedOrigins.push('https://bs-local.com:3000');
  allowedOrigins.push('https://bs-local.com:8001');
  if (!!process.env.LOCAL_CERTIFICATE_IP) {
    allowedOrigins.push(`http://${process.env.LOCAL_CERTIFICATE_IP}:3000`);
    allowedOrigins.push(`https://${process.env.LOCAL_CERTIFICATE_IP}:3000`);
    allowedOrigins.push(`http://${process.env.LOCAL_CERTIFICATE_IP}:8000`);
    allowedOrigins.push(`https://${process.env.LOCAL_CERTIFICATE_IP}:8001`);
  }
}
const corsOptions: cors.CorsOptions = {
  origin: function (origin, callback) {
    // allow requests with no origin 
    // (like mobile apps or curl requests)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) === -1) {
      var msg = 'The CORS policy for this site does not ' +
        'allow access from the specified Origin.';
      return callback(new Error(msg), false);
    }
    return callback(null, true);
  },
  credentials: true,
  preflightContinue: false,
};

const io = new Server<
  API.Server.ServerToClientEvents,
  API.Server.ClientToServerEvents,
  API.Server.InterServerEvents,
  API.Server.SocketData
>({
  transports: ["polling", "websocket"],
  cors: corsOptions,
  path: "/api/ws/",
  pingInterval: 15000,
  pingTimeout: 15000,
  perMessageDeflate: false,
});

type AppSocket = Socket<
  API.Server.ServerToClientEvents,
  API.Server.ClientToServerEvents,
  API.Server.InterServerEvents,
  API.Server.SocketData
>;

async function setBotConnectionPresence(
  userId: string,
  localConnectedSocketCount: number,
  markConnectedAt = false,
) {
  const presenceKey = `bot-presence:${userId}`;
  const connectedSocketCount = await redisManager.getClient('data').eval(BOT_PRESENCE_SCRIPT, {
    keys: [`${presenceKey}:counts`, `${presenceKey}:expirations`],
    arguments: [
      redisManager.instanceId,
      localConnectedSocketCount.toString(),
      BOT_PRESENCE_LEASE_MS.toString(),
    ],
  }) as number;

  // Keep the shared user presence compatible with the existing member-list
  // pipeline, but store bot-only transport details separately. Ordering
  // prevents the stale-presence worker from resetting a newly connected bot
  // between the two writes.
  if (connectedSocketCount > 0) {
    await userHelper.touchUserOnlineStatus([userId]);
    await botHelper.setConnectionPresence(userId, connectedSocketCount, markConnectedAt);
  }
  else {
    await botHelper.setConnectionPresence(userId, 0);
    await userHelper.setUserOnlineStatus(userId, 'offline');
  }
}

async function syncBotConnectionPresence(userId: string, markConnectedAt = false) {
  const localSocketIds = io.sockets.adapter.rooms.get(userRoomKey(userId)) || new Set<string>();
  let localConnectedSocketCount = 0;
  for (const socketId of localSocketIds) {
    const connectedSocket = io.sockets.sockets.get(socketId);
    if (connectedSocket?.data.userId === userId && connectedSocket.data.botTokenId) {
      localConnectedSocketCount++;
    }
  }
  await setBotConnectionPresence(userId, localConnectedSocketCount, markConnectedAt);
}

async function joinAuthenticatedRooms(
  socket: AppSocket,
  identity: {
    userId: string;
    deviceId: string;
    roleIds: string[];
    communityIds: string[];
    tokenId?: string;
  },
) {
  socket.data.userId = identity.userId;
  socket.data.deviceId = identity.deviceId;
  const rooms = [
    deviceRoomKey(identity.deviceId),
    userRoomKey(identity.userId),
    ...identity.roleIds.map(roleRoomKey),
    ...identity.communityIds.map(communityRoomKey),
  ];
  if (identity.tokenId) {
    socket.data.botTokenId = identity.tokenId;
    rooms.push(botTokenRoomKey(identity.tokenId));
  }
  await socket.join(rooms);
}

io.use(async (socket, next) => {
  const token = socket.handshake.auth?.token;
  if (token === undefined) {
    next();
    return;
  }
  if (typeof token !== 'string' || token.length === 0 || socket.handshake.headers.cookie) {
    next(new Error('unauthorized'));
    return;
  }
  try {
    const requestedVersion = socket.handshake.auth?.protocolVersion;
    if (requestedVersion !== BOT_PROTOCOL_VERSION) {
      next(new Error('unsupported_bot_protocol'));
      return;
    }
    const principal = await botTokenHelper.authenticate(token);
    if (!principal) {
      next(new Error('unauthorized'));
      return;
    }
    const ids = await botHelper.getActiveSocketRoomIds(principal.user.id, principal.tokenId);
    await joinAuthenticatedRooms(socket, {
      userId: principal.user.id,
      deviceId: principal.user.deviceId,
      tokenId: principal.tokenId,
      roleIds: ids.roleIds,
      communityIds: ids.communityIds,
    });
    socket.data.botProtocolVersion = BOT_PROTOCOL_VERSION;
    next();
  } catch {
    next(new Error('unauthorized'));
  }
});

redisManager.isReady.then(async () => {
  io.adapter(createAdapter(
    redisManager.getClient('socketIOPub'),
    redisManager.getClient('socketIOSub'),
    { key: 'v2:' }
  ));

  io.on("connection", async (socket) => {
    if (shuttingDown) {
      socket.disconnect(true);
      return;
    }

    socket.emit("buildId", buildId, Date.now());

    if (socket.data.botTokenId) {
      const { userId } = socket.data;
      if (!userId) {
        socket.disconnect(true);
        return;
      }
      localOnlineBotUsers.add(userId);
      socket.on("cgPing", (callback) => {
        try {
          callback(Date.now());
        } catch {
          socket.disconnect(true);
        }
      });
      socket.on("disconnect", async () => {
        if (!io.sockets.adapter.rooms.get(userRoomKey(userId))?.size) {
          localOnlineBotUsers.delete(userId);
        }
        if (!shuttingDown) {
          try {
            await syncBotConnectionPresence(userId);
          }
          catch (error) {
            console.error("Error updating disconnected bot presence", { userId, error });
          }
        }
      });
      try {
        await syncBotConnectionPresence(userId, true);
      }
      catch (error) {
        console.error("Error updating connected bot presence", { userId, error });
      }
      return;
    }

    const { cookie } = socket.handshake.headers;
    if (!cookie) {
      socket.disconnect(true);
      console.error("No express sessionId cookie found, closing socket...");
      return;
    }
    const sessionId = decodeSessionId(cookie);
    socket.join(expressSessionRoomKey(sessionId));

    socket.on("getSignableSecret", (callback) => {
      const signableSecret = realRandomHexString(32);
      socket.data.signableSecret = signableSecret;
      try {
        callback(signableSecret);
      }
      catch (e) {
        console.error("Error during getSignableSecret", e);
      }
    });

    socket.on("cgPing", (callback) => {
      try {
        callback(Date.now());
      }
      catch (e) {
        console.error("Error during cgPing", e);
      }
    });

    socket.on("joinCommunityVisitorRoom", async (data) => {
      try {
        // Todo: check if community is publicly visible, only then allow
        data = await validators.API.Socket.joinCommunityVisitorRoom.validateAsync(data);
        if (!!data.communityId && socket.data.temporaryCommunityId !== data.communityId) {
          if (socket.data.temporaryCommunityId) {
            const { userId } = socket.data;
            const isCommunityMember = !!userId && await userHelper.isUserMemberOfCommunity({
              userId,
              communityId: socket.data.temporaryCommunityId,
            });
            if (!isCommunityMember) {
              await socket.leave(communityRoomKey(socket.data.temporaryCommunityId));
            }
          }
          socket.data.temporaryCommunityId = data.communityId;
          await socket.join(communityRoomKey(data.communityId));
        }
      }
      catch (e) {
        console.error("Error during joinCommunityVisitorRoom", e);
      }
    });

    socket.on("leaveCommunityVisitorRoom", async () => {
      if (socket.data.temporaryCommunityId) {
        const { userId } = socket.data;
        const isCommunityMember = !!userId && await userHelper.isUserMemberOfCommunity({
          userId,
          communityId: socket.data.temporaryCommunityId,
        });
        if (!isCommunityMember) {
          await socket.leave(communityRoomKey(socket.data.temporaryCommunityId));
        }
        delete socket.data.temporaryCommunityId;
      }
    });

    socket.on("prepareWalletRequest", async (callback) => {
      try {
        const newRequestId = randomString(20);
        socket.data.walletRequestId = newRequestId;
        callback(newRequestId);
      }
      catch (e) {
        console.error("Error during prepareWalletRequest", e);
      }
    });

    socket.on("login", async (data, callback) => {
      try {
        const { signableSecret } = socket.data;
        data = await validators.API.Socket.login.validateAsync(data);
        if (!!signableSecret && signableSecret === data.secret) {
          const { userId } = await deviceHelper.verifyDeviceAndGetUserId(data.deviceId, signableSecret, data.base64Signature);
          const ids = await userHelper.getUserRoleAndCommunityIds(userId);
          delete socket.data.signableSecret;
          localOnlineUsers.add(userId);
          await joinAuthenticatedRooms(socket, {
            userId,
            deviceId: data.deviceId,
            roleIds: ids.roleIds,
            communityIds: ids.communityIds,
          });
          await userHelper.setUserOnlineStatus(userId, 'online');
        }
        callback("OK");
      } catch (e) {
        console.error("Error during login", e);
        callback("ERROR");
      }
    });

    socket.on("logout", () => {
      const { userId } = socket.data;
      delete socket.data.userId;
      delete socket.data.deviceId;
      const leavePromises: (void | Promise<void>)[] = [];
      const temporaryCommunityKey = communityRoomKey(socket.data.temporaryCommunityId || '');
      for (const roomId of Array.from(socket.rooms)) {
        // Skip the socket's own room (roomId === socket.id) and potential temporary rooms (like a community public room)
        if (
          roomId !== socket.id &&
          temporaryCommunityKey !== roomId
        ) {
          leavePromises.push(socket.leave(roomId));
        }
      }
      Promise.all(leavePromises).then(() => {
        if (!!userId) {
          const ownRoomSize = io.sockets.adapter.rooms.get(userRoomKey(userId))?.size;
          if (!ownRoomSize) {
            console.log(`User ${userId} has logged out the last socket and is offline`);
            userHelper.setUserOnlineStatus(userId, 'offline');
            localOnlineUsers.delete(userId);
          }
        }
      });
    });

    socket.on("disconnect", () => {
      const { userId } = socket.data;
      if (!!userId && !socket.data.botTokenId) {
        const ownRoomSize = io.sockets.adapter.rooms.get(userRoomKey(userId))?.size;
        if (!ownRoomSize) {
          if (!shuttingDown) {
            userHelper.setUserOnlineStatus(userId, 'offline');
          }
          localOnlineUsers.delete(userId);
        }
      }
    });
  });

  io.listen(4000);
});

setInterval(async () => {
  if (!shuttingDown) {
    try {
      const userIds = Array.from(localOnlineUsers);
      const botUserIds = Array.from(localOnlineBotUsers);
      if (userIds.length > 0) {
        await userHelper.touchUserOnlineStatus(userIds);
      }
      await Promise.all(botUserIds.map(userId => syncBotConnectionPresence(userId)));
    }
    catch (e) {
      console.error("Error touching own connected users onlineStatus", e);
    }
  }
}, 60000);

const shutdown = async (code = 0) => {
  shuttingDown = true;
  try {
    const sockets = await io.local.fetchSockets();
    const botUserIds = new Set<string>();
    const offlineUserIds = sockets.reduce<string[]>((agg, socket) => {
      const { userId } = socket.data;
      if (!!userId && socket.data.botTokenId) {
        botUserIds.add(userId);
      }
      else if (!!userId) {
        const ownRoomSize = io.sockets.adapter.rooms.get(userRoomKey(userId))?.size;
        if (ownRoomSize === 1) {
          console.log(`User ${userId} will disconnect the last socket and then be offline`);
          agg.push(userId);
        }
      }
      socket.disconnect(true);
      return agg;
    }, []);
    if (offlineUserIds.length > 0) {
      await userHelper.setUsersToOffline(offlineUserIds);
    }
    await Promise.all(Array.from(botUserIds).map(userId => setBotConnectionPresence(userId, 0)));
    io.close();
  } catch (e) {
    console.error("Error while shutting down", e);
  } finally {
    process.exit(code)
  }
};

fakeHealthcheck();

process.on("SIGTERM", () => shutdown());
process.on("unhandledRejection", (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  shutdown(1);
});
process.on("uncaughtException", (error, origin) => {
  console.error('Uncaught Exception at:', error, 'origin:', origin);
  shutdown(1);
});
