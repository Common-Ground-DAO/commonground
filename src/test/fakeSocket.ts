// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * A socket.io-client look-alike for transport tests. The test plays the
 * server: it accepts or refuses connections, answers acks (by handler or by
 * hand), delivers server events and drops the connection.
 *
 * Behaviour copied from socket.io-client 4.8 (`build/esm/socket.js`,
 * `manager.js`) because code tends to rely on it:
 * - On connect the send buffer is flushed *before* the `connect` listeners
 *   run (`onconnect`: `connected = true; emitBuffered(); emitReserved("connect")`).
 *   Emits while disconnected are buffered, `volatile` emits are dropped.
 * - Acks are registered per packet, not per connection. On `disconnect` every
 *   ack whose packet was already sent is cleared: error-first acks
 *   (`emitWithAck`, `timeout(ms)`, `ackTimeout`) get
 *   `Error("socket has been disconnected")`, plain acks are dropped silently.
 *   Buffered packets keep their ack. An answer the server sends after its
 *   connection is gone is never delivered. `timeout(ms)` errors with
 *   `Error("operation has timed out")` (and drops a still-buffered packet).
 * - Client `disconnect()` fires `disconnect` synchronously with
 *   `io client disconnect` and deactivates the socket; so do
 *   `drop('io server disconnect')` and a middleware `refuse(err, { middleware: true })`.
 *   An inactive socket stays dead until the code calls `connect()` again.
 * - Every connection gets a new `id`. Server acks arrive asynchronously
 *   (microtask); `deliver` is synchronous.
 * - `socket.io` is a minimal Manager emitter: `open`, `close` (`forced
 *   close` on client `disconnect()`), `error`, `reconnect_attempt`,
 *   `reconnect_error`, `reconnect`. A refused first connect starts the
 *   reconnect loop, so the next `accept()` is a reconnect.
 * The fake never reconnects on its own after `drop()`: the test decides when
 * (or whether) the reconnect succeeds via `accept()` / `refuse()`.
 */

type Listener = (...args: any[]) => void;
type AnyListener = (event: string, ...args: any[]) => void;
type Ack = ((...args: any[]) => void) & { withError?: boolean };

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

export interface BufferedPacket {
  event: string;
  args: unknown[];
  /** Ack id when the emit carried an ack. */
  ackId?: number;
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
  /** Prefix of the generated connection ids (default `sock<n>`). */
  idPrefix?: string;
  /** Default ack timeout in ms for every emit with an ack, like the client's `ackTimeout` option. */
  ackTimeout?: number;
}

const RESERVED = new Set(['connect', 'connect_error', 'disconnect', 'disconnecting', 'newListener', 'removeListener']);

/** Minimal event emitter, shared by the socket and its Manager. */
class Emitter {
  #listeners = new Map<string, Listener[]>();

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

  protected fire(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners(event)) listener(...args);
  }
}

/** The `socket.io` Manager: only its reserved events. */
export class FakeManager extends Emitter {
  /** Fires a Manager event (used by FakeSocket). */
  emitReserved(event: string, ...args: unknown[]): void {
    this.fire(event, ...args);
  }
}

let socketCounter = 0;

export class FakeSocket extends Emitter {
  id: string | undefined = undefined;
  connected = false;
  /** True while the socket wants to be connected (between `connect()` and `disconnect()`). */
  active = false;
  /** The Manager (`socket.io`). */
  readonly io = new FakeManager();

  /** Everything the client sent to the server, in order (after buffering). */
  readonly sent: SentPacket[] = [];
  /** Emits made while disconnected, flushed on the next connect. */
  readonly sendBuffer: BufferedPacket[] = [];
  /** Acks no handler answered yet, oldest first (server side). */
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

  readonly options: Required<Omit<FakeSocketOptions, 'ackTimeout'>> & Pick<FakeSocketOptions, 'ackTimeout'>;

  #anyListeners: AnyListener[] = [];
  #handlers = new Map<string, ServerHandler>();
  #acks = new Map<number, Ack>();
  #nextAckId = 0;
  #flags: { timeout?: number; volatile?: boolean } = {};
  #connectionCount = 0;
  #acceptScheduled = false;
  #reconnecting = false;
  #reconnectAttempts = 0;
  #inFlight = new Set<Promise<unknown>>();

