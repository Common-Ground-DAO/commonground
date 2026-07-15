// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import notificationsApi from 'data/api/notifications';
import type { ServiceWorkerMessage } from '../../service-worker';
import loginManager from './login';
import webSocketManager from './webSocket';

export type MessageFromServiceWorker = {
  action: 'reload';
} | {
  action: 'navigate';
  url: string;
  ackPort?: MessagePort;
} | {
  action: 'channel_notification_closed';
  channelId: string;
}

const FAST_UPDATE_INTERVAL = 3000;
const SLOW_UPDATE_INTERVAL = 30000;

let UPDATE_INTERVAL = SLOW_UPDATE_INTERVAL;

const { href } = window.location;
const re = /^https?:\/\/[^/:]+:3000/;
const SW_ENABLED = 'serviceWorker' in navigator && href.match(re) === null;

function __getRegistration() {
  if (!SW_ENABLED) return null;
  return navigator.serviceWorker.register("/service-worker.js", {scope: "/"});
}

const skipWaitingMessage: ServiceWorkerMessage = {
  type: 'SKIP_WAITING',
};
const stopTabHandlingMessage: ServiceWorkerMessage = {
  type: 'STOP_TAB_HANDLING',
};

function debugLog(...args: any[]) {
  // console.log(...args);
}

class ServiceWorkerManager {
  private _state: Common.ServiceWorkerState;
  private _onStateChange: (state: Common.ServiceWorkerState) => (void | Promise<void>) = () => undefined;
  private _onProgress: (progress: number) => (void | Promise<void>) = () => undefined;
  private _onError: (error: unknown) => void = (error) => console.error("Uncaught error in ServiceWorkerManager", error);
  private _updateTimeout: any;
  private _installationInProgress = false;
  private _installationSuccessful: boolean = true;
  private _initialInstallation: boolean | null = null;
  private _pushSubscription: Models.Notification.PushSubscription | null | "not-available" | "wait-for-renew" | undefined = SW_ENABLED === false ? "not-available" : undefined;
  private _nativePushSubscription: PushSubscription | null = null;

  private __pendingSwNavigateUrl: string | undefined;
  private __navigate: (url: string) => void = (url) => {
    this.__pendingSwNavigateUrl = url;
  };

  get navigate() {
    return this.__navigate;
  };

  set navigate(fn: (url: string) => void) {
    this.__navigate = fn;
    if (this.__pendingSwNavigateUrl) {
      const url = this.__pendingSwNavigateUrl;
      delete this.__pendingSwNavigateUrl;
      setTimeout(() => {
        fn(url);
      }, 0);
    }
  };

  constructor() {
    this.update = this.update.bind(this);
    const SW_REG = __getRegistration();
    if (SW_REG === null) {
      this._state = "none";
    } else {
      this._state = "pending";
      const that = this;

      navigator.serviceWorker.addEventListener('message', function (this: ServiceWorkerContainer, ev: MessageEvent<MessageFromServiceWorker>) {
        if (ev.data.action === 'reload' && that._initialInstallation !== true) {
          webSocketManager.sendStateBroadcastUpdates = false;
          loginManager.triggerSafeWindowReload();
        }
        else if (ev.data.action === 'reload') {
          // Initial installation: the page will not reload, but the
          // activating worker has already banned our tabId (it assumes every
          // pre-activation tab reloads). Without re-registering under a fresh
          // id this tab becomes a permanent ghost the worker is deaf to — it
          // can hold a socket and fight every arbitration decision.
          webSocketManager.reRegister();
        }
        else if (ev.data.action === 'navigate') {
          console.log("NAVIGATE EVENT", ev.data);
          const url = ev.data.url;
          setTimeout(() => {
            that.navigate(url);
          }, 50);
          ev.data.ackPort?.postMessage({ ack: true });
          ev.data.ackPort?.close();
        }
        else if (ev.data.action === 'channel_notification_closed') {
          // This is disabled for now since push notifications that do not
          // trigger a new notification would interfere with the
          // no-silent-push directive from the web push standard

          // if (webSocketManager.tabState === 'active' || webSocketManager.tabState === 'active-throttled') {
          //   const { channelId } = ev.data;
          //   notificationsApi.channelPushNotificationClosed({ channelId });
          // }
        }
      });

      SW_REG.then(async registration => {
        this.setStateByRegistrationStatus(registration);
        registration.onupdatefound = this.onupdatefound.bind(this, registration);
        if ('pushManager' in registration) {
          const subscription = await registration.pushManager.getSubscription();
          this._nativePushSubscription = subscription;
          if (subscription === null) {
            if (window.Notification.permission === 'granted') {
              this._pushSubscription = 'wait-for-renew';
            }
            else {
              this._pushSubscription = null;
            }
          }
          else {
            this._pushSubscription = subscription.toJSON() as any;
          }
        }
        else {
          this._pushSubscription = "not-available";
        }
        
        document.addEventListener('visibilitychange', ev => {
          if (document.visibilityState === 'visible') {
            this.setStateByRegistrationStatus(registration);
          }
        });

        this.update();
      });
    }
  }

