// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import urlConfig from '../util/urls';
import config from '../../common/config';

import { io, type Socket } from 'socket.io-client';
import buildId from 'common/random_build_id';

import type { WorkerToTabMessage, TabToWorkerMessage } from 'service-worker';
import { randomString } from '../../util';
import { type ConnectionManager } from './connection'; 
import cgIdApi from 'data/api/cgid';

const LOCAL_STORAGE_KEY = "CG_LAST_KNOWN_WS_CONNCETION";
const _localStorageLastEventTime = parseInt(localStorage.getItem(LOCAL_STORAGE_KEY) || '0') || Date.now();

const debugLog = (...args: any[]) => {
  // console.log(...args);
}

class WebSocketManager {
  private _state: Common.WebSocketState = "disconnected";
  private _socket?: Socket<
    API.Server.ClientToServerEvents,
    API.Server.ServerToClientEvents
  > & {
    cg_loggedin?: 0 | 1 | 2;
  };
  private _onStateChange: (state: Common.WebSocketState) => (void | Promise<void>) = () => undefined;
  private _onTabStateChange: (tabState: Common.TabState) => void = () => undefined;
  private _onError: (error: unknown) => void = (error) => console.error("Uncaught error in WebSocketManager", error);
  private _appUpdateTriggered = false;
  private _lastEventTime: number = _localStorageLastEventTime;
  private _deviceId?: string;
  private _clientEventHandler: (((name: string, event: any) => void) | undefined);
  private _connectionManager?: ConnectionManager;
  private webSocketStateBroadcast = new BroadcastChannel('CG_WEBSOCKET_STATE');
  private skipNextDisconnectHandler = false;
  private tabId: string = randomString(20);
  private _tabState: Common.TabState = 'unknown';
  private __fastInterval: any = undefined;
  public sendStateBroadcastUpdates = true;

  constructor() {
    // keep the session alive
    setInterval(() => {
      cgIdApi.ensureSession().catch(e => {
        console.error('Error during ensureSession call in WebSocketManager', e);
      });
    }, 60_000 * 29);

    window.addEventListener('storage', (event: StorageEvent) => {
      if (event.key === LOCAL_STORAGE_KEY && !!event.newValue) {
        this._lastEventTime = parseInt(event.newValue);
      }
    });

    window.addEventListener('beforeunload', () => {
      let lastDisconnect: number | undefined;
      let socketState: 'disconnected' | undefined;
      if (
        (this.tabState === 'active' || this.tabState === 'active-throttled') &&
        (!!this._socket && this._socket.connected)
      ) {
        lastDisconnect = Math.max(this._lastEventTime, Date.now() - 15000);
        socketState = 'disconnected';
        this.setLastEventTimeWithLocalStorage(lastDisconnect);
      }
      this.sendBroadcast({
        type: 'TabToWorker',
        tabId: this.tabId,
        tabState: 'tabClosed',
        socketState,
        lastDisconnect,
      });
    });

    (async () => {
      const [
        serviceWorkerManager,
        connectionManager,
      ] = await Promise.all([
        (await import('./serviceWorker')).default,
        (await import('./connection')).default,
        cgIdApi.ensureSession(),
      ]);

      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') {
          if (this.tabState === 'unknown') {
            this.sendStateUpdate();
          }
          if (
            (this.tabState === 'active' || this.tabState === 'active-throttled') &&
            this.lastPong !== 0 &&
            this.lastPong + 110_000 < Date.now() - this.lastPongLocalTimeDelta
          ) {
            console.warn("DISCONNECT DETECTED!");
            this.disconnect();
            this.connect();
          }
          if (this.tabState === 'passive' || this.tabState === 'passive-throttled') {
            // The live connection should follow the tab the user is looking at:
            // background tabs are timer-throttled and their socket can stall
            // without recovering. Claiming the active role broadcasts our
            // 'active' state, which makes the previous active tab demote
            // itself through the existing collision handling.
            this.tabState = 'active';
            this.sendBroadcast({
              type: 'TabToWorker',
              tabId: this.tabId,
              tabState: this.tabState,
            });
            this.connect();
          }
        }
      });

