// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * The tab's Socket.IO connection: one socket per tab, no tab roles (chat-sync
 * decision [1], contract: ./transport.ts).
 *
 * - Visible tabs keep (or re-open) their socket. A hidden tab closes it after
 *   HIDDEN_DISCONNECT_AFTER_MS unless a SocketHold is active (a call); on
 *   `freeze` and `pagehide` it closes it at once, holds or not. After such a
 *   policy close it reconnects only on visible, `pageshow`, `resume` or
 *   `online` while visible — never on a timer while hidden.
 * - `live` = connected AND the socket login acked "OK" (rooms joined), or for
 *   an anonymous tab: connected and the socket-scoped joins re-sent.
 *   `Common.WebSocketState` is `connected` only while live.
 * - A reconnect performs the socket login only; the HTTP device login is the
 *   login manager's business (once per page load).
 * - A newer server build sets `updateAvailable`; the socket keeps working.
 */

import urlConfig from '../util/urls';
import config from '../../common/config';

import { io, type Socket } from 'socket.io-client';
import buildId from 'common/random_build_id';

import userApi from 'data/api/user';
import securityStepState from 'data/auth/securityStep';
import {
  HIDDEN_DISCONNECT_AFTER_MS,
  RESUME_MIN_HIDDEN_MS,
  type LiveKind,
  type ResumeReason,
  type SocketHold,
  type Transport,
  type Unsubscribe,
} from './transport';
import { fallbackSocketId, setRequestSocketIdProvider } from './requestSocketId';

type CgSocket = Socket<
  API.Server.ClientToServerEvents,
  API.Server.ServerToClientEvents
>;

/** Timeout of each ack of the socket login (`getSignableSecret`, `login`). */
export const SOCKET_LOGIN_ACK_TIMEOUT_MS = 10_000;
/** Backoff of socket-login retries after an "ERROR" ack (visible tabs only). */
export const SOCKET_LOGIN_RETRY_MS = [5_000, 15_000, 60_000] as const;
const PING_INTERVAL_MS = 59_000;
/** A pong older than this means the connection is dead although it looks open. */
const PONG_STALE_MS = 110_000;
const CONNECT_ERRORS_BEFORE_DISCONNECTED = 5;
/** Every disconnect may have lost events since this long before it (server ping timeout is 15 s). */
const DISCONNECT_SAFETY_MS = 30_000;

const debugLog = (...args: any[]) => {
  // console.log(...args);
};

class SocketLoginError extends Error { }

function emitAll<A extends unknown[]>(listeners: Set<(...args: A) => void>, ...args: A) {
  for (const listener of Array.from(listeners)) {
    try {
      listener(...args);
    } catch (e) {
      console.error('Error in WebSocketManager listener', e);
    }
  }
}

function subscribe<T>(set: Set<T>, listener: T): Unsubscribe {
  set.add(listener);
  return () => {
    set.delete(listener);
  };
}

export class WebSocketManager implements Transport {
  private _socket?: CgSocket;
  private _state: Common.WebSocketState = 'disconnected';
  private _onStateChange: (state: Common.WebSocketState) => (void | Promise<void>) = () => undefined;
  private _onError: (error: unknown) => void = (error) => console.error("Uncaught error in WebSocketManager", error);
  private _clientEventHandler: (((name: string, event: any) => void) | undefined);
  private _started = false;

  // live state
  private _live = false;
  private _everLive = false;
  /** ++ on every socket `connect` */
  private _connectionEpoch = 0;
  /** connection epoch of the last transition to live */
  private _liveEpoch = 0;
  /** device the current connection is logged in as (null: anonymous) */
  private _socketDeviceId: string | null = null;
  /** device the tab wants the socket logged in as (undefined: anonymous) */
  private _deviceId?: string;
  private _loginSync?: Promise<void>;
  private _loginRetryTimer?: ReturnType<typeof setTimeout>;
  private _loginRetryCount = 0;

  // policy
  private _holds = new Set<object>();
  private _hiddenTimer?: ReturnType<typeof setTimeout>;
  private _hiddenSince?: number;
  /** closed by policy (hidden timeout, freeze, pagehide): no reconnect until the tab returns */
  private _policyClosed = false;
  /** socket.io is waiting in its reconnect backoff (a nudge reconnects at once) */
  private _awaitingBackoff = false;
  private _consecutiveConnectErrors = 0;