  private getRegistration() {
    const SW_REG = __getRegistration();
    if (SW_REG === null) return null;
    return SW_REG.then(registration => {
      registration.onupdatefound = this.onupdatefound.bind(this, registration);
      return registration;
    });
  }

  public onpushsubscriptionchange(subscription: Models.Notification.PushSubscription | null | "not-available" | "wait-for-renew") {
    // will be overwritten by connectionManager
  }

  private _setupPromise: Promise<void> | undefined;
  public async setupAfterLogin(subscription: Models.Notification.PushSubscription | null): Promise<void> {
    if (!this._setupPromise) {
      this._setupPromise = new Promise<void>(async (resolve, reject) => {
        let rejected = false;
        const susTimeout = setTimeout(() => {
          console.log("ServiceWorkerManager.setupAfterLogin is taking longer than 7s, cancelling...");
          rejected = true;
          reject(new Error("ServiceWorkerManager.setupAfterLogin timed out"));
        }, 7_000);
    
        try {
          const registration = await this.getRegistration();
          // if client does not support push, return
          if (registration === null || this._pushSubscription === "not-available") {
            return;
          }
          /**
           * if we just logged in and a browser subscription
           * already exists, set it for the current device
           */
          if (this._pushSubscription === "wait-for-renew") {
              // permissions have been granted already, so we can simply
              // re-subscribe without user interaction
              console.log("WebPush subscription is null and permissions are granted already, re-subscribing...");
              await this.subscribeWebPush();
          }
          else if (!!this._pushSubscription) {
            if (this._pushSubscription.endpoint !== subscription?.endpoint)
              await notificationsApi.registerWebPushSubscription(this._pushSubscription);
          }
          else if (this._pushSubscription !== subscription) {
            if (!!subscription && this._pushSubscription === null && window.Notification.permission !== 'granted') {
              // there is a subscription on the server side, but not on the client side.
              notificationsApi.unregisterWebPushSubscription().catch(console.error);
              this.setPushSubscription(null);
            }
            else {
              this.setPushSubscription(subscription);
            }
          }
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
          delete this._setupPromise;
        }
      });
    }
    return this._setupPromise;
  }

  public logout() {
    // push subscription can be kept
  }

  get state() {
    return this._state;
  }
  set state(state: Common.ServiceWorkerState) {
    const oldState = this._state;
    if (oldState !== state) {
      this._state = state;
      this._onStateChange(state);
    }
  }
  get onStateChange() {
    return this._onStateChange;
  }
  set onStateChange(fn: (state: Common.ServiceWorkerState) => (void | Promise<void>)) {
    this._onStateChange = fn;
  }
  get onProgress() {
    return this._onProgress;
  }
  set onProgress(fn: (progress: number) => (void | Promise<void>)) {
    this._onProgress = fn;
  }
  get onError() {
    return this._onError;
  }
  set onError(fn: (error: unknown) => void) {
    this._onError = fn;
  }

  get currentPushSubscription() {
    return this._pushSubscription;
  }
  private setPushSubscription(subscription: Models.Notification.PushSubscription | null | "not-available") {
    this._pushSubscription = subscription;
    this.onpushsubscriptionchange(subscription);
  }

  private sendSkipWaiting(worker: ServiceWorker) {
    this._installationInProgress = false;
    worker.postMessage(skipWaitingMessage);
  }

  private onupdatefound(registration: ServiceWorkerRegistration, ev: Event) {
    UPDATE_INTERVAL = FAST_UPDATE_INTERVAL;
    this.setNextUpdateTimeout(UPDATE_INTERVAL);
    this.setStateByRegistrationStatus(registration);
  }