      this.webSocketStateBroadcast.onmessage = this.onBroadcastMessage.bind(this);

      this._connectionManager = connectionManager;
      const swState = serviceWorkerManager.state;
      if (swState === 'none') {
        this.tabState = 'active';
        console.warn("ONLY ONE TAB IS SUPPORTED IN DEV ENV (on port 3000)!");
        console.warn("CHANNELS AND STUFF CAN BREAK OTHERWISE!");
        this.connect();
      }
      else {
        this.sendStateUpdate();
        clearInterval(this.__fastInterval);
        this.__fastInterval = setInterval(this.sendStateUpdate.bind(this), 500);
      }
    })();
  }

  private sendBroadcast(message: TabToWorkerMessage) {
    if (this.sendStateBroadcastUpdates) {
      message.visible = document.visibilityState === 'visible';
      this.webSocketStateBroadcast.postMessage(message);
    }
  }

  private sendStateUpdate() {
    const message: TabToWorkerMessage = {
      type: 'TabToWorker',
      tabId: this.tabId,
      tabState: this.tabState,
    }
    if (this.tabState === 'active' || this.tabState === 'active-throttled') {
      message.socketState = this.state;
      message.lastEventTime = this.lastEventTime;
      if (!!this._connectionManager) {
        message.lastDisconnect = this._connectionManager.lastDisconnect.getTime();
      } 
    }
    this.sendBroadcast(message);
  }

  private onBroadcastMessage(ev: MessageEvent<TabToWorkerMessage | WorkerToTabMessage>) {
    const { data } = ev;
    debugLog('(Client ' + this.tabId + ') TabMessage', data);
    
    if (data.lastDisconnect !== undefined) {
      debugLog('Last disconnect changed', new Date(data.lastDisconnect))
      if (!!this._connectionManager) {
        if (data.lastDisconnect !== this._connectionManager.lastDisconnect.getTime()) {
          this._connectionManager.lastDisconnect = new Date(data.lastDisconnect);
        }
      }
      else {
        (async () => {
          const connectionManager = (await import('./connection')).default;
          this._connectionManager = connectionManager;
          if (!!data.lastDisconnect && data.lastDisconnect !== connectionManager.lastDisconnect.getTime()) {
            connectionManager.lastDisconnect = new Date(data.lastDisconnect);
          }
        })();
      }
    }
    else {
      debugLog('Last disconnect unchanged', new Date(this._connectionManager?.lastDisconnect || 0))
    }

    if (
      data.lastEventTime !== undefined &&
      data.lastEventTime !== this._lastEventTime
    ) {
      this._lastEventTime = data.lastEventTime;
    }

    if (
      data.socketState !== undefined &&
      this.tabState !== 'active' &&
      this.tabState !== 'active-throttled'
    ) {
      // Passive tabs mirror the active tab's connection state. An active tab
      // must never adopt it: a throttled zombie tab re-broadcasting a stale
      // 'connecting' would otherwise overwrite this tab's healthy state.
      this.state = data.socketState;
    }

    if (data.type === "TabToWorker" && data.tabId !== this.tabId) {
      if (
        (this.tabState === 'active' || this.tabState === 'active-throttled') &&
        (data.tabState === 'active' || data.tabState === 'active-throttled')
      ) {
        // Two tabs claim the active role. Resolve deterministically: the
        // visible tab wins; with equal visibility the higher tabId wins, so
        // exactly one side yields. Without this, a stale in-flight 'active'
        // broadcast from the tab being replaced could demote the tab the
        // user just switched to, bouncing the socket back to a hidden tab.
        const thisTabVisible = document.visibilityState === 'visible';
        const otherTabVisible = data.visible === true;
        const thisTabWins =
          (thisTabVisible && !otherTabVisible) ||
          (thisTabVisible === otherTabVisible && this.tabId > data.tabId);

        if (thisTabWins) {
          // Keep the active role and re-assert it; the other tab applies
          // the mirrored rule and demotes itself.
          this.sendStateUpdate();
          return;
        }

        // the other tab keeps the active role, disconnect here
        this.tabState =
          this.tabState === 'active' ? 'passive' : 'passive-throttled';

        if (!!this._socket && this._socket.connected) {
          this.skipNextDisconnectHandler = true;
          this._socket.disconnect();
        }

        this.sendBroadcast({
          type: 'TabToWorker',
          tabId: this.tabId,
          tabState: this.tabState,
        });
      }
    }
    else if (data.type === 'WorkerToTab' && data.tabId === this.tabId) {
      if (!!this.__fastInterval) {
        clearInterval(this.__fastInterval);
        this.__fastInterval = undefined;
        setInterval(this.sendStateUpdate.bind(this), 2000);
      }
      if (this.tabState === 'unknown' && data.tabState === 'active') {
        // no other tab exist, this is the first one => send initial values
        this.sendBroadcast({
          type: 'TabToWorker',
          tabId: this.tabId,
          tabState: data.tabState,
          lastDisconnect: this.lastEventTime,
          lastEventTime: this.lastEventTime,
          socketState: this.state,
        });
      }

      this.tabState = data.tabState;
      if (
        (this.tabState === 'active' || this.tabState === 'active-throttled') &&
        (!this._socket || this._socket.disconnected)
      ) {
        this.connect();
      }
      else if (this.tabState === 'passive' || this.tabState === 'passive-throttled' || this.tabState === 'unknown') {
        if (!!this._socket && this._socket.connected) {
          // if the tabState has explicitly been set to
          // "unknown", this is an intended disconnect
          if (this.tabState === 'unknown') {
            this.skipNextDisconnectHandler = false;
          } else {
            this.skipNextDisconnectHandler = true;
          }
          this._socket.disconnect();
        }
      }
    }
  }

  get lastEventTime() {
    return this._lastEventTime;
  }
  private setLastEventTimeWithLocalStorage(value: number) {
    this._lastEventTime = value;
    localStorage.setItem(LOCAL_STORAGE_KEY, value.toString());
  }

  get state() {
    return this._state;
  }
  set state(state: Common.WebSocketState) {
    const oldState = this._state;
    if (oldState !== state && oldState !== "version-update") {
      this._state = state;
      this._onStateChange(state);
    }
  }
  get onStateChange() {
    return this._onStateChange;
  }
  set onStateChange(fn: (state: Common.WebSocketState) => (void | Promise<void>)) {
    this._onStateChange = fn;
  }
  get onTabStateChange() {
    return this._onTabStateChange;
  }
  set onTabStateChange(fn: (tabState: Common.TabState) => void) {
    this._onTabStateChange = fn;
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
  get tabState() {
    return this._tabState;
  }
  set tabState(newState: Common.TabState) {
    if (newState !== this._tabState) {
      this._tabState = newState;
      this.onTabStateChange(newState);
    }
  }

  private pingInterval: any;
  private lastPong = 0;
  private lastPongLocalTimeDelta = 0;
  private consecutiveConnectErrors = 0;

  private pingIntervalHandler() {
    if (this.state === "connected" && (this.tabState === 'active' || this.tabState === 'active-throttled')) {
      if (this.lastPong !== 0 && this.lastPong + 110_000 < Date.now() - this.lastPongLocalTimeDelta) {
        console.warn("DISCONNECT DETECTED!");
        this.disconnect();
        this.connect();
      }
      else if (!!this._socket) {
        this._socket.emit("cgPing", (timestamp) => {
          this.lastPong = timestamp;
          this.lastPongLocalTimeDelta = Date.now() - timestamp;
        });
      }
    }
  }

  public connect() {
    if (
      !this._socket &&
      (this.tabState === 'active' || this.tabState === 'active-throttled')
    ) {
      const transports = ['websocket'];
      if (config.DEPLOYMENT !== 'dev') {
        transports.unshift('polling');
      }

      const socket: Socket<
        API.Server.ClientToServerEvents,
        API.Server.ServerToClientEvents
      > = io(`${urlConfig.WS_URL}`, {
        transports,
        reconnectionDelayMax: 10000,
        reconnection: true,
        path: "/api/ws/",
      });
      this._socket = socket;
      this._socket.cg_loggedin = 0;
      this.state = "connecting";
      this.sendStateUpdate();

      socket.on("connect", () => {
        this.consecutiveConnectErrors = 0;
        if (this.tabState === 'active' || this.tabState === 'active-throttled') {
          if (!!this._socket) {
            this._socket.cg_loggedin = 0;
          }
          this.state = "connected";
          this.sendStateUpdate();

          socket.emit("cgPing", (timestamp) => {
            this.lastPong = timestamp;
            this.lastPongLocalTimeDelta = Date.now() - timestamp;
          });

          clearInterval(this.pingInterval)
          this.pingInterval = setInterval(() => {
            this.pingIntervalHandler();
          }, 59_000);

          if (!!this._deviceId) {
            this._login(this._deviceId)
              .catch(e => {
                console.error(`Error during websocket login`, e);
              });
          }
        }
        else {
          this.skipNextDisconnectHandler = false;
          socket.disconnect();
        }
      });

      socket.on("connect_error", (error) => {
        // socket.io keeps retrying (reconnection: true), but the displayed
        // state must not claim "connecting" forever when the handshake keeps
        // failing — surface it as disconnected after a few attempts.
        this.consecutiveConnectErrors++;
        debugLog(`Socket.io connect_error (${this.consecutiveConnectErrors})`, error?.message);
        if (this.consecutiveConnectErrors >= 5 && this.state === "connecting") {
          this.state = "disconnected";
          this.sendStateUpdate();
        }
      });

      socket.on("disconnect", reason => {
        if (this.skipNextDisconnectHandler === true) {
          delete this._socket;
          this.skipNextDisconnectHandler = false;
          return;
        }
        // server-side pingTimeout is 15000, so (now - 30000) should be a safe value
        this.setLastEventTimeWithLocalStorage(Math.max(this._lastEventTime, Date.now() - 30000));
        if (!!this._connectionManager) {
          this._connectionManager.lastDisconnect = new Date(this._lastEventTime);
        }
        debugLog(`Socket.io disconnected (${reason})`);
        if (reason === "io server disconnect") {
          this.state = "disconnected";
          this.sendStateUpdate();
          if (this._socket === socket) delete this._socket;
          this.connect();
        } else if (reason === "io client disconnect") {
          this.state = "disconnected";
          this.sendStateUpdate();
          if (this._socket === socket) delete this._socket;
        } else if (reason === "transport close" || reason === "transport error") {
          if (navigator.onLine) {
            this.state = "connecting";
            this.sendStateUpdate();
          } else {
            this.state = "disconnected";
            this.sendStateUpdate();
            if (this._socket === socket) delete this._socket;
          }
        } else {
          this.state = "connecting";
          this.sendStateUpdate();
        }
      });
      
      socket.on("buildId", (backendBuildId, time) => {
        this.setLastEventTimeWithLocalStorage(Date.now());
        if (Math.abs(time - Date.now()) > 10000) {
          // Todo: build better drift / delay detection
          // check with more events
          console.error("Server and client time are more than 10 seconds apart, this will lead to problems with timings");
        }
        if (
          backendBuildId !== buildId &&
          this._appUpdateTriggered === false &&
          !window.location.href.match(/^https?:\/\/(localhost|bs-local\.com):3000/)
        ) {
          debugLog(`=== App update available ===`);
          debugLog(`Currently installed buildId: ${buildId}`);
          debugLog(`Available buildId: ${backendBuildId}`);
          debugLog(`=== Installing... ===`);
          this._appUpdateTriggered = true;
          this.state = "version-update";
          this.sendStateUpdate();
        }
      });

      socket.onAny((name: string, event: any) => {
        // only handle events if this tab is the active tab
        if (this.tabState === 'active' || this.tabState === 'active-throttled') {
          this.setLastEventTimeWithLocalStorage(Date.now());
          debugLog("Socket.io event received", name, event);
          if (name.startsWith("cli")) {
            if (!!this._clientEventHandler) {
              this._clientEventHandler(name, event);
            }
            else {
              console.warn(`Client Event received, but no listener registered yet: `, {...event, type: name});
            }
          }
        }
        else {
          console.warn('Received event through WebSocket although tab is not active, skipped.', event);
        }
      });
    }
  }

  public disconnect() {
    this.lastPong = 0;
    if (!!this._socket) {
      if (this._socket.connected) {
        this._socket.disconnect();
      } else {
        delete this._socket;
        this.state = "disconnected";
        this.sendStateUpdate();
      }
    } else {
      this.state = "disconnected";
      this.sendStateUpdate();
    }
  };

  public checkConnectionStatus() {
    if (
      navigator.onLine &&
      (
        this.state === "disconnected" ||
        !this._socket ||
        this._socket.disconnected
      )
    ) {
      if (this._socket?.disconnected) {
        delete this._socket;
      }
      if (!!this._socket) {
        delete this._socket;
      }
      this.connect();
    }
    else if (!navigator.onLine && this.state !== "disconnected") {
      this.disconnect();
    }
  }

  private loginPromise: Promise<void> | undefined;
  public async login(deviceId: string) {
    if (this._deviceId !== deviceId) {
      this._deviceId = deviceId;
    }
    if (!this.loginPromise) {
      this.loginPromise = new Promise<void>(async (resolve, reject) => {
        let rejected = false;
        const susTimeout = setTimeout(() => {
          console.log("WebSocketManager.login is taking longer than 7s, cancelling...");
          rejected = true;
          reject(new Error("WebSocketManager.login timed out"));
        }, 7_000);

        try {
          await this._login(this._deviceId!);
        }
        catch (e) {
          clearTimeout(susTimeout);
          rejected = true;
          reject(e);
        }
        finally {
          if (!rejected) {
            clearTimeout(susTimeout);
            resolve();
          }
          delete this.loginPromise;
        }
      });
    }
    return this.loginPromise;
  }

  private async _login(deviceId: string) {
    if (
      this.state === "connected" &&
      !!this._socket &&
      this._socket.connected &&
      this._socket.cg_loggedin === 0
    ) {
      this._socket.cg_loggedin = 1;
      this._socket.emit("getSignableSecret", async (secret: string) => {
        try {
          const signApiSecret = (await import('data/util/device')).signApiSecret;
          const signedData = await signApiSecret(deviceId, secret);
          if (!!this._socket) {
            this._socket?.emit("login", signedData, (result) => {
              if (result === 'OK') {
                if (!!this._socket) {
                  this._socket.cg_loggedin = 2;
                }
              } else if (result === 'ERROR') {
                if (!!this._socket) {
                  this._socket.cg_loggedin = 0;
                }
                console.error('Todo: Error handling for failed socket.io authentication');
              }
            });
          }
        } catch (e) {
          if (!!this._socket) {
            this._socket.cg_loggedin = 0;
          }
        }
      });
    }
  }

  public logout() {
    this._deviceId = undefined;
    this._socket?.emit("logout");
    if (!!this._socket) {
      this._socket.cg_loggedin = 0;
    }
  }
}

const webSocketManager = new WebSocketManager();
export default webSocketManager;