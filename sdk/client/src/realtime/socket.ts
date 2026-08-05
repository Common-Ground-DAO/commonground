/**
 * Realtime connection — socket.io against the wsapi service.
 *
 * Contract (srv/wsapi.ts): path "/api/ws/", default namespace, session auth
 * via the request cookie (no handshake auth for human clients; bots pass
 * `auth: {token, protocolVersion:"1"}` and must NOT send a cookie). The
 * cookie only attaches the socket to the express session — authenticated
 * room membership requires the in-band device-signature login:
 * `getSignableSecret` → sign → `login` (same crypto as HTTP device login).
 * The server emits `buildId` (positional: string, number) on every connect;
 * everything else arrives as `cli*` events whose payload omits the type
 * field (event name = type).
 */

import { io, type Socket } from "socket.io-client";
import type { HttpTransport } from "../transport/http.js";
import type { DeviceKey } from "../identity/deviceKey.js";
import { CLIENT_EVENT_NAMES, type ClientEventMap, type ClientEventName } from "./events.js";

export interface RealtimeOptions {
  /** Bot bearer token — mutually exclusive with cookie sessions. */
  botToken?: string;
  /** Reconnection (socket.io built-in). Default false: explicit is better in
   * an SDK; callers own reconnect policy. */
  reconnection?: boolean;
}

export interface ReceivedEvent<K extends ClientEventName = ClientEventName> {
  type: K;
  payload: ClientEventMap[K];
  receivedAt: number;
}

type Listener = (event: ReceivedEvent) => void;

export class RealtimeClient {
  private socket?: Socket;
  private listeners = new Set<Listener>();
  /** buildId from the greeting — backend build identity + server clock. */
  buildId?: { buildId: string; serverTime: number };

  constructor(
    private readonly transport: HttpTransport,
    private readonly options: RealtimeOptions = {},
  ) {}

  get connected(): boolean {
    return this.socket?.connected ?? false;
  }

  /** Open the socket; resolves once connected and greeted with buildId. */
  async connect(): Promise<void> {
    if (this.socket) throw new Error("already connected");
    const cookie = this.transport.jar.cookieHeader();
    const socket = io(this.transport.baseUrl, {
      path: "/api/ws/",
      transports: ["websocket"],
      reconnection: this.options.reconnection ?? false,
      ...(this.options.botToken
        ? { auth: { token: this.options.botToken, protocolVersion: "1" } }
        : { extraHeaders: cookie ? { cookie } : {} }),
    });
    this.socket = socket;

    socket.on("buildId", (buildId: string, serverTime: number) => {
      this.buildId = { buildId, serverTime };
    });
    socket.onAny((name: string, ...args: unknown[]) => {
      if (!name.startsWith("cli")) return;
      const event: ReceivedEvent = {
        type: name as ClientEventName,
        payload: (args[0] ?? {}) as ClientEventMap[ClientEventName],
        receivedAt: Date.now(),
      };
      for (const listener of this.listeners) listener(event);
    });

    await new Promise<void>((resolve, reject) => {
      socket.once("connect", () => resolve());
      socket.once("connect_error", (err: Error) => reject(err));
    });
  }

  /** In-band device-signature login → authenticated room membership. */
  async login(deviceId: string, deviceKey: DeviceKey): Promise<void> {
    const socket = this.requireSocket();
    const secret = (await socket.emitWithAck("getSignableSecret")) as string;
    const base64Signature = await deviceKey.signSecret(secret);
    const result = (await socket.emitWithAck("login", {
      secret,
      deviceId,
      base64Signature,
    })) as string;
    if (result !== "OK") {
      throw new Error(`socket login failed: ${result}`);
    }
  }

  /** App-level heartbeat; returns the server's Date.now(). */
  async ping(): Promise<number> {
    return (await this.requireSocket().emitWithAck("cgPing")) as number;
  }

  logout(): void {
    this.requireSocket().emit("logout");
  }

  onEvent(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Await the next matching event (conformance workhorse). */
  waitFor<K extends ClientEventName>(
    type: K,
    predicate?: (payload: ClientEventMap[K]) => boolean,
    timeoutMs = 15_000,
  ): Promise<ClientEventMap[K]> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        off();
        reject(new Error(`timed out waiting for ${type}`));
      }, timeoutMs);
      const off = this.onEvent((event) => {
        if (event.type !== type) return;
        const payload = event.payload as ClientEventMap[K];
        if (predicate && !predicate(payload)) return;
        clearTimeout(timer);
        off();
        resolve(payload);
      });
    });
  }

  close(): void {
    this.socket?.disconnect();
    this.socket = undefined;
  }

  private requireSocket(): Socket {
    if (!this.socket) throw new Error("not connected");
    return this.socket;
  }
}

export { CLIENT_EVENT_NAMES };
export type { ClientEventMap, ClientEventName };