  private setStateByRegistrationStatus(registration: ServiceWorkerRegistration) {
    const stateUpdateHandler = this.setStateByRegistrationStatus.bind(this, registration);
    const errorHandler = (error: any) => {
      this._installationInProgress = false;
      this._installationSuccessful = false;
      this.setNextUpdateTimeout(UPDATE_INTERVAL);
      debugLog(`Error in Service Worker installation, retrying in ${UPDATE_INTERVAL}ms`, error);
    };

    const { active, waiting, installing } = registration;
    const that = this;

    if (!!active && !!waiting && !!installing) {
      // install success => !!active && !!waiting
      //   old waiting worker becomes redundant
      //   former installing worker will now be waiting worker
      //
      // install failure => !!active && !!waiting
      //   old waiting worker stays in waiting
      //   installing worker becomes redundant
      //
      // since both cases end up in the same
      // "next" state, dedicated handling is required

      debugLog("ACTIVE, WAITING AND INSTALLING PRESENT. state = updating.");
      UPDATE_INTERVAL = FAST_UPDATE_INTERVAL;
      this._installationSuccessful = false;
      this._installationInProgress = true;
      this._initialInstallation = false;
      this.state = "updating";

      active.onstatechange = () => undefined;
      waiting.onstatechange = () => undefined;
      installing.onstatechange = function (this: ServiceWorker, ev: Event) {
        that._installationInProgress = false;

        if (this.state === "installed") {
          // installation successful
          that._installationSuccessful = true;
          stateUpdateHandler();
        }

        else if (this.state === "redundant") {
          stateUpdateHandler();
        }
      };
      installing.onerror = errorHandler;
    }

    else if (!!active && !!waiting) {
      // activation success => !!active
      //   old waiting worker becomes active
      //   former active worker becomes redundant
      //
      // another update found => !!active && !!waiting && !!installing

      UPDATE_INTERVAL = FAST_UPDATE_INTERVAL;
      this._initialInstallation = false;
      this._installationInProgress = false;
      if (this._installationSuccessful === true) {
        this.state = "updated";
      } else {
        this.state = "updating";
      }
      debugLog("ACTIVE AND WAITING PRESENT. state = " + this.state);
      active.onstatechange = () => undefined;
      waiting.onstatechange = function (this: ServiceWorker, ev: Event) {
        if (this.state === "activated") {
          // installation is finished, reset success guard
          that._installationSuccessful = false;
          active.postMessage(stopTabHandlingMessage);
          stateUpdateHandler();
        }

        else if (this.state !== "activating" && this.state !== "redundant") {
          debugLog("Unexpected: waiting worker went into state " + this.state);
          stateUpdateHandler();
        }
        // the worker will take care of sending
        // a reload message to all tabs, so nothing
        // else to do here
      };
    }

    else if (!!active && !!installing) {
      // install success => !!active && !!waiting
      //   installing worker will now be waiting worker
      //
      // install failure => !!active
      //   installing worker becomes redundant

      debugLog("ACTIVE AND INSTALLING PRESENT. state = updating.");
      UPDATE_INTERVAL = FAST_UPDATE_INTERVAL;
      this._initialInstallation = false;
      this._installationInProgress = true;
      this._installationSuccessful = false;
      this.state = "updating";
      active.onstatechange = () => undefined;
      installing.onstatechange = function (this: ServiceWorker, ev: Event) {
        that._installationInProgress = false;

        if (this.state === "installed") {
          // installation successful
          that._installationSuccessful = true;
          stateUpdateHandler();
        }

        else if (this.state === "redundant") {
          stateUpdateHandler();
        }
      };
      installing.onerror = errorHandler;
    }

    // else if (!!installing && !!waiting) {
    //   // can this happen? nah... right? RIGHT??
    //   debugLog("THIS CANNOT HAPPEN? CAN IT? (translation: an installing and a waiting service worker exist, but no active one)");
    // }

    else if (!!installing) {
      // install success => !!waiting
      //   installing worker will now be waiting worker
      //
      // install failure => <no workers>
      //   installing worker becomes redundant

      debugLog("INSTALLING PRESENT. state = installing.");
      UPDATE_INTERVAL = FAST_UPDATE_INTERVAL;
      this._initialInstallation = true;
      this._installationInProgress = true;
      this._installationSuccessful = false;
      this.state = "installing";
      installing.onstatechange = function (this: ServiceWorker, ev: Event) {
        that._installationInProgress = false;

        if (this.state === "installed") {
          // installation successful
          that._installationSuccessful = true;
          stateUpdateHandler();
        }
        else if (this.state === "redundant") {
          this.postMessage(stopTabHandlingMessage);
          stateUpdateHandler();
        }
      };
      installing.onerror = errorHandler;
    }

    else if (!!waiting) {
      // activation success => !!active
      //   waiting worker will now be active worker

      debugLog("WAITING PRESENT. state = installed");
      UPDATE_INTERVAL = FAST_UPDATE_INTERVAL;
      this._initialInstallation = true;
      this._installationInProgress = false;
      this._installationSuccessful = true;
      this.state = "installed";
      waiting.onstatechange = function (this: ServiceWorker, ev: Event) {
        if (this.state === "activated") {
          stateUpdateHandler();
        }
        else if (this.state !== "activating" && this.state !== "redundant") {
          debugLog("Unexpected: waiting worker went into state " + this.state);
          stateUpdateHandler();
        }
        else if (this.state === "redundant") {
          this.postMessage(stopTabHandlingMessage);
        }
      };
      waiting.onerror = errorHandler;
      this.sendSkipWaiting(waiting);
    }

    else if (!!active) {
      // only active worker exists

      if (this.state !== "updating") {
        debugLog("ACTIVE PRESENT. state = active");
        UPDATE_INTERVAL = SLOW_UPDATE_INTERVAL;
        if (this._initialInstallation === null) {
          this._initialInstallation = false;
        }
        this._installationInProgress = false;
        this._installationSuccessful = false;
        this.state = "active";
      }
    }

    else {
      this._initialInstallation = true;
      this._installationInProgress = false;
      this._installationSuccessful = false;
    }
  }

