// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import webSocketManager from "./webSocket";

type WebSocketStateListener = (state: Common.WebSocketState) => void;
type ServiceWorkerStateListener = (state: Common.ServiceWorkerState) => void;
type ServiceWorkerProgressListener = (progress: number | null) => void;
type LoginStateListener = (state: Common.LoginState) => void;
type VisibilityStateListener = (state: Common.VisibilityState) => void;
type OnlineStateListener = (state: Common.OnlineState) => void;
type ClientEventsListener = (events: Events.ClientEvent[]) => void;
type TabStateListener = (tabState: Common.TabState) => void;
type ErrorListener = (o: {origin: string, error: unknown}) => void;

const loginManagerP = (async () => {
  return (await import('./login')).default;
})();

const serviceWorkerManagerP = (async () => {
  return (await import('./serviceWorker')).default;
})();

export class ConnectionManager {
  private _lastDisconnect = new Date(webSocketManager.lastEventTime);

  private _serviceWorkerState: Common.ServiceWorkerState = "pending";
  private _serviceWorkerProgress: number | null = null;
  private _tabState: Common.TabState = webSocketManager.tabState;
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
  private _tabStateListeners = new Set<TabStateListener>();
  private _errorListeners = new Set<ErrorListener>();
  private _serviceWorkerNavigateListeners = new Set<(url: string) => void>();
  private _initialWsConnection = true;
  private _clientEventHandlers: Map<Events.ClientEvent["type"], Set<any>> = new Map();
  private _autoLoginTriggered = false;
  private _cleanUpIndexedDbsPromise: Promise<void> | null = null;

  constructor() {
    webSocketManager.onStateChange = this.setWebSocketState.bind(this);
    webSocketManager.onTabStateChange = this.setTabState.bind(this);
    webSocketManager.onError = this.onError.bind(this, "WebSocketManager");
    webSocketManager.clientEventHandler = this.eventHandler.bind(this);

    loginManagerP.then(loginManager => {
      this.setLoginState(loginManager.state);
      loginManager.onStateChange = this.setLoginState.bind(this);
      loginManager.onError = this.onError.bind(this, "LoginManager");
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

  get lastDisconnect(): Date {
    return this._lastDisconnect;
  }
  set lastDisconnect(value: Date) {
    this._lastDisconnect = value;
  }

  // tab state
  get tabState(): Common.TabState {
    return this._tabState;
  }
  private setTabState(tabState: Common.TabState): void {
    const oldState = this._tabState;
    if (oldState !== tabState) {
      this._tabState = tabState;
      for (const listener of Array.from(this._tabStateListeners)) {
        listener(tabState);
      }
    }
    this.cleanUpIndexedDbs();
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

  // websocket state
  get webSocketState(): Common.WebSocketState {
    return this._webSocketState;
  }
  private setWebSocketState(webSocketState: Common.WebSocketState): void {
    const oldState = this._webSocketState;
    if (oldState !== webSocketState) {
      this._webSocketState = webSocketState;
      switch (webSocketState) {
        case "connected": {
          loginManagerP.then(loginManager => {
            const loginManagerAction = async () => {
              if (!this._autoLoginTriggered) {
                this._autoLoginTriggered = true;
                await loginManager.autoLogin();
              }
              else {
                await loginManager.checkLoginStatus(!this._initialWsConnection);
              }
            };
            // only do login things in active tab
            if (webSocketManager.tabState === 'active' || webSocketManager.tabState === 'active-throttled') {
              loginManagerAction().catch(e => {
                console.error("Error in loginManagerAction", e);
              });
            }
            // if we're in unknown state, we need to wait for the tab to become active
            // but it might take up to 3 seconds, so we need to check every 500ms
            else if (webSocketManager.tabState === 'unknown') {
              let counter = 0;
              const interval = setInterval(() => {
                if (webSocketManager.tabState === 'active' || webSocketManager.tabState === 'active-throttled') {
                  clearInterval(interval);
                  loginManagerAction().catch(e => {
                    console.error("Error in delayed loginManagerAction", e);
                  });
                }
                else {
                  counter++;
                  if (counter >= 6) {
                    clearInterval(interval);
                  }
                }
              }, 500);
            }

            if (this._initialWsConnection) {
              this._initialWsConnection = false;
              this.emit({ type: 'cliConnectionEstablished' });
            } else {
              this.emit({ type: 'cliConnectionRestored' });
            }
          });
          break;
        }
        case "version-update": {
          serviceWorkerManagerP.then(serviceWorkerManager => {
            serviceWorkerManager.update(true);
          });
          break;
        }
        case "disconnected": {
          this.emit({ type: 'cliConnectionLost', lastKnownConnectionTime: webSocketManager.lastEventTime });
          break;
        }
      }
      for (const listener of Array.from(this._webSocketStateListeners)) {
        listener(webSocketState);
      }
    }
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
      // we might have been in the background for a while, check if we're still online
      if (this._visibilityState === "visible") {
        this.setOnlineState(navigator.onLine ? "online" : "offline", false);
        if (navigator.onLine) {
          loginManagerP.then(loginManager => {
            loginManager.checkLoginStatus();
          });
        }
        webSocketManager.checkConnectionStatus();
      }
    }
  }

  // online state
  get onlineState(): Common.OnlineState {
    return this._onlineState;
  }
  private setOnlineState(onlineState: Common.OnlineState, checkLoginAndWs = true): void {
    if (onlineState !== this._onlineState) {
      this._onlineState = onlineState;
      for (const listener of Array.from(this._onlineStateListeners)) {
        listener(onlineState);
      }
      if (checkLoginAndWs) {
        if (onlineState === "online") {
          loginManagerP.then(loginManager => {
            loginManager.checkLoginStatus();
          });
        }
        webSocketManager.checkConnectionStatus();
      }
    }
  }

  // indexedDb cleanup
  private cleanUpIndexedDbs(): void {
    if (!this._cleanUpIndexedDbsPromise && (this._tabState === 'active' || this._tabState === 'active-throttled')) {
      this._cleanUpIndexedDbsPromise = new Promise((resolve, reject) => {
        setTimeout(async () => {
          console.log("SPAWNING DB CLEANUP JOB...");
          try {
            const dbTracker = (await import('../databases/dbTracker')).default;
            await dbTracker.deleteOldIndexedDbs();
            resolve();
          }
          catch (e) {
            console.error("Error during indexedDb cleanup", e);
            reject(e);
          }
        }, 10_000);
      });
    }
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
  public addListener(type: "tabStateChange", fn: TabStateListener): void;
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
    } else if (type === "tabStateChange") {
      this._tabStateListeners.add(fn);
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
  public removeListener(type: "tabStateChange", fn: TabStateListener): void;
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
    } else if (type === "tabStateChange") {
      this._tabStateListeners.delete(fn);
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