  // liveness
  private _pingInterval?: ReturnType<typeof setInterval>;
  private _lastPong = 0;
  private _lastPongLocalTimeDelta = 0;
  private _lastEventTime = Date.now();

  private _updateAvailable = false;

  private _liveListeners = new Set<(kind: LiveKind) => void>();
  private _liveChangeListeners = new Set<(live: boolean) => void>();
  private _resumeListeners = new Set<(reason: ResumeReason) => void>();
  private _updateAvailableListeners = new Set<() => void>();
  private _socketConnectedListeners = new Set<() => void>();
  private _disconnectedListeners = new Set<(lastEventTime: number) => void>();

  /** legacy CG ID popup requests this tab's socket watches (re-sent on reconnect) */
  private cgIdRequestIds = new Set<string>();

  /**
   * @deprecated compatibility shim for the page-side service-worker code
   * before chat-sync; has no effect. Remove with the last caller.
   */
  public sendStateBroadcastUpdates = true;

  constructor() {
    setRequestSocketIdProvider(() => this.getRequestSocketId());
  }

  /**
   * Starts the transport: page lifecycle listeners, session keepalive, and the
   * first connect. Called once by connectionManager after the login manager
   * is loaded (so a stored device is known before the first socket login).
   */
  public start() {
    if (this._started) {
      return;
    }
    this._started = true;

    // keep the session alive (it stores nothing and creates no session)
    setInterval(() => {
      userApi.ensureSession().catch(e => {
        console.error('Error during ensureSession call in WebSocketManager', e);
      });
    }, 60_000 * 29);

    document.addEventListener('visibilitychange', () => this.onVisibilityChange());
    document.addEventListener('freeze', () => this.policyClose('freeze'));
    document.addEventListener('resume', () => this.onReturn('resume', true));
    window.addEventListener('pagehide', () => this.policyClose('pagehide'));
    window.addEventListener('pageshow', (event) => {
      if ((event as PageTransitionEvent).persisted) {
        this.onReturn('pageshow', true);
      }
    });
    window.addEventListener('online', () => {
      this.updateState();
      this.onReturn('online', true);
    });
    window.addEventListener('offline', () => this.updateState());

    if (document.visibilityState === 'hidden') {
      this._hiddenSince = Date.now();
      this.armHiddenTimer();
    }
    this.connect();
  }

  // ------------------------------------------------------------------ Transport

  get live(): boolean {
    return this._live;
  }

  public onLive(listener: (kind: LiveKind) => void): Unsubscribe {
    return subscribe(this._liveListeners, listener);
  }

  public onLiveChange(listener: (live: boolean) => void): Unsubscribe {
    return subscribe(this._liveChangeListeners, listener);
  }

  public onResume(listener: (reason: ResumeReason) => void): Unsubscribe {
    return subscribe(this._resumeListeners, listener);
  }

  get updateAvailable(): boolean {
    return this._updateAvailable;
  }

  public onUpdateAvailable(listener: () => void): Unsubscribe {
    return subscribe(this._updateAvailableListeners, listener);
  }

