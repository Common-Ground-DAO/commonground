// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * A socket.io-client look-alike for transport tests. The test plays the
 * server: it accepts or refuses connections, answers acks (by handler or by
 * hand), delivers server events and drops the connection.
 *
 * Behaviour copied from socket.io-client 4 because code tends to rely on it:
 * - `connect` fires before the send buffer is flushed; emits while
 *   disconnected are buffered and sent on the next connect (not `volatile`).
 * - Client `disconnect()` fires `disconnect` synchronously with
 *   `io client disconnect`; the socket does not reconnect by itself.
 * - Every connection gets a new `id`. An ack the server answers after the
 *   connection that carried the request is gone is never delivered.
 * - Server acks arrive asynchronously (microtask); `deliver` is synchronous.
 * The fake never reconnects on its own after `drop()`: the test decides when
 * (or whether) the reconnect succeeds via `accept()` / `refuse()`.
 */

type Listener = (...args: any[]) => void;
type AnyListener = (event: string, ...args: any[]) => void;

/** Return from a server handler to leave the ack unanswered. */
export const NO_ACK: unique symbol = Symbol('NO_ACK');

export type ServerHandler = (args: unknown[], socket: FakeSocket) => unknown;

export type LoginResult = 'OK' | 'SECURITY_STEP_REQUIRED' | 'ERROR';

export interface SentPacket {
  event: string;
  args: unknown[];
  /** Connection id that carried the packet. */
  socketId: string;
  hasAck: boolean;
}

export interface PendingAck {
  event: string;
  args: unknown[];
  socketId: string;
  /** Answers the ack (dropped if its connection is gone). */
  respond(...values: unknown[]): void;
}

export interface FakeSocketOptions {
  /**
   * `connect()` completes by itself on a microtask (default `true`). With
   * `false` the socket stays connecting until the test calls `accept()`.
   */
  autoAccept?: boolean;
  /** Install the default handlers for `cgPing`, `getSignableSecret`, `login`, `logout` (default `true`). */
  defaultHandlers?: boolean;
  /** Prefix of the generated connection ids (default `sock`). */
  idPrefix?: string;
}

const RESERVED = new Set(['connect', 'connect_error', 'disconnect']);

let socketCounter = 0;

export class FakeSocket {
  id: string | undefined = undefined;
  connected = false;
  /** True while the socket wants to be connected (between `connect()` and `disconnect()`). */
  active = false;

  /** Everything the client sent to the server, in order (after buffering). */
  readonly sent: SentPacket[] = [];
  /** Emits made while disconnected, flushed on the next connect. */
  readonly sendBuffer: { event: string; args: unknown[] }[] = [];
  /** Acks no handler answered yet, oldest first. */
  readonly pendingAcks: PendingAck[] = [];

  // simulated server state
  /** Login result the default `login` handler answers with. */
  loginResult: LoginResult = 'OK';
  /** Server-side: socket logged in on the current connection. */
  loggedIn = false;
  /** Number of `login` requests the server received. */
  loginCount = 0;
  /** Last secret the default `getSignableSecret` handler handed out. */
  lastSecret: string | undefined;

  readonly options: Required<FakeSocketOptions>;

  #listeners = new Map<string, Listener[]>();
  #anyListeners: AnyListener[] = [];
  #handlers = new Map<string, ServerHandler>();
  #connectionCount = 0;
  #acceptScheduled = false;
  #inFlight = new Set<Promise<unknown>>();

  constructor(options: FakeSocketOptions = {}) {
    this.options = {
      autoAccept: options.autoAccept ?? true,
      defaultHandlers: options.defaultHandlers ?? true,
      idPrefix: options.idPrefix ?? `sock${++socketCounter}`,
    };
    if (this.options.defaultHandlers) this.#installDefaultHandlers();
  }

  get disconnected(): boolean {
    return !this.connected;
  }

  // ---------------------------------------------------------------- client API

  on(event: string, listener: Listener): this {
    const list = this.#listeners.get(event) ?? [];
    list.push(listener);
    this.#listeners.set(event, list);
    return this;
  }

  once(event: string, listener: Listener): this {
    const wrapper: Listener = (...args) => {
      this.off(event, wrapper);
      listener(...args);
    };
    (wrapper as { inner?: Listener }).inner = listener;
    return this.on(event, wrapper);
  }

