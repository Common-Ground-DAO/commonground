// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { IncomingMessage } from "http";
import type { Server, ServerOptions } from "socket.io";
import { allowedOrigins, createCorsOptions, socketOriginCheck } from "./origins";
import { gatewayHandshakeGuard, gatewaySocketEventGuard, socketIoKey, validateGatewayConfig } from "./gateway";

// Request checks of the wsapi's Socket.IO server (srv/wsapi.ts), kept here so
// the api and the wsapi share one origin list (srv/util/origins.ts) and the
// gateway rules (srv/util/gateway.ts) are testable without the wsapi process.

/**
 * The origin part of the Socket.IO server options: CORS for the polling
 * transport, and `allowRequest` for every handshake (polling or WebSocket).
 */
export function socketServerOriginOptions(origins: string[] = allowedOrigins()): Pick<ServerOptions, "cors" | "allowRequest"> {
  return {
    cors: createCorsOptions(origins),
    allowRequest: (request: IncomingMessage, callback: (err: string | null | undefined, success: boolean) => void) => {
      const refused = socketOriginCheck(request, origins);
      callback(refused, refused === null);
    },
  };
}

type EngineMiddleware = (request: IncomingMessage, response: unknown, next: (err?: Error) => void) => void;
type EngineLike = { use: (middleware: EngineMiddleware) => unknown };
type SocketServerLike = Pick<Server, "use"> & {
  /** undefined until the server is attached (io.listen / io.attach) */
  engine?: EngineLike;
  bind: (engine: never) => unknown;
};

/**
 * Registers the request checks that need the server object; call once, before
 * any other `io.use`:
 * - every engine request — handshakes, later polling requests and the
 *   WebSocket upgrade of an existing session, which `allowRequest` does not
 *   see — passes the origin check again (a refusal answers 400);
 * - gateway mode: no token handshakes, and only the gateway's socket events
 *   reach a handler (srv/util/gateway.ts).
 */
export function installSocketRequestChecks(io: SocketServerLike, origins: string[] = allowedOrigins()): void {
  // a gateway wsapi needs legacy CG ID mode like its api
  validateGatewayConfig({ needsTransferTarget: false });
  const originMiddleware: EngineMiddleware = (request, _response, next) => {
    const refused = socketOriginCheck(request, origins);
    next(refused ? new Error(refused) : undefined);
  };
  if (io.engine) {
    io.engine.use(originMiddleware);
  }
  else {
    // the wsapi creates its server first and attaches it later (io.listen
    // once Valkey is up): register on the engine as soon as it is bound, so
    // the check is in place before the first request can arrive
    const bind = io.bind.bind(io) as (engine: EngineLike) => unknown;
    io.bind = ((engine: EngineLike) => {
      engine.use(originMiddleware);
      return bind(engine);
    }) as SocketServerLike["bind"];
  }
  io.use(gatewayHandshakeGuard());
  const eventGuard = gatewaySocketEventGuard();
  io.use((socket, next) => {
    socket.use(eventGuard);
    next();
  });
}

/** the Socket.IO redis adapter key of this instance (gateway: its own) */
export function socketAdapterKey(): string {
  return socketIoKey();
}
