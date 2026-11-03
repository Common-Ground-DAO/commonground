// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import webSocketManager from "./webSocket";
import type { LiveKind } from "./transport";
import { OBSOLETE_DATABASE_CLEANUP_DELAY_MS } from "../databases/obsoleteDatabases";

type WebSocketStateListener = (state: Common.WebSocketState) => void;
type ServiceWorkerStateListener = (state: Common.ServiceWorkerState) => void;
type ServiceWorkerProgressListener = (progress: number | null) => void;
type LoginStateListener = (state: Common.LoginState) => void;
type VisibilityStateListener = (state: Common.VisibilityState) => void;
type OnlineStateListener = (state: Common.OnlineState) => void;
type UpdateAvailableListener = (updateAvailable: boolean) => void;
type ErrorListener = (o: {origin: string, error: unknown}) => void;

/**
 * Debounce of the snapshot refresh after the socket is live again: a random
 * delay in [MIN, MAX) so the tabs of all clients do not refresh in step
 * after a server restart.
 */
export const REFRESH_AFTER_RESTORE_DEBOUNCE_MIN_MS = 1_000;
export const REFRESH_AFTER_RESTORE_DEBOUNCE_MAX_MS = 3_000;

const loginManagerP = (async () => {
  return (await import('./login')).default;
})();

const serviceWorkerManagerP = (async () => {
  return (await import('./serviceWorker')).default;
})();

export class ConnectionManager {
  private _serviceWorkerState: Common.ServiceWorkerState = "pending";
  private _serviceWorkerProgress: number | null = null;
  private _webSocketState: Common.WebSocketState = webSocketManager.state;
  private _loginState: Common.LoginState = "pending";
  private _visibilityState: Common.VisibilityState = document.visibilityState;
  private _onlineState: Common.OnlineState = navigator.onLine ? "online" : "offline";

  private _webSocketStateListeners = new Set<WebSocketStateListener>();
  private _serviceWorkerStateListeners = new Set<ServiceWorkerStateListener>();
  private _serviceWorkerProgressListeners = new Set<ServiceWorkerProgressListener>();
  private _loginStateListeners = new Set<LoginStateListener>();
  private _visibilityStateListeners = new Set<VisibilityStateListener>();
  private _onlineStateListeners = new Set<OnlineStateListener>();
  private _updateAvailableListeners = new Set<UpdateAvailableListener>();
  private _errorListeners = new Set<ErrorListener>();
  private _serviceWorkerNavigateListeners = new Set<(url: string) => void>();
  private _clientEventHandlers: Map<Events.ClientEvent["type"], Set<any>> = new Map();
  private _autoLoginTriggered = false;
  private _cleanUpIndexedDbsScheduled = false;
  private _refreshTimer: ReturnType<typeof setTimeout> | undefined;
  /** a `restored` happened while the page was hidden: refresh once it is visible */
  private _refreshPending = false;

  constructor() {
    webSocketManager.onStateChange = this.setWebSocketState.bind(this);
    webSocketManager.onError = this.onError.bind(this, "WebSocketManager");
    webSocketManager.clientEventHandler = this.eventHandler.bind(this);
    webSocketManager.onLive(this.onLive.bind(this));
    webSocketManager.onUpdateAvailable(() => {
      serviceWorkerManagerP.then(serviceWorkerManager => {
        serviceWorkerManager.update(true);
      });
      for (const listener of Array.from(this._updateAvailableListeners)) {
        listener(true);
      }
    });
    // The page's HTTP device login runs once, on the first socket connect
    // (the server is reachable then); reconnects only log the socket in.
    webSocketManager.onSocketConnected(() => {
      if (!this._autoLoginTriggered) {
        this._autoLoginTriggered = true;
        loginManagerP.then(loginManager => loginManager.autoLogin()).catch(e => {
          console.error("Error in autoLogin", e);
        });
      }
    });

    loginManagerP.then(loginManager => {
      this.setLoginState(loginManager.state);
      loginManager.onStateChange = this.setLoginState.bind(this);
      loginManager.onError = this.onError.bind(this, "LoginManager");
      // the login manager knows the stored device now: connect
      webSocketManager.start();
    });

    serviceWorkerManagerP.then(serviceWorkerManager => {
      this.setServiceWorkerState(serviceWorkerManager.state);
      serviceWorkerManager.onStateChange = this.setServiceWorkerState.bind(this);
      serviceWorkerManager.onProgress = this.setServiceWorkerProgress.bind(this);
      serviceWorkerManager.onError = this.onError.bind(this, "ServiceWorkerManager");
      serviceWorkerManager.navigate = (url: string) => {
        for (const listener of Array.from(this._serviceWorkerNavigateListeners)) {
          listener(url);
        }
      };
    });

    document.addEventListener("visibilitychange", this.updateVisibilityState.bind(this))
    window.addEventListener("online", () => this.setOnlineState("online"));
    window.addEventListener("offline", () => this.setOnlineState("offline", false));
    this.cleanUpIndexedDbs();
  }

  /* GETTERS & SETTERS */

  /** A newer build is deployed (see Transport.updateAvailable). */
  get updateAvailable(): boolean {
    return webSocketManager.updateAvailable;
  }

  // serviceworker state
  get serviceWorkerState(): Common.ServiceWorkerState {
    return this._serviceWorkerState;
  }
  private setServiceWorkerState(serviceWorkerState: Common.ServiceWorkerState): void {
    const oldState = this._serviceWorkerState;
    if (oldState !== serviceWorkerState) {
      this._serviceWorkerState = serviceWorkerState;
      for (const listener of Array.from(this._serviceWorkerStateListeners)) {
        listener(serviceWorkerState);
      }
    }
  }

  // serviceworker progress
  get serviceWorkerProgress(): number | null {
    return this._serviceWorkerProgress;
  }
  private setServiceWorkerProgress(serviceWorkerProgress: number | null): void {
    const oldProgress = this._serviceWorkerProgress;
    if (oldProgress !== serviceWorkerProgress) {
      this._serviceWorkerProgress = serviceWorkerProgress;
      for (const listener of Array.from(this._serviceWorkerProgressListeners)) {
        listener(serviceWorkerProgress);
      }
    }
  }

  // websocket state: `connected` only while live (Transport.live)
  get webSocketState(): Common.WebSocketState {
    return this._webSocketState;
  }
  private setWebSocketState(webSocketState: Common.WebSocketState): void {
    const oldState = this._webSocketState;
    if (oldState !== webSocketState) {
      this._webSocketState = webSocketState;
      if (webSocketState === "disconnected") {
        this.emit({ type: 'cliConnectionLost', lastKnownConnectionTime: webSocketManager.lastEventTime });
      }
      for (const listener of Array.from(this._webSocketStateListeners)) {
        listener(webSocketState);
      }
    }
  }

  /**
   * The app events of the old cache fire when the tab is live (socket
   * logged in, rooms joined), not on the raw socket connect. After a gap the
   * community/chat data is refreshed (debounced) — the catch-up the forced
   * device login of every reconnect used to do.
   */
  private onLive(kind: LiveKind): void {
    if (kind === 'established') {
      this.emit({ type: 'cliConnectionEstablished' });
    }
    else if (kind === 'restored') {
      this.emit({ type: 'cliConnectionRestored' });
      this.scheduleRefreshAfterRestore();
    }
  }

