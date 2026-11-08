/**
 * In-house protoo client (JSON-RPC over WebSocket).
 *
 * Contract: srv/mediasoup/room.ts speaks the protoo wire protocol —
 *   request:      {request:true,  id, method, data}
 *   response ok:  {response:true, id, ok:true,  data}
 *   response err: {response:true, id, ok:false, errorCode, errorReason}
 *   notification: {notification:true, method, data}
 * The subprotocol is "protoo". We do NOT depend on the abandoned
 * protoo-client port (same call the native roadmap makes); this is a
 * ~120-line reimplementation of just what a signaling client needs.
 */

import { WebSocket } from "ws";

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface ProtooNotification {
  method: string;
  data: unknown;
}

export class ProtooError extends Error {
  constructor(readonly errorCode: number, readonly errorReason: string, method: string) {
    super(`protoo ${method} rejected: ${errorCode} ${errorReason}`);
    this.name = "ProtooError";
  }
}

export interface ProtooClientOptions {
  /** Accept a self-signed server cert (selfhost mediasoup uses one). */
  rejectUnauthorized?: boolean;
  requestTimeoutMs?: number;
}

export class ProtooClient {
  private ws?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, PendingRequest>();
  private notificationListeners = new Set<(n: ProtooNotification) => void>();
  /** Server→client REQUESTS (e.g. "newConsumer") the server expects acked. */
  private serverRequestListeners = new Set<
    (method: string, data: unknown, accept: (data?: unknown) => void, reject: (code: number, reason: string) => void) => void
  >();

  constructor(private readonly url: string, private readonly options: ProtooClientOptions = {}) {}

  async connect(): Promise<void> {
    if (this.ws) throw new Error("already connected");
    const ws = new WebSocket(this.url, "protoo", {
      rejectUnauthorized: this.options.rejectUnauthorized ?? true,
    });
    this.ws = ws;
    ws.on("message", (raw: Buffer) => this.onMessage(raw));
    await new Promise<void>((resolve, reject) => {
      ws.once("open", () => resolve());
      ws.once("error", (err) => reject(err));
    });
  }

  /** Send a protoo request and await its response data. */
  request(method: string, data: unknown = {}): Promise<unknown> {
    const ws = this.requireWs();
    const id = this.nextId++;
    const message = { request: true, id, method, data };
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`protoo ${method} timed out`));
      }, this.options.requestTimeoutMs ?? 15_000);
      this.pending.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify(message), (err) => {
        if (err) {
          clearTimeout(timer);
          this.pending.delete(id);
          reject(err);
        }
      });
    });
  }

  notify(method: string, data: unknown = {}): void {
    this.requireWs().send(JSON.stringify({ notification: true, method, data }));
  }

  onNotification(listener: (n: ProtooNotification) => void): () => void {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onServerRequest(
    listener: (
      method: string,
      data: unknown,
      accept: (data?: unknown) => void,
      reject: (code: number, reason: string) => void,
    ) => void,
  ): () => void {
    this.serverRequestListeners.add(listener);
    return () => this.serverRequestListeners.delete(listener);
  }

  get connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  close(): void {
    for (const { timer, reject } of this.pending.values()) {
      clearTimeout(timer);
      reject(new Error("protoo connection closed"));
    }
    this.pending.clear();
    this.ws?.close();
    this.ws = undefined;
  }

  private onMessage(raw: Buffer): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }
    if (msg.response) {
      const id = msg.id as number;
      const pending = this.pending.get(id);
      if (!pending) return;
      clearTimeout(pending.timer);
      this.pending.delete(id);
      if (msg.ok) pending.resolve(msg.data);
      else pending.reject(new ProtooError(Number(msg.errorCode), String(msg.errorReason), `#${id}`));
    } else if (msg.request) {
      // Server-initiated request (protoo allows this — mediasoup uses it for
      // newConsumer). Reply so the server isn't left waiting.
      const id = msg.id as number;
      const method = String(msg.method);
      const accept = (data: unknown = {}) =>
        this.ws?.send(JSON.stringify({ response: true, id, ok: true, data }));
      const reject = (code: number, reason: string) =>
        this.ws?.send(JSON.stringify({ response: true, id, ok: false, errorCode: code, errorReason: reason }));
      if (this.serverRequestListeners.size === 0) {
        // Default: reject unknown server requests (signaling-only client).
        reject(501, "not implemented by signaling-only client");
      } else {
        for (const listener of this.serverRequestListeners) {
          listener(method, msg.data, accept, reject);
        }
      }
    } else if (msg.notification) {
      const notification: ProtooNotification = { method: String(msg.method), data: msg.data };
      for (const listener of this.notificationListeners) listener(notification);
    }
  }

  private requireWs(): WebSocket {
    if (!this.ws) throw new Error("not connected");
    return this.ws;
  }
}