  off(event?: string, listener?: Listener): this {
    if (event === undefined) {
      this.#listeners.clear();
      return this;
    }
    if (!listener) {
      this.#listeners.delete(event);
      return this;
    }
    const list = this.#listeners.get(event) ?? [];
    const index = list.findIndex(l => l === listener || (l as { inner?: Listener }).inner === listener);
    if (index >= 0) list.splice(index, 1);
    return this;
  }

  removeAllListeners(event?: string): this {
    return this.off(event);
  }

  listeners(event: string): Listener[] {
    return [...(this.#listeners.get(event) ?? [])];
  }

  hasListeners(event: string): boolean {
    return (this.#listeners.get(event)?.length ?? 0) > 0;
  }

  onAny(listener: AnyListener): this {
    this.#anyListeners.push(listener);
    return this;
  }

  offAny(listener?: AnyListener): this {
    this.#anyListeners = listener ? this.#anyListeners.filter(l => l !== listener) : [];
    return this;
  }

  /** Client → server. A trailing function argument is the ack callback. */
  emit(event: string, ...args: unknown[]): this {
    if (RESERVED.has(event)) throw new Error(`"${event}" is a reserved event name`);
    if (!this.connected) {
      this.sendBuffer.push({ event, args });
      return this;
    }
    this.#send(event, args);
    return this;
  }

  emitWithAck(event: string, ...args: unknown[]): Promise<unknown> {
    return new Promise(resolve => this.emit(event, ...args, resolve));
  }

  /** `socket.volatile.emit(...)`: dropped instead of buffered while disconnected. */
  get volatile(): { emit: (event: string, ...args: unknown[]) => FakeSocket } {
    return {
      emit: (event, ...args) => (this.connected ? this.emit(event, ...args) : this),
    };
  }

  connect(): this {
    if (this.connected) return this;
    this.active = true;
    if (this.options.autoAccept && !this.#acceptScheduled) {
      this.#acceptScheduled = true;
      queueMicrotask(() => {
        this.#acceptScheduled = false;
        if (this.active && !this.connected) this.accept();
      });
    }
    return this;
  }

  open(): this {
    return this.connect();
  }

  disconnect(): this {
    this.active = false;
    if (this.connected) this.#close('io client disconnect');
    return this;
  }

  close(): this {
    return this.disconnect();
  }

  // ---------------------------------------------------------------- server API

  /** Completes a pending (re)connect: new `id`, `connect` event, buffer flush. */
  accept(): this {
    if (this.connected) throw new Error('FakeSocket.accept: already connected');
    this.active = true;
    this.#connectionCount += 1;
    this.id = `${this.options.idPrefix}-${this.#connectionCount}`;
    this.connected = true;
    this.loggedIn = false;
    this.#fire('connect');
    // the `connect` listeners may have disconnected again
    if (!this.connected) return this;
    const buffered = this.sendBuffer.splice(0);
    for (const packet of buffered) this.#send(packet.event, packet.args);
    return this;
  }

  /** Fails the current connect attempt (`connect_error`); the socket stays active. */
  refuse(error: Error = new Error('xhr poll error')): this {
    if (this.connected) throw new Error('FakeSocket.refuse: already connected');
    this.#fire('connect_error', error);
    return this;
  }

  /**
   * The connection goes away (`transport close`, `ping timeout`, …). Socket.io
   * would retry; here it stays `active` until the test calls `accept()`. With
   * `io server disconnect` it becomes inactive, as in socket.io.
   */
  drop(reason = 'transport close'): this {
    if (!this.connected) return this;
    if (reason === 'io server disconnect') this.active = false;
    this.#close(reason);
    return this;
  }

  /** Server → client event. Returns false (and drops it) when not connected. */
  deliver(event: string, ...args: unknown[]): boolean {
    if (!this.connected) return false;
    this.#fire(event, ...args);
    return true;
  }

  /**
   * Answers every future `event` with `handler(args, socket)`'s (awaited)
   * return value; return `NO_ACK` to leave it unanswered. Replaces the
   * default handler for that event; pass `undefined` to remove it.
   */
  handle(event: string, handler: ServerHandler | undefined): this {
    if (handler) this.#handlers.set(event, handler);
    else this.#handlers.delete(event);
    return this;
  }

  /** Answers the oldest pending ack of `event`. Throws if there is none. */
  respond(event: string, ...values: unknown[]): void {
    const pending = this.pendingAcks.find(p => p.event === event);
    if (!pending) throw new Error(`FakeSocket.respond: no pending ack for "${event}"`);
    pending.respond(...values);
  }

  /** Packets the client sent for `event`. */
  sentOf(event: string): SentPacket[] {
    return this.sent.filter(p => p.event === event);
  }

  /** Waits until every in-flight server handler has answered its ack. */
  async settle(): Promise<void> {
    while (this.#inFlight.size > 0) {
      await Promise.allSettled([...this.#inFlight]);
    }
    await Promise.resolve();
  }

  // ---------------------------------------------------------------- internals

  #fire(event: string, ...args: unknown[]): void {
    if (!RESERVED.has(event)) {
      for (const listener of [...this.#anyListeners]) listener(event, ...args);
    }
    for (const listener of this.listeners(event)) listener(...args);
  }

  #close(reason: string): void {
    this.connected = false;
    this.loggedIn = false;
    this.id = undefined;
    // pending acks of the old connection can never be answered
    this.pendingAcks.length = 0;
    this.#fire('disconnect', reason);
  }

  #send(event: string, args: unknown[]): void {
    const socketId = this.id!;
    const last = args[args.length - 1];
    const ack = typeof last === 'function' ? (last as Listener) : undefined;
    const payload = ack ? args.slice(0, -1) : args;
    this.sent.push({ event, args: payload, socketId, hasAck: !!ack });

    const answer = (...values: unknown[]) => {
      // late answer for a connection that is gone: socket.io never calls it
      if (!ack || this.id !== socketId || !this.connected) return;
      queueMicrotask(() => {
        if (this.id === socketId && this.connected) ack(...values);
      });
    };

    const handler = this.#handlers.get(event);
    if (handler) {
      const run = Promise.resolve().then(() => handler(payload, this));
      const tracked = run.then(
        value => {
          if (value !== NO_ACK) answer(value);
        },
        error => {
          // a throwing handler is a broken test, not a server error reply
          console.error(`FakeSocket handler for "${event}" threw`, error);
        },
      );
      this.#inFlight.add(tracked);
      void tracked.finally(() => this.#inFlight.delete(tracked));
      return;
    }
    if (ack) {
      const pending: PendingAck = {
        event,
        args: payload,
        socketId,
        respond: (...values) => {
          const index = this.pendingAcks.indexOf(pending);
          if (index >= 0) this.pendingAcks.splice(index, 1);
          answer(...values);
        },
      };
      this.pendingAcks.push(pending);
    }
  }

  #installDefaultHandlers(): void {
    let secretCounter = 0;
    this.#handlers.set('cgPing', () => Date.now());
    this.#handlers.set('getSignableSecret', () => {
      this.lastSecret = `secret-${++secretCounter}`;
      return this.lastSecret;
    });
    this.#handlers.set('login', () => {
      this.loginCount += 1;
      const result = this.loginResult;
      this.loggedIn = result === 'OK';
      return result;
    });
    this.#handlers.set('logout', () => {
      this.loggedIn = false;
      return NO_ACK;
    });
  }
}