  constructor(options: FakeSocketOptions = {}) {
    super();
    this.options = {
      autoAccept: options.autoAccept ?? true,
      defaultHandlers: options.defaultHandlers ?? true,
      idPrefix: options.idPrefix ?? `sock${++socketCounter}`,
      ackTimeout: options.ackTimeout,
    };
    if (this.options.defaultHandlers) this.#installDefaultHandlers();
  }

  get disconnected(): boolean {
    return !this.connected;
  }

  // ---------------------------------------------------------------- client API

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
    const flags = this.#flags;
    this.#flags = {};
    const last = args[args.length - 1];
    let ackId: number | undefined;
    if (typeof last === 'function') {
      args = args.slice(0, -1);
      ackId = this.#nextAckId++;
      this.#registerAck(ackId, last as Ack, flags.timeout ?? this.options.ackTimeout);
    }
    const packet: BufferedPacket = { event, args, ackId };
    if (flags.volatile && !this.connected) return this;
    if (this.connected) this.#transmit(packet);
    else this.sendBuffer.push(packet);
    return this;
  }

  /** Resolves with the ack value; rejects on timeout or disconnect, like the real client. */
  emitWithAck(event: string, ...args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const ack: Ack = (error: unknown, value: unknown) => (error ? reject(error) : resolve(value));
      ack.withError = true;
      this.emit(event, ...args, ack);
    });
  }

  /** `socket.timeout(ms).emit(ev, ..., (err, value) => …)`: the ack becomes error-first. */
  timeout(ms: number): this {
    this.#flags.timeout = ms;
    return this;
  }

  /** `socket.volatile.emit(...)`: dropped instead of buffered while disconnected. */
  get volatile(): this {
    this.#flags.volatile = true;
    return this;
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
    const wasActive = this.active;
    this.active = false;
    this.#reconnecting = false;
    this.#reconnectAttempts = 0;
    // destroy() runs before onclose(): the Manager closes ('forced close')
    // when its last active socket goes, before the socket's `disconnect`
    if (wasActive) this.io.emitReserved('close', 'forced close');
    if (this.connected) this.#close('io client disconnect');
    return this;
  }

  close(): this {
    return this.disconnect();
  }

  // ---------------------------------------------------------------- server API

  /**
   * Completes a pending (re)connect: new `id`, buffer flush, then `connect`.
   * Throws if the socket is inactive (never connected, or disconnected by the
   * client, the server or middleware): socket.io would not try.
   */
  accept(): this {
    if (this.connected) throw new Error('FakeSocket.accept: already connected');
    if (!this.active) throw new Error('FakeSocket.accept: socket is inactive; the code must call connect() first');
    if (this.#reconnecting) this.io.emitReserved('reconnect_attempt', ++this.#reconnectAttempts);
    this.io.emitReserved('open');
    if (this.#reconnecting) {
      this.io.emitReserved('reconnect', this.#reconnectAttempts);
      this.#reconnecting = false;
      this.#reconnectAttempts = 0;
    }
    this.#connectionCount += 1;
    this.id = `${this.options.idPrefix}-${this.#connectionCount}`;
    this.connected = true;
    this.loggedIn = false;
    const buffered = this.sendBuffer.splice(0);
    for (const packet of buffered) this.#transmit(packet);
    this.#fireEvent('connect');
    return this;
  }

  /**
   * Fails the current connect attempt with `connect_error`. A transport-level
   * failure leaves the socket active (socket.io keeps retrying); with
   * `{ middleware: true }` (the server's `io.use()` refused) it becomes
   * inactive, as in socket.io. Throws if the socket is inactive.
   */
  refuse(error: Error = new Error('xhr poll error'), options: { middleware?: boolean } = {}): this {
    if (this.connected) throw new Error('FakeSocket.refuse: already connected');
    if (!this.active) throw new Error('FakeSocket.refuse: socket is inactive; the code must call connect() first');
    if (options.middleware) {
      this.active = false;
      this.#reconnecting = false;
      this.#fireEvent('connect_error', error);
      return this;
    }
    if (this.#reconnecting) this.io.emitReserved('reconnect_attempt', ++this.#reconnectAttempts);
    this.io.emitReserved('error', error);
    this.#fireEvent('connect_error', error);
    if (this.#reconnecting) this.io.emitReserved('reconnect_error', error);
    // a failed first open starts the reconnect loop (Manager.maybeReconnectOnOpen)
    else this.#reconnecting = true;
    return this;
  }

  /**
   * The connection goes away (`transport close`, `ping timeout`, …). Socket.io
   * would retry; here it stays `active` until the test calls `accept()`. With
   * `io server disconnect` it becomes inactive, as in socket.io.
   */
  drop(reason = 'transport close', description?: unknown): this {
    if (!this.connected) return this;
    if (reason === 'io server disconnect') {
      this.active = false;
    } else {
      this.#reconnecting = true;
      this.io.emitReserved('close', reason, description);
    }
    this.#close(reason, description);
    return this;
  }

  /** Server → client event. Returns false (and drops it) when not connected. */
  deliver(event: string, ...args: unknown[]): boolean {
    if (!this.connected) return false;
    this.#fireEvent(event, ...args);
    return true;
  }

  /**
   * Server → client event with an ack the client answers. Resolves with the
   * client's ack arguments; rejects when not connected, or when the
   * connection goes away first.
   */
  deliverWithAck(event: string, ...args: unknown[]): Promise<unknown[]> {
    if (!this.connected) return Promise.reject(new Error('FakeSocket.deliverWithAck: not connected'));
    const socketId = this.id;
    return new Promise((resolve, reject) => {
      let answered = false;
      const onDisconnect = () => {
        if (!answered) reject(new Error('socket has been disconnected'));
      };
      this.once('disconnect', onDisconnect);
      this.#fireEvent(event, ...args, (...values: unknown[]) => {
        if (answered || this.id !== socketId) return;
        answered = true;
        this.off('disconnect', onDisconnect);
        resolve(values);
      });
    });
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

  #fireEvent(event: string, ...args: unknown[]): void {
    if (!RESERVED.has(event)) {
      for (const listener of [...this.#anyListeners]) listener(event, ...args);
    }
    this.fire(event, ...args);
  }

  #registerAck(id: number, ack: Ack, timeout: number | undefined): void {
    if (timeout === undefined) {
      this.#acks.set(id, ack);
      return;
    }
    const timer = setTimeout(() => {
      this.#acks.delete(id);
      const index = this.sendBuffer.findIndex(p => p.ackId === id);
      if (index >= 0) this.sendBuffer.splice(index, 1);
      ack.call(this, new Error('operation has timed out'));
    }, timeout);
    const wrapped: Ack = (...args) => {
      clearTimeout(timer);
      ack.apply(this, args);
    };
    wrapped.withError = true;
    this.#acks.set(id, wrapped);
  }

  #close(reason: string, description?: unknown): void {
    this.connected = false;
    this.loggedIn = false;
    this.id = undefined;
    // the server side of the old connection is gone with its unanswered acks
    this.pendingAcks.length = 0;
    this.#fireEvent('disconnect', reason, description);
    // _clearAcks(): acks of packets that were already sent can never be answered
    for (const [id, ack] of [...this.#acks]) {
      if (this.sendBuffer.some(p => p.ackId === id)) continue;
      this.#acks.delete(id);
      if (ack.withError) ack.call(this, new Error('socket has been disconnected'));
    }
  }

  #transmit(packet: BufferedPacket): void {
    const socketId = this.id!;
    const { event, args, ackId } = packet;
    this.sent.push({ event, args, socketId, hasAck: ackId !== undefined });

    const answer = (...values: unknown[]) => {
      if (ackId === undefined) return;
      queueMicrotask(() => {
        // late answer for a connection that is gone: socket.io never delivers it
        if (this.id !== socketId || !this.connected) return;
        const ack = this.#acks.get(ackId);
        if (!ack) return;
        this.#acks.delete(ackId);
        if (ack.withError) ack.call(this, null, ...values);
        else ack.apply(this, values);
      });
    };

    const handler = this.#handlers.get(event);
    if (handler) {
      const run = Promise.resolve().then(() => handler(args, this));
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
    if (ackId !== undefined) {
      const pending: PendingAck = {
        event,
        args,
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
 * connects right away unless `opts.autoConnect === false`; `opts.ackTimeout`
 * is honoured.
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
      const ackTimeout = typeof opts?.ackTimeout === 'number' ? opts.ackTimeout : options.ackTimeout;
      const socket = new FakeSocket({ ...options, ackTimeout });
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
