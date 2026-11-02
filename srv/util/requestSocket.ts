// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Socket-scoped targeting (docs/realtime/README.md, "Socket-scoped targeting").
 *
 * New clients name the socket.io socket of the sending tab in every HTTP
 * request (`x-cg-socket-id`, src/data/appstate/transport.ts). The server then
 * leaves only that socket out of the echo of the request's own events and
 * joins/leaves article rooms for that socket alone, instead of the whole
 * device. Requests without a usable header keep the per-device behaviour, so
 * old clients see no change.
 *
 * The header only names a socket; it never selects one on its own. Every
 * socket-scoped operation addresses the room `deviceSocketRoomKey(deviceId,
 * socketId)`, built from the session's device and the header. wsapi joins that
 * room at socket login with the device the socket proved (srv/wsapi.ts,
 * `joinAuthenticatedRooms`), and the socket leaves it with its other
 * authenticated rooms on logout or disconnect. A socket id of another device,
 * an unknown one, or one that is not logged in therefore names an empty room:
 * the operation reaches no socket, so nothing is excluded and nothing joins.
 * Cluster-wide by construction (rooms live in the socket.io adapter), no
 * lookup per request.
 */

declare module 'express-session' {
  interface SessionData {
    // article rooms joined for one socket (joinArticleEventRoom with a
    // socket id), oldest first; the per-device joins of old clients stay in
    // `temporaryArticleIds`
    socketArticleRooms?: { articleId: string; socketId: string }[];
  }
}

/** Fixed name: the cg.box gateway lists it in its CORS/origin allowlist. */
export const SOCKET_ID_HEADER = 'x-cg-socket-id';

/** socket.io socket ids (and the client's fallback id) have this format. */
export const SOCKET_ID_PATTERN = /^[A-Za-z0-9_-]{20}$/;

/** The room a logged-in socket shares with nobody: its device + its id. */
export const deviceSocketRoomKey = (deviceId: string, socketId: string) => `deviceSocket:${deviceId}:${socketId}`;

type RequestLike = {
  headers?: Record<string, string | string[] | undefined>;
  botPrincipal?: unknown;
};

/**
 * The requesting tab's socket id, or `null` when the request carries none in
 * the expected format (a repeated header arrives joined and fails the format).
 * Bot requests always get `null`: the Bot API keeps its per-device behaviour.
 */
export function getRequestSocketId(request: RequestLike): string | null {
  if (request.botPrincipal) {
    return null;
  }
  const value = request.headers?.[SOCKET_ID_HEADER];
  if (typeof value !== 'string' || !SOCKET_ID_PATTERN.test(value)) {
    return null;
  }
  return value;
}

/** The sockets one request speaks for: the device, or one socket of it. */
export type RequestSockets = {
  deviceId: string;
  socketId: string | null;
};

export function requestSockets(request: RequestLike, deviceId: string): RequestSockets {
  return { deviceId, socketId: getRequestSocketId(request) };
}

/**
 * The `except` targets that keep the request's own events from echoing back
 * to the sender: the sending socket when the request names one, otherwise
 * the whole device (old clients).
 */
export function senderExcept(sender: RequestSockets): {
  deviceIds?: string[];
  deviceSockets?: { deviceId: string; socketId: string }[];
} {
  if (sender.socketId !== null) {
    return { deviceSockets: [{ deviceId: sender.deviceId, socketId: sender.socketId }] };
  }
  return { deviceIds: [sender.deviceId] };
}