export interface FakeIo {
  /** Drop-in for socket.io-client's `io(url, opts)`. */
  io: (url?: string, opts?: { autoConnect?: boolean } & Record<string, unknown>) => FakeSocket;
  /** Every socket `io()` created, oldest first. */
  readonly sockets: FakeSocket[];
  /** The newest socket; throws if none was created. */
  readonly last: FakeSocket;
  /** URL and options of each `io()` call. */
  readonly calls: { url?: string; opts?: Record<string, unknown> }[];
}

/**
 * An `io()` factory for `vi.mock('socket.io-client', …)`. Like the real one it
 * connects right away unless `opts.autoConnect === false`.
 *
 *   const fake = vi.hoisted(() => ({ current: undefined as FakeIo | undefined }));
 *   vi.mock('socket.io-client', () => ({ io: (...a) => fake.current!.io(...a) }));
 */
export function createFakeIo(options: FakeSocketOptions = {}): FakeIo {
  const sockets: FakeSocket[] = [];
  const calls: { url?: string; opts?: Record<string, unknown> }[] = [];
  return {
    io(url, opts) {
      calls.push({ url, opts });
      const socket = new FakeSocket(options);
      sockets.push(socket);
      if (opts?.autoConnect !== false) socket.connect();
      return socket;
    },
    sockets,
    calls,
    get last() {
      const socket = sockets[sockets.length - 1];
      if (!socket) throw new Error('createFakeIo: io() was not called');
      return socket;
    },
  };
}