  public holdSocket(reason: 'call'): SocketHold {
    const token = { reason };
    this._holds.add(token);
    this.clearHiddenTimer();
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        this._holds.delete(token);
        if (this._holds.size === 0) {
          // a hidden tab's timer starts at the last release
          this.armHiddenTimer();
        }
      },
    };
  }

  public getRequestSocketId(): string {
    const socket = this._socket;
    if (!!socket && socket.connected && !!socket.id) {
      return socket.id;
    }
    return fallbackSocketId;
  }

  // ------------------------------------------------------------- internal hooks

  /** Raw socket `connect` (before the socket login). connectionManager starts the page's HTTP login on the first one. */
  public onSocketConnected(listener: () => void): Unsubscribe {
    return subscribe(this._socketConnectedListeners, listener);
  }

  /** Every socket `disconnect`, with the time up to which events are known to have arrived. */
  public onDisconnected(listener: (lastEventTime: number) => void): Unsubscribe {
    return subscribe(this._disconnectedListeners, listener);
  }

  // --------------------------------------------------------- state & callbacks

  get lastEventTime() {
    return this._lastEventTime;
  }

  get state() {
    return this._state;
  }

  get onStateChange() {
    return this._onStateChange;
  }
  set onStateChange(fn: (state: Common.WebSocketState) => (void | Promise<void>)) {
    this._onStateChange = fn;
  }
  get onError() {
    return this._onError;
  }
  set onError(fn: (error: unknown) => void) {
    this._onError = fn;
  }
  get clientEventHandler() {
    return this._clientEventHandler;
  }
  set clientEventHandler(handler: ((name: string, event: any) => void) | undefined) {
    this._clientEventHandler = handler;
  }

  /**
   * @deprecated compatibility shim: there are no tab roles any more, every
   * tab handles its own socket. Always `'active'`. Remove with the last
   * reader (channel.ts, wave 2).
   */
  get tabState(): Common.TabState {
    return 'active';
  }

  /**
   * @deprecated compatibility shim for the page-side service-worker code
   * before chat-sync; does nothing. Remove with the last caller.
   */
  public reRegister() {
    // no tab ids to renegotiate
  }

  private computeState(): Common.WebSocketState {
    if (this._live) return 'connected';
    const socket = this._socket;
    if (!socket || !socket.active) return 'disconnected';
    if (!navigator.onLine) return 'disconnected';
    if (!socket.connected && this._consecutiveConnectErrors >= CONNECT_ERRORS_BEFORE_DISCONNECTED) return 'disconnected';
    return 'connecting';
  }

  private updateState() {
    const state = this.computeState();
    if (state !== this._state) {
      this._state = state;
      try {
        const result = this._onStateChange(state);
        if (result instanceof Promise) {
          result.catch(e => this._onError(e));
        }
      } catch (e) {
        this._onError(e);
      }
    }
  }

  private setNotLive() {
    if (this._live) {
      this._live = false;
      this.updateState();
      emitAll(this._liveChangeListeners, false);
    } else {
      this.updateState();
    }
  }

  private becomeLive() {
    if (this._live) return;
    const kind: LiveKind = !this._everLive
      ? 'established'
      : (this._liveEpoch !== this._connectionEpoch ? 'restored' : 'user');
    this._everLive = true;
    this._liveEpoch = this._connectionEpoch;
    this._live = true;
    this._loginRetryCount = 0;
    debugLog('WebSocketManager live', kind);
    this.updateState();
    emitAll(this._liveChangeListeners, true);
    emitAll(this._liveListeners, kind);
  }

  // ----------------------------------------------------------------- policy

  private onVisibilityChange() {
    if (document.visibilityState === 'hidden') {
      this._hiddenSince = Date.now();
      this.armHiddenTimer();
    } else {
      const hiddenFor = this._hiddenSince === undefined ? 0 : Date.now() - this._hiddenSince;
      this._hiddenSince = undefined;
      this.clearHiddenTimer();
      this.onReturn('visible', hiddenFor >= RESUME_MIN_HIDDEN_MS);
    }
  }

  private armHiddenTimer() {
    this.clearHiddenTimer();
    if (document.visibilityState !== 'hidden' || this._holds.size > 0) {
      return;
    }
    this._hiddenTimer = setTimeout(() => {
      this._hiddenTimer = undefined;
      this.policyClose('hidden');
    }, HIDDEN_DISCONNECT_AFTER_MS);
  }

  private clearHiddenTimer() {
    if (this._hiddenTimer !== undefined) {
      clearTimeout(this._hiddenTimer);
      this._hiddenTimer = undefined;
    }
  }

  /** Closes the socket without auto-reconnect (hidden timeout, freeze, pagehide). */
  private policyClose(reason: 'hidden' | 'freeze' | 'pagehide') {
    debugLog('WebSocketManager policy close', reason);
    this.clearHiddenTimer();
    this.clearLoginRetry();
    this._policyClosed = true;
    this._awaitingBackoff = false;
    const socket = this._socket;
    if (!!socket && (socket.active || socket.connected)) {
      socket.disconnect();
    }
    this.updateState();
  }

  /**
   * The tab may have been away (visible again, bfcache restore, resume after
   * freeze, back online): a visible tab reconnects if its socket is not
   * live; with a live socket it asks for a catch-up (`onResume`) when
   * `wantResume`. Hidden tabs do nothing here.
   */
  private onReturn(reason: ResumeReason, wantResume: boolean) {
    if (document.visibilityState !== 'visible') {
      return;
    }
    if (this._live) {
      if (this.pongIsStale()) {
        console.warn("DISCONNECT DETECTED!");
        this.forceReconnect();
        return;
      }
      if (wantResume) {
        emitAll(this._resumeListeners, reason);
      }
      return;
    }
    if (this._socket?.connected) {
      // connected but not logged in (a failed or pending socket login): try again
      this.syncSocketLogin().catch(() => undefined);
      return;
    }
    this.connect();
  }

  private pongIsStale() {
    return this._lastPong !== 0 && this._lastPong + PONG_STALE_MS < Date.now() - this._lastPongLocalTimeDelta;
  }

  private forceReconnect() {
    const socket = this._socket;
    this._policyClosed = false;
    if (!socket) {
      this.connect();
      return;
    }
    socket.disconnect();
    this._awaitingBackoff = false;
    socket.connect();
    this.updateState();
  }

  // ------------------------------------------------------------- connection

  /**
   * Opens the socket (or re-opens it after a policy close). If socket.io is
   * waiting in its reconnect backoff, it reconnects at once.
   */
  public connect() {
    this._policyClosed = false;
    const socket = this._socket;
    if (!socket) {
      this.createSocket();
    } else if (socket.connected) {
      return;
    } else if (!socket.active) {
      socket.connect();
    } else if (this._awaitingBackoff) {
      this._awaitingBackoff = false;
      socket.disconnect();
      socket.connect();
    }
    this.updateState();
  }

  /** @deprecated use connect(); kept for old callers */
  public checkConnectionStatus() {
    if (document.visibilityState === 'visible' || !this._policyClosed) {
      this.connect();
    }
  }

  /** Drops the connection and reconnects (used after a stale pong). */
  public disconnect() {
    this.forceReconnect();
  }

  private createSocket() {
    const transports = ['websocket'];
    if (config.DEPLOYMENT !== 'dev') {
      transports.unshift('polling');
    }

    const socket: CgSocket = io(`${urlConfig.WS_URL}`, {
      transports,
      reconnectionDelayMax: 10000,
      reconnection: true,
      path: "/api/ws/",
    });
    this._socket = socket;

    socket.on("connect", () => {
      this._connectionEpoch++;
      this._consecutiveConnectErrors = 0;
      this._awaitingBackoff = false;
      this._socketDeviceId = null;
      this._lastPong = 0;

      socket.emit("cgPing", (timestamp) => {
        this._lastPong = timestamp;
        this._lastPongLocalTimeDelta = Date.now() - timestamp;
      });
      // socket-scoped state of an anonymous socket, re-sent on every connection
      for (const frontendRequestId of this.cgIdRequestIds) {
        socket.emit("watchCgIdRequest", { frontendRequestId });
      }

      if (this._pingInterval !== undefined) clearInterval(this._pingInterval);
      this._pingInterval = setInterval(() => this.pingIntervalHandler(), PING_INTERVAL_MS);

      this.updateState();
      emitAll(this._socketConnectedListeners);
      this.syncSocketLogin().catch(e => {
        debugLog('Socket login after connect failed', e);
      });
    });

    socket.on("connect_error", (error) => {
      // socket.io keeps retrying (reconnection: true) unless middleware
      // refused; the displayed state must not claim "connecting" forever
      this._consecutiveConnectErrors++;
      this._awaitingBackoff = socket.active;
      debugLog(`Socket.io connect_error (${this._consecutiveConnectErrors})`, error?.message);
      this.updateState();
    });

    socket.on("disconnect", reason => {
      debugLog(`Socket.io disconnected (${reason})`);
      this._socketDeviceId = null;
      this.clearLoginRetry();
      if (this._pingInterval !== undefined) {
        clearInterval(this._pingInterval);
        this._pingInterval = undefined;
      }
      // the server-side ping timeout is 15 s: events after (now - 30 s) may be lost
      this._lastEventTime = Math.max(this._lastEventTime, Date.now() - DISCONNECT_SAFETY_MS);
      emitAll(this._disconnectedListeners, this._lastEventTime);

      if (reason === "io server disconnect") {
        // socket.io does not reconnect by itself here (reconnecting first
        // keeps the state at "connecting", as for any other lost connection)
        if (!this._policyClosed) {
          socket.connect();
        }
      } else if (reason !== "io client disconnect") {
        // socket.io reconnects with its backoff
        this._awaitingBackoff = true;
      }
      this.setNotLive();
    });

    socket.on("buildId", (backendBuildId, time) => {
      this._lastEventTime = Date.now();
      if (Math.abs(time - Date.now()) > 10000) {
        // Todo: build better drift / delay detection
        // check with more events
        console.error("Server and client time are more than 10 seconds apart, this will lead to problems with timings");
      }
      if (
        backendBuildId !== buildId &&
        this._updateAvailable === false &&
        !window.location.href.match(/^https?:\/\/(localhost|bs-local\.com):3000/)
      ) {
        debugLog(`=== App update available: ${buildId} -> ${backendBuildId} ===`);
        this._updateAvailable = true;
        emitAll(this._updateAvailableListeners);
      }
    });

    socket.onAny((name: string, event: any) => {
      this._lastEventTime = Date.now();
      debugLog("Socket.io event received", name, event);
      if (name.startsWith("cli")) {
        if (!!this._clientEventHandler) {
          this._clientEventHandler(name, event);
        }
        else {
          console.warn(`Client Event received, but no listener registered yet: `, { ...event, type: name });
        }
      }
    });
  }

  private pingIntervalHandler() {
    const socket = this._socket;
    if (!socket?.connected) {
      return;
    }
    if (this.pongIsStale()) {
      console.warn("DISCONNECT DETECTED!");
      this.forceReconnect();
      return;
    }
    socket.emit("cgPing", (timestamp) => {
      this._lastPong = timestamp;
      this._lastPongLocalTimeDelta = Date.now() - timestamp;
    });
  }

  // ------------------------------------------------------------- socket login

  /**
   * Logs the socket in as `deviceId` and resolves once the server acked "OK"
   * (rooms joined, the tab is live). Rejects on "ERROR",
   * "SECURITY_STEP_REQUIRED", an ack timeout or a disconnect in between.
   * Without a connected socket it only remembers the device and resolves:
   * the socket logs in on its next connect.
   */
  public login(deviceId: string): Promise<void> {
    if (this._deviceId !== deviceId) {
      this._deviceId = deviceId;
      this._loginRetryCount = 0;
    }
    this.clearLoginRetry();
    if (!this._socket?.connected) {
      return Promise.resolve();
    }
    return this.syncSocketLogin();
  }

  /** The socket leaves its user rooms and stays connected as anonymous. */
  public logout() {
    this._deviceId = undefined;
    this.clearLoginRetry();
    if (!this._socket?.connected) {
      return;
    }
    this.syncSocketLogin().catch(e => {
      debugLog('Socket logout failed', e);
    });
  }

  /**
   * Brings the current connection's login in line with `_deviceId`, one step
   * at a time (the server runs socket handlers concurrently, so logins never
   * overlap: a later call waits for the running one).
   */
  private syncSocketLogin(): Promise<void> {
    const previous = this._loginSync ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(() => this.runSocketLogin());
    this._loginSync = run;
    void run.catch(() => undefined).finally(() => {
      if (this._loginSync === run) {
        this._loginSync = undefined;
      }
    });
    return run;
  }

  private async runSocketLogin(): Promise<void> {
    for (;;) {
      const socket = this._socket;
      if (!socket?.connected) {
        throw new SocketLoginError('socket not connected');
      }
      const epoch = this._connectionEpoch;
      const desired = this._deviceId ?? null;
      if (this._live && this._socketDeviceId === desired) {
        return;
      }
      // live is false from the start of every socket login until its ack
      this.setNotLive();
      if (this._socketDeviceId !== null) {
        socket.emit("logout");
        this._socketDeviceId = null;
      }
      if (desired === null) {
        this.becomeLive();
        continue;
      }

      let result: API.Socket.login.Response;
      try {
        const secret = await socket.timeout(SOCKET_LOGIN_ACK_TIMEOUT_MS).emitWithAck("getSignableSecret");
        this.throwIfStale(epoch);
        const { signApiSecret } = await import('data/util/device');
        const signedData = await signApiSecret(desired, secret);
        this.throwIfStale(epoch);
        result = await socket.timeout(SOCKET_LOGIN_ACK_TIMEOUT_MS).emitWithAck("login", signedData);
        this.throwIfStale(epoch);
      } catch (e) {
        if (e instanceof SocketLoginError || epoch !== this._connectionEpoch || !socket.connected) {
          throw e instanceof SocketLoginError ? e : new SocketLoginError('socket disconnected during login');
        }
        if (e instanceof Error && e.message === 'operation has timed out') {
          // the connection answers no acks: it is not usable, start over
          console.warn('Socket login timed out, reconnecting');
          if (!this._policyClosed) this.forceReconnect();
          throw new SocketLoginError('socket login timed out');
        }
        // signing failed (device key gone): the login manager finds out on its HTTP login
        this.scheduleLoginRetry();
        throw e;
      }

      if (result === 'OK') {
        this._socketDeviceId = desired;
        if ((this._deviceId ?? null) === desired) {
          this.becomeLive();
        }
        continue;
      }
      if (result === 'SECURITY_STEP_REQUIRED') {
        // no realtime until the account finished the step: show it
        securityStepState.set(true);
        throw new SocketLoginError('SECURITY_STEP_REQUIRED');
      }
      console.error('Socket login failed (ERROR)');
      this.scheduleLoginRetry();
      throw new SocketLoginError('ERROR');
    }
  }

  private throwIfStale(epoch: number) {
    if (epoch !== this._connectionEpoch || !this._socket?.connected) {
      throw new SocketLoginError('socket disconnected during login');
    }
  }

  private scheduleLoginRetry() {
    this.clearLoginRetry();
    if (this._deviceId === undefined) return;
    const delay = SOCKET_LOGIN_RETRY_MS[Math.min(this._loginRetryCount, SOCKET_LOGIN_RETRY_MS.length - 1)];
    this._loginRetryCount++;
    this._loginRetryTimer = setTimeout(() => {
      this._loginRetryTimer = undefined;
      // hidden tabs retry when they become visible (onReturn -> connect does not
      // re-login a connected socket, so check here as well)
      if (document.visibilityState === 'visible' && this._socket?.connected && !this._live) {
        this.syncSocketLogin().catch(() => undefined);
      }
    }, delay);
  }

  private clearLoginRetry() {
    if (this._loginRetryTimer !== undefined) {
      clearTimeout(this._loginRetryTimer);
      this._loginRetryTimer = undefined;
    }
  }

  // ------------------------------------------------------------------ misc

  /**
   * Legacy CG ID: receive the result of the CG ID popup request
   * `frontendRequestId` (cliCgIdSignResponse) on this socket. The server keeps
   * one watched request per socket.
   */
  public watchCgIdRequest(frontendRequestId: string) {
    this.cgIdRequestIds.clear();
    this.cgIdRequestIds.add(frontendRequestId);
    if (!!this._socket && this._socket.connected) {
      this._socket.emit("watchCgIdRequest", { frontendRequestId });
    }
  }

  public unwatchCgIdRequest(frontendRequestId: string) {
    this.cgIdRequestIds.delete(frontendRequestId);
  }

  /**
   * Ephemeral typing presence. Fire-and-forget (no ack); the server authorizes,
   * throttles, and relays a `cliTypingEvent` to the other participants. Only
   * emitted while the socket is live and logged in.
   */
  public setTyping(access: API.Messages.MessageAccess, isTyping: boolean) {
    if (!!this._socket && this._socket.connected && this._live && this._socketDeviceId !== null) {
      this._socket.emit("setTyping", { access, isTyping });
    }
  }
}

const webSocketManager = new WebSocketManager();
export default webSocketManager;