  /** Only visible tabs refresh; a hidden one remembers it for its return. */
  private scheduleRefreshAfterRestore(): void {
    if (document.visibilityState !== "visible") {
      this._refreshPending = true;
      return;
    }
    if (this._refreshTimer !== undefined) {
      clearTimeout(this._refreshTimer);
    }
    const delay = REFRESH_AFTER_RESTORE_DEBOUNCE_MIN_MS +
      Math.random() * (REFRESH_AFTER_RESTORE_DEBOUNCE_MAX_MS - REFRESH_AFTER_RESTORE_DEBOUNCE_MIN_MS);
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = undefined;
      if (document.visibilityState !== "visible") {
        this._refreshPending = true;
        return;
      }
      this._refreshPending = false;
      if (!webSocketManager.live) {
        // the next `restored` schedules it again
        return;
      }
      loginManagerP
        .then(loginManager => loginManager.refreshAfterReconnect())
        .catch(e => console.error("Error refreshing data after reconnect", e));
    }, delay);
  }

  // loginstate
  get loginState(): Common.LoginState {
    return this._loginState;
  }
  private setLoginState(loginState: Common.LoginState): void {
    const oldState = this._loginState;
    if (oldState !== loginState) {
      this._loginState = loginState;
      for (const listener of Array.from(this._loginStateListeners)) {
        listener(loginState);
      }

      if (
        oldState === "loggedin" &&
        (loginState === "loggingout" || loginState === "anonymous")
      ) {
        webSocketManager.logout();
      }
    }
  }

  // visibility state
  get visibilityState(): Common.VisibilityState {
    return this._visibilityState;
  }
  private updateVisibilityState(): void {
    if (document.visibilityState !== this._visibilityState) {
      this._visibilityState = document.visibilityState;
      for (const listener of Array.from(this._visibilityStateListeners)) {
        listener(this._visibilityState);
      }
      // we might have been in the background for a while, check if we're
      // still online and logged in (the socket handles its own reconnect)
      if (this._visibilityState === "visible") {
        if (this._refreshPending) {
          this.scheduleRefreshAfterRestore();
        }
        this.setOnlineState(navigator.onLine ? "online" : "offline", false);
        if (navigator.onLine) {
          loginManagerP.then(loginManager => {
            loginManager.checkLoginStatus();
          });
        }
      }
    }
  }

  // online state
  get onlineState(): Common.OnlineState {
    return this._onlineState;
  }
  private setOnlineState(onlineState: Common.OnlineState, checkLogin = true): void {
    if (onlineState !== this._onlineState) {
      this._onlineState = onlineState;
      for (const listener of Array.from(this._onlineStateListeners)) {
        listener(onlineState);
      }
      if (checkLogin && onlineState === "online") {
        loginManagerP.then(loginManager => {
          loginManager.checkLoginStatus();
        });
      }
    }
  }

  /**
   * Deletes the IndexedDB databases of removed client caches
   * (obsoleteDatabases.ts): once per page, in every tab (deleting is
   * idempotent), after a delay, fire-and-forget. Nothing waits for it and it
   * never throws.
   */
  private cleanUpIndexedDbs(): void {
    if (this._cleanUpIndexedDbsScheduled) return;
    this._cleanUpIndexedDbsScheduled = true;
    setTimeout(() => {
      Promise.all([import('../databases/obsoleteDatabases'), import('../databases/dbTracker')])
        .then(([{ deleteObsoleteDatabases }, { default: dbTracker }]) => deleteObsoleteDatabases({
          knownNames: () => dbTracker.knownDatabaseNames(),
          forget: name => dbTracker.forgetDatabase(name),
        }))
        .catch(e => console.warn("Obsolete IndexedDB cleanup could not start", e));
    }, OBSOLETE_DATABASE_CLEANUP_DELAY_MS);
  }

  /* LISTENER MANAGEMENT */

  public registerClientEventHandler<T extends Events.ClientEvent["type"]> (
    type: T,
    fn: (event: Events.ClientEvent & { type: T }) => void
  ) {
    const handlers = this._clientEventHandlers.get(type);
    if (!!handlers) {
      if (!handlers.has(fn)) {
        handlers.add(fn);
      } else {
        console.warn("registerClientEventHandler: handler is already registered");
      }
    } else {
      this._clientEventHandlers.set(type, new Set([fn]));
    }
  }

  public unregisterClientEventHandler<T extends Events.ClientEvent["type"]> (
    type: T,
    fn: (event: Events.ClientEvent & { type: T }) => void
  ) {
    const handlers = this._clientEventHandlers.get(type);
    if (!!handlers && handlers.has(fn)) {
      handlers.delete(fn)
    } else {
      console.warn("unregisterClientEventHandler: could not find the specified handler to unregister");
    }
  }

  public addListener(type: "webSocketStateChange", fn: WebSocketStateListener): void;
  public addListener(type: "serviceWorkerStateChange", fn: ServiceWorkerStateListener): void;
  public addListener(type: "serviceWorkerProgressChange", fn: ServiceWorkerProgressListener): void;
  public addListener(type: "loginStateChange", fn: LoginStateListener): void;
  public addListener(type: "visibilityStateChange", fn: VisibilityStateListener): void;
  public addListener(type: "onlineStateChange", fn: OnlineStateListener): void;
  public addListener(type: "updateAvailableChange", fn: UpdateAvailableListener): void;
  public addListener(type: "error", fn: ErrorListener): void;
  public addListener(type: "serviceWorkerNavigate", fn: (url: string) => void): void;
  public addListener(type: string, fn: any): void {
    if (type === "webSocketStateChange") {
      this._webSocketStateListeners.add(fn);
    } else if (type === "serviceWorkerStateChange") {
      this._serviceWorkerStateListeners.add(fn);
    } else if (type === "serviceWorkerProgressChange") {
      this._serviceWorkerProgressListeners.add(fn);
    } else if (type === "loginStateChange") {
      this._loginStateListeners.add(fn);
    } else if (type === "visibilityStateChange") {
      this._visibilityStateListeners.add(fn);
    } else if (type === "onlineStateChange") {
      this._onlineStateListeners.add(fn);
    } else if (type === "updateAvailableChange") {
      this._updateAvailableListeners.add(fn);
    } else if (type === "error") {
      this._errorListeners.add(fn);
    } else if (type === "serviceWorkerNavigate") {
      this._serviceWorkerNavigateListeners.add(fn);
    }
  }

  public removeListener(type: "webSocketStateChange", fn: WebSocketStateListener): void;
  public removeListener(type: "serviceWorkerStateChange", fn: ServiceWorkerStateListener): void;
  public removeListener(type: "serviceWorkerProgressChange", fn: ServiceWorkerProgressListener): void;
  public removeListener(type: "loginStateChange", fn: LoginStateListener): void;
  public removeListener(type: "visibilityStateChange", fn: VisibilityStateListener): void;
  public removeListener(type: "onlineStateChange", fn: OnlineStateListener): void;
  public removeListener(type: "updateAvailableChange", fn: UpdateAvailableListener): void;
  public removeListener(type: "error", fn: ErrorListener): void;
  public removeListener(type: "serviceWorkerNavigate", fn: (url: string) => void): void;
  public removeListener(type: string, fn: any): void {
    if (type === "webSocketStateChange") {
      this._webSocketStateListeners.delete(fn);
    } else if (type === "serviceWorkerStateChange") {
      this._serviceWorkerStateListeners.delete(fn);
    } else if (type === "serviceWorkerProgressChange") {
      this._serviceWorkerProgressListeners.delete(fn);
    } else if (type === "loginStateChange") {
      this._loginStateListeners.delete(fn);
    } else if (type === "visibilityStateChange") {
      this._visibilityStateListeners.delete(fn);
    } else if (type === "onlineStateChange") {
      this._onlineStateListeners.delete(fn);
    } else if (type === "updateAvailableChange") {
      this._updateAvailableListeners.delete(fn);
    } else if (type === "error") {
      this._errorListeners.delete(fn);
    } else if (type === "serviceWorkerNavigate") {
      this._serviceWorkerNavigateListeners.delete(fn);
    }
  }

  private onError(origin: string, error: unknown): void {
    const listeners = Array.from(this._errorListeners);
    if (listeners.length > 0) {
      for (const listener of listeners) {
        listener({origin, error});
      }
    } else {
      console.error(`ConnectionManager: Unhandled error in ${origin}`, error);
    }
  }

  /* PUBLIC */

  public finishInstallation() {
    serviceWorkerManagerP.then(serviceWorkerManager => {
      serviceWorkerManager.finishSwInstallation();
    });
  }

  public triggerSafeWindowReload() {
    loginManagerP.then(loginManager => {
      loginManager.triggerSafeWindowReload();
    });
  }

  /** Emit ephemeral typing presence for a message context (see webSocket.setTyping). */
  public sendTyping(access: API.Messages.MessageAccess, isTyping: boolean) {
    webSocketManager.setTyping(access, isTyping);
  }

  /* PRIVATE HELPERS */

  private eventHandler = (name: string, event: any) => {
    const handlers = this._clientEventHandlers.get(name as any);
    if (!!handlers) {
      const ev = { ...event, type: name };
      handlers.forEach(handler => handler(ev));
    } else {
      console.warn(`Received "${name}", but no handlers exist`, event);
    }
  };

  private emit(event: Events.ClientEvent) {
    const handlers = this._clientEventHandlers.get(event.type);
    if (!!handlers) {
      handlers.forEach(handler => handler(event));
    }
  }
}

const manager = new ConnectionManager();
export default manager;