  public update(updateDetected: boolean = false) {
    try {
      if (updateDetected) {
        UPDATE_INTERVAL = FAST_UPDATE_INTERVAL;
      }
      if (!this._installationInProgress) {
        this.getRegistration()?.then(registration => {
          return registration.update();
        }).catch(e => {
          // no connection
        });
      }
    } finally {
      this.setNextUpdateTimeout(UPDATE_INTERVAL);
    }
  }

  public setNextUpdateTimeout(nextTimeout: number) {
    if (this._updateTimeout) {
      clearTimeout(this._updateTimeout);
    }
    this._updateTimeout = setTimeout(this.update, nextTimeout);
  }

  public channelVisited(channelId: string) {
    this.getRegistration()?.then(registration => {
      const message: ServiceWorkerMessage = {
        type: 'CHANNEL_VISITED',
        channelId,
      };
      registration.active?.postMessage(message);
    });
  }

  public finishSwInstallation() {
    const SW_REG = this.getRegistration();
    if (SW_REG === null) {
      throw new Error("No serviceWorkerRegistration exists");
    }
    SW_REG.then(registration => {
      const { active, waiting } = registration;
      if (!active) {
        console.warn("Update triggered, but no active SW exists. This is unexpected, still trying to update...");
      }
      if (!!waiting) {
        this.sendSkipWaiting(waiting);  
      }
    });
  }

  public async getActiveWebPushSubscription() {
    const SW_REG = this.getRegistration();
    if (SW_REG === null) {
      throw new Error("No ServiceWorker exists");
    }
    const registration = await SW_REG;
    if (!('pushManager' in registration)) {
      throw new Error("ServiceWorker does not support web push notifications");
    }
    const subscription = await registration.pushManager.getSubscription();
    return subscription;
  }

  private __subscribePromise: Promise<void> | undefined;
  public async subscribeWebPush() {
    if (!this.__subscribePromise) {
      this.__subscribePromise = new Promise<void>(async (resolve, reject) => {
        try {
          const SW_REG = this.getRegistration();
          if (SW_REG === null) {
            throw new Error("No ServiceWorker exists");
          }
          const registration = await SW_REG;
          if (!('pushManager' in registration)) {
            throw new Error("ServiceWorker does not support web push notifications");
          }
          const publicVapidKey = await notificationsApi.getPublicVapidKey();
          let subscription = await registration.pushManager.getSubscription();
          if (!subscription) {
            subscription = await registration.pushManager.subscribe({
              userVisibleOnly: true,
              applicationServerKey: urlBase64ToUint8Array(publicVapidKey),
            });
            const sub = subscription.toJSON() as Models.Notification.PushSubscription;
            this.setPushSubscription(sub);
            await notificationsApi.registerWebPushSubscription(sub);
          }
          resolve();
        }
        catch (e) {
          reject(e);
        }
        finally {
          this.__subscribePromise = undefined;
        }
      });
    }
    await this.__subscribePromise;
  }

  public async unsubscribeWebPush() {
    const SW_REG = this.getRegistration();
    if (SW_REG === null) {
      throw new Error("No ServiceWorker exists");
    }
    const registration = await SW_REG;
    if (!('pushManager' in registration)) {
      throw new Error("ServiceWorker does not support web push notifications");
    }
    await notificationsApi.unregisterWebPushSubscription();
    const subscription = await registration.pushManager.getSubscription();
    subscription?.unsubscribe();
    this.setPushSubscription(null);
  }
}

// Utility function
function urlBase64ToUint8Array(base64String: string) {
  const padding = '='.repeat((4 - base64String.length % 4) % 4);
  const base64 = (base64String + padding)
    .replace(/-/g, '+')
    .replace(/_/g, '/');

  const rawData = atob(base64);
  const outputArray = new Uint8Array(rawData.length);

  for (let i = 0; i < rawData.length; ++i) {
    outputArray[i] = rawData.charCodeAt(i);
  }
  return outputArray;
}

const serviceWorkerManager = new ServiceWorkerManager();
export default serviceWorkerManager;