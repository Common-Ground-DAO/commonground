// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import userApi from "../api/user";
import { generateNewKeyPair, getDeviceKeyPair, saveDeviceKeyPair, deleteDeviceKeyPair, getAllDeviceKeyPairs } from "../util/device";
import userDatabase from "data/databases/user";
import communityDatabase from "data/databases/community";
import chatDatabase from "data/databases/chats";
import webSocketManager from "./webSocket";
import notificationDatabase from "data/databases/notification";
import errors from "common/errors";
import { clearChat, setupChatAfterLogin } from "data/chat/runtime";
import channelDatabaseManager from "data/databases/channel";
import { UserProfileTypeEnum } from "common/enums";
import getSiweMessage from "util/siwe";
import uniqueDb from "data/databases/unique";
import stepUpManager from "data/auth/stepUp";
import securityStepState from "data/auth/securityStep";
import signedOutNotice from "data/auth/signedOut";
import { getAuthMode } from "data/auth/authMode";
import { type AuthenticationResponseJSON } from "@simplewebauthn/browser";
import notificationsApi from "data/api/notifications";
import { broadcastLoggedIn, broadcastLoggedOut, onAuthBroadcast, withLoginLock } from "./authBroadcast";
import type { AuthBroadcastMessage } from "./transport";

type CurrentUser = {
  userId: string;
  //alias: string;
  deviceId: string;
};

const DEBUG = false;
function debugLog(...args: any[]) {
  if (DEBUG) {
    console.log(...args);
  }
}

// Legacy CG ID (gateway) instances only: the deprecated 12-word recovery
// phrase some old clients kept in localStorage for a silent re-login.
const MNEMONIC_KEY = 'CRYPTOGRAM_USER_MNEMONIC';
const CURRENT_USER_KEY = 'CG_CURRENT_USER';
/**
 * Backoff of the page's device login after a failure other than NOT_FOUND
 * (network, server error, a lost lock), each ±50 % random; also retried at
 * once on the next visibility/online check.
 */
export const DEVICE_LOGIN_RETRY_MS = [5_000, 15_000, 60_000] as const;
/** deviceLoginRequest: the hold cap took the lock before the next step */
const LOCK_LOST = 'LOCK_LOST' as const;

export type LoginOptions =
  { account: 'wallet' } |
  { aliasOrEmail: string, password: string } |
  { email: string, code: string } |
  { account: 'twitter' } |
  { account: 'lukso' } |
  { account: 'farcaster' } |
  /** passkey on this origin: the assertion is verified by User/login itself */
  { account: 'passkey', authenticationResponse: AuthenticationResponseJSON } |
  /** legacy CG ID popup: redeems the assertion the CG ID app verified */
  { account: 'passkey-legacy' } |
  { deviceId: string };

class LoginManager {
  private _state: Common.LoginState = "pending";
  private _onStateChange: (state: Common.LoginState) => (Promise<void> | void) = () => undefined;
  private _onError: (error: unknown) => void = (error) => console.error("Uncaught error in LoginManager", error);
  private _loginInProgress?: Promise<API.User.login.Response | 'taken-over'>;
  /** a login of this tab is running (`_loginInProgress` lingers for a tick after it) */
  private _loginRunning = false;
  private _deviceLoginRetryTimer: ReturnType<typeof setTimeout> | undefined;
  private _deviceLoginRetryCount = 0;
  private _deviceLoginFailedAt = 0;
  private _currentUser: CurrentUser | null = JSON.parse(localStorage.getItem(CURRENT_USER_KEY) || 'null');
  private _windowReloadTriggered = false;
  private _waitBeforeWindowReload?: Promise<any>;

  constructor() {
    // Every tab keeps its own login state. Other tabs' logins and logouts
    // arrive as auth broadcasts; the `storage` event on CG_CURRENT_USER is
    // the fallback (BroadcastChannel can be missing or the message lost).
    onAuthBroadcast(message => {
      this.onAuthBroadcast(message).catch(e => console.error("Error handling auth broadcast", e));
    });
    window.addEventListener("storage", (event: StorageEvent) => {
      if (event.key === CURRENT_USER_KEY) {
        this.followStoredUser().catch(e => console.error("Error following stored user", e));
      }
    });
    // a tab back from the background may have missed both
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        this.followStoredUser().catch(e => console.error("Error following stored user", e));
      }
    });
    // signed out from another device (or by a change of the account's
    // password, email or sign-in methods there): the session and the device
    // key are gone on the server already
    import("./connection").then(({ default: connectionManager }) => {
      connectionManager.registerClientEventHandler("cliSignedOut", () => {
        this.signedOutElsewhere().catch(e => console.error("Error signing out", e));
      });
    });
    if (!!this._currentUser) {
      // what this account's security step was when the page was left: known
      // before the automatic re-login answers (data/auth/securityStep.ts)
      securityStepState.setUser(this._currentUser.userId);
      // the socket logs in as the stored device as soon as it connects
      webSocketManager.login(this._currentUser.deviceId).catch(e => debugLog("socket login", e));
      channelDatabaseManager.userId = this._currentUser.userId;
    }
  }

  public get state() {
    return this._state;
  }
  public set state(state: Common.LoginState) {
    const oldState = this._state;
    if (oldState !== state) {
      this._state = state;
      this._onStateChange(state);
    }
  }
  public get onStateChange() {
    return this._onStateChange;
  }
  public set onStateChange(fn: (state: Common.LoginState) => (Promise<void> | void)) {
    this._onStateChange = fn;
  }
  public get onError() {
    return this._onError;
  }
  public set onError(fn: (error: unknown) => void) {
    this._onError = fn;
  }

  public get currentUser(): Readonly<CurrentUser | null> {
    return this._currentUser;
  }
  private setCurrentUser(data: CurrentUser | null) {
    this._currentUser = data;
    securityStepState.setUser(data?.userId ?? null);
    localStorage.setItem(CURRENT_USER_KEY, JSON.stringify(data));
  }

  public triggerSafeWindowReload() {
    if (this._windowReloadTriggered === false) {
      this._windowReloadTriggered = true;
      if (!!this._waitBeforeWindowReload) {
        this._waitBeforeWindowReload.finally(() => {
          window.location.reload();
        });
        setTimeout(() => {
          window.location.reload();
        }, 1500);
      } else {
        window.location.reload();
      }
    }
  }

  private __autoLoginPromise: Promise<void> | undefined;
  public async autoLogin(): Promise<void> {
    if (!this.__autoLoginPromise) {
      this.__autoLoginPromise = (async () => {
        let result: API.User.login.Response | undefined;
        let triedLogin = false;

        if (!navigator.onLine) {
          // app is offline
          if (!!this.currentUser) {
            webSocketManager.login(this.currentUser.deviceId).catch(e => debugLog("socket login", e));
            this.state = "loggedin";
          }
          else {
            this.state = "anonymous";
          }
          return;
        }

        if (!this.currentUser) {
          try {
            const keyPairs = await getAllDeviceKeyPairs();
            if (keyPairs.length > 0) {
              const ownData = (await uniqueDb.uniques.get("OwnData")) as Unique.OwnData | undefined;
              if (!!ownData) {
                const deviceId = keyPairs.find(keyPair => keyPair.userId === ownData.data.id)?.deviceId;
                if (!!deviceId) {
                  this.setCurrentUser({
                    userId: ownData.data.id,
                    deviceId,
                  });
                }
              }
            }
          }
          catch (e) {
            console.error("Error in autoLogin currentUser detection", e);
          }
        }

        if (this.currentUser) {
          try {
            triedLogin = true;
            const outcome = await this._login({ deviceId: this.currentUser.deviceId }, true);
            if (outcome === 'taken-over') {
              // another tab had just logged in: its session serves this tab
              // too; or the stored user changed meanwhile: follow it
              if (!this._currentUser) {
                await this.followStoredUser();
              }
              return;
            }
            result = outcome;
          } catch (e) {
            if (e instanceof Error) {
              if (e.message === errors.server.NOT_FOUND) {
                // the device key is gone: this device was signed out from
                // elsewhere (the sign-out on this device clears it locally)
                await this.signedOutElsewhere();
                return;
              }
            }
            if (this.needsDeviceLoginRetry()) {
              this._deviceLoginFailedAt = Date.now();
              this.scheduleDeviceLoginRetry();
            }
            throw e;
          }
        }
    
        const mnemonic = localStorage.getItem(MNEMONIC_KEY);
        if (!!mnemonic && !getAuthMode().legacyCgid) {
          // the recovery-phrase login only exists on the legacy gateway
          localStorage.removeItem(MNEMONIC_KEY);
        }
        else if (!result && !!mnemonic) {
          try {
            triedLogin = true;
            const mnemonicResult = await this.prepareMnemonicLogin(mnemonic);
            if (mnemonicResult.readyForLogin) {
              result = await this._login({ account: 'wallet' });
              localStorage.removeItem(MNEMONIC_KEY);
            }
            else {
              console.error("Mnemonic not ready for login", mnemonicResult);
              throw new Error("Mnemonic login not ready");
            }
          } catch (e) {
            if (!(e instanceof Error && e.message === errors.server.NOT_FOUND)) {
              throw e;
            }
          }
        }
        else if (!!mnemonic) {
          localStorage.removeItem(MNEMONIC_KEY);
        }
    
        if (result === undefined) {
          if (triedLogin) {
            await this.logout();
          }
          else {
            this.state = "anonymous";
          }
        }
      })().finally(() => {
        delete this.__autoLoginPromise;
      });
    }
    await this.__autoLoginPromise;
  }

  /**
   * Re-checks the session of a logged-in tab (on becoming visible or back
   * online): an expired session gets a silent device-key re-login. A session
   * of another user means a login in another tab (the stored user follows);
   * it is never logged out from here.
   */
  public async checkLoginStatus() {
    if (this.needsDeviceLoginRetry()) {
      // at once, but never sooner than the first backoff step after the
      // last failure (the scheduled retry covers the time until then)
      if (Date.now() - this._deviceLoginFailedAt >= DEVICE_LOGIN_RETRY_MS[0]) {
        this.retryDeviceLoginIfNeeded();
      }
      return;
    }
    if (this.state === "loggedin" && !this._loginRunning && !this.logoutPromise) {
      try {
        const { userId } = await userApi.checkLoginStatus();
        if (userId === null) {
          await this.loginRequiredErrorHandler();
        }
        else if (userId !== this.currentUser?.userId) {
          console.warn(`User ID of the session (${userId}) differs from this tab's (${this.currentUser?.userId}), following the stored user`);
          await this.followStoredUser();
        }
      } catch (e) {
        console.error("Error in checkLoginStatus", e);
        // Todo: Check for network error, or whatever else is the reason?
      }
    }
  }

  /** interactive login (or a device-key re-login with `deviceId`) */
  public async login(options: LoginOptions): Promise<API.User.login.Response> {
    const result = await this._login(options);
    if ((result as unknown) === 'taken-over') {
      // joined a running page login that took another tab's session over
      throw new Error("Login cancelled by user");
    }
    return result;
  }

  private __loginRequiredLoginPromise: Promise<void> | undefined;
  /**
   * A request was answered LOGIN_REQUIRED (BaseApiConnector retries it once
   * afterwards). Under the login lock the tab first re-checks the session —
   * another tab may have logged in already, which keeps the session for the
   * same user — and only then logs in with its device key.
   */
  public async loginRequiredErrorHandler(): Promise<void> {
    if (!this.__loginRequiredLoginPromise) {
      this.__loginRequiredLoginPromise = (async () => {
        if (!this.currentUser) {
          if (this.state === "loggingin") {
            console.log("The last request requested a LOGIN_REQUIRED resource before login completion");
          } else if (this.state === "loggingout") {
            console.log("The last request requested a LOGIN_REQUIRED resource after logout completion");
          } else {
            console.log("Todo: Show login window now?");
          }
          return;
        }
        if (this._loginRunning && this._loginInProgress) {
          await this._loginInProgress.catch(() => undefined);
          return;
        }
        const userId = this.currentUser.userId;
        const sessionIsOurs = await withLoginLock(async () => {
          try {
            const status = await userApi.checkLoginStatus();
            return status.userId === userId;
          } catch {
            return false;
          }
        });
        if (!sessionIsOurs && this.currentUser?.userId === userId) {
          await this.autoLogin();
        }
      })().finally(() => {
        delete this.__loginRequiredLoginPromise;
      });
    }
    await this.__loginRequiredLoginPromise;
  }

  public async createUser(data: Omit<API.User.createUser.Request, 'device'>): Promise<API.User.createUser.Response> {
    const keyPair = await generateNewKeyPair();
    const publicKey = await (window.crypto.subtle.exportKey as any)(
      "jwk",
      keyPair.publicKey as any,
    );
    publicKey.key_ops = ["verify"];
    const requestData: API.User.createUser.Request = {
      ...data,
      device: {
        publicKey,
      },
    }
    const responseData = await withLoginLock(() => userApi.createUser(requestData));
    stepUpManager.markAuthenticated();
    await saveDeviceKeyPair(responseData.ownData.id, responseData.deviceId, keyPair);
    this.setCurrentUser({
      userId: responseData.ownData.id,
      deviceId: responseData.deviceId,
    });
    securityStepState.set(responseData.securityStepRequired === true);
    await this.setupAfterLogin(responseData);
    this.state = "loggedin";
    broadcastLoggedIn(responseData.ownData.id);
    return responseData;
  }

  /**
   * This device was signed out on the server (cliSignedOut, or its device
   * key is gone): sign out here too and tell the person why.
   */
  private async signedOutElsewhere() {
    if (!this.currentUser) {
      return;
    }
    // a logout in another tab of this browser deletes this device's key as
    // well: no notice for that
    const stored = this.readStoredUser();
    if (stored?.userId !== this.currentUser.userId) {
      // another tab of this browser has signed out already (every tab gets
      // cliSignedOut): follow it instead of a second User/logout
      await this.dropLoginOfOtherTab();
      return;
    }
    const ownLogout = Date.now() - this._loggedOutInOtherTabAt < 30_000;
    if (!ownLogout) {
      signedOutNotice.show();
    }
    await this.logout();
  }
  private _loggedOutInOtherTabAt = 0;

  private logoutPromise: Promise<void> | undefined;
  public async logout() {
    if (!this.logoutPromise) {
      this.logoutPromise = new Promise<void>(async (resolve, reject) => {
        this.state = "loggingout";
        stepUpManager.clear();
        securityStepState.set(false);
        const userId = this.currentUser?.userId ?? null;
        try {
          // not in the middle of another tab's login or snapshot refresh
          await withLoginLock(() => userApi.logout());
          webSocketManager.logout()
          await this._clear();
          if (!!this.currentUser) {
            await deleteDeviceKeyPair(this.currentUser.deviceId);
            this.setCurrentUser(null);
          }
          this.state = 'anonymous';
          // after the server call returned: every other tab drops its login too
          broadcastLoggedOut(userId);
        } catch (e) {
          console.log("Error in logout", e);
        }
        resolve();
        delete this.logoutPromise;
      });
    }
    return this.logoutPromise;
  }

  /**
   * Another tab logged out (or logged in as someone else): drop this tab's
   * login without a second `User/logout` — the socket leaves its user rooms
   * and stays connected as anonymous, the in-memory state goes. The shared
   * IndexedDB data, the device key and CG_CURRENT_USER were cleared by the
   * tab that logged out.
   */
  private async dropLoginOfOtherTab(): Promise<void> {
    if (this.logoutPromise) {
      return this.logoutPromise;
    }
    if (!this._currentUser && (this.state === "anonymous" || this.state === "pending")) {
      return;
    }
    this.logoutPromise = (async () => {
      this._loggedOutInOtherTabAt = Date.now();
      this.state = "loggingout";
      stepUpManager.clear();
      this._currentUser = null;
      securityStepState.setUser(null);
      webSocketManager.logout();
      channelDatabaseManager.userId = undefined;
      clearChat();
      notificationDatabase.unreadCount = 0;
      this.state = "anonymous";
    })().finally(() => {
      delete this.logoutPromise;
    });
    return this.logoutPromise;
  }

  /**
   * Another tab logged in as `userId` and the session cookie (shared by all
   * tabs) belongs to that user now: take it over without an HTTP login. The
   * shared IndexedDB data was written by that tab; only this tab's own state
   * is set up. Falls back to this tab's own device login if the session does
   * not match.
   */
  private async adoptLoginOfOtherTab(userId: string): Promise<void> {
    const stored = this.readStoredUser();
    if (!stored || stored.userId !== userId) {
      // CG_CURRENT_USER is written right after the login response; its
      // storage event follows
      return;
    }
    let sessionUserId: string | null = null;
    try {
      sessionUserId = (await userApi.checkLoginStatus()).userId;
    } catch (e) {
      console.error("Error in checkLoginStatus", e);
    }
    if (this._loginRunning || this.logoutPromise || this._currentUser?.userId === userId) {
      // this tab started a login or logout meanwhile, or adopted already
      return;
    }
    if (sessionUserId !== userId) {
      this._currentUser = stored;
      securityStepState.setUser(userId);
      await this.autoLogin();
      return;
    }
    await this.takeOverSession(stored);
  }

  /**
   * The session cookie already belongs to `stored` (another tab of this
   * browser logged in): set up this tab's own state without an HTTP login.
   * The shared IndexedDB data was written by that tab.
   */
  private async takeOverSession(stored: CurrentUser): Promise<void> {
    const { userId } = stored;
    this._currentUser = stored;
    securityStepState.setUser(userId);
    stepUpManager.clear();
    channelDatabaseManager.userId = userId;
    if (!securityStepState.required) {
      webSocketManager.login(stored.deviceId).catch(e => debugLog("socket login", e));
    }
    try {
      const [ownData, unreadCount] = await Promise.all([
        uniqueDb.uniques.get("OwnData") as Promise<Unique.OwnData | undefined>,
        notificationsApi.getUnreadCount(undefined),
      ]);
      setupChatAfterLogin(Number(unreadCount));
      if (!!ownData) {
        await notificationDatabase.setupAfterLogin(Number(unreadCount), ownData.data);
      }
    } catch (e) {
      console.error("Error setting up notifications after a login in another tab", e);
    }
    if (this._currentUser?.userId === userId) {
      this.state = "loggedin";
    }
  }

  /**
   * One HTTP device login: secret, signature, `User/login`. Call it only
   * while holding the login lock: the server keeps one signable secret per
   * session, so the secret of a concurrent login in another tab would
   * replace this one. `requestStartedAt` is taken right before the login
   * request (the snapshot is not older).
   */
  private async deviceLoginRequest(
    deviceId: string,
    signal: AbortSignal,
  ): Promise<{ response: API.User.login.Response; requestStartedAt: number } | typeof LOCK_LOST> {
    for (let attempt = 0; ; attempt++) {
      const [keyPairObj, signableSecret] = await Promise.all([
        getDeviceKeyPair(deviceId),
        userApi.getSignableSecret()
      ]);
      // the lock is gone (hold cap): no next step outside it
      if (signal.aborted) return LOCK_LOST;
      const encoder = new TextEncoder();
      const signature_arrayBuffer = await crypto.subtle.sign(
        {
          name: "ECDSA",
          hash: "SHA-384"
        },
        keyPairObj.keyPair.privateKey as any,
        encoder.encode(signableSecret)
      );
      const uint8arr = new Uint8Array(signature_arrayBuffer);
      const base64Signature = btoa(String.fromCharCode(...Array.from(uint8arr)));
      if (signal.aborted) return LOCK_LOST;
      const requestStartedAt = Date.now();
      try {
        const response = await userApi.login({
          type: "device",
          deviceId,
          base64Signature,
          secret: signableSecret
        });
        return { response, requestStartedAt };
      } catch (e) {
        // a late secret request of another tab (one that lost the lock, or a
        // page without the lock) replaced ours: once more with a fresh one
        if (attempt === 0 && e instanceof Error && e.message === errors.server.INVALID_SECRET && !signal.aborted) {
          continue;
        }
        throw e;
      }
    }
  }

  /**
   * After a failed page device login (not NOT_FOUND): the tab is anonymous
   * but still knows its stored device — try again with a backoff.
   */
  private scheduleDeviceLoginRetry() {
    if (this._deviceLoginRetryTimer !== undefined) {
      return;
    }
    const base = DEVICE_LOGIN_RETRY_MS[Math.min(this._deviceLoginRetryCount, DEVICE_LOGIN_RETRY_MS.length - 1)];
    this._deviceLoginRetryCount++;
    this._deviceLoginRetryTimer = setTimeout(() => {
      this._deviceLoginRetryTimer = undefined;
      this.retryDeviceLoginIfNeeded();
    }, base * (0.5 + Math.random()));
  }

  private clearDeviceLoginRetry() {
    if (this._deviceLoginRetryTimer !== undefined) {
      clearTimeout(this._deviceLoginRetryTimer);
      this._deviceLoginRetryTimer = undefined;
    }
  }

  /** a failed device login left this tab anonymous with its stored device: retry */
  private needsDeviceLoginRetry(): boolean {
    return (
      this.state === "anonymous" && !!this._currentUser && !this._loginRunning && !this.logoutPromise &&
      this.readStoredUser()?.deviceId === this._currentUser.deviceId
    );
  }

  private retryDeviceLoginIfNeeded() {
    if (!this.needsDeviceLoginRetry() || (typeof navigator !== 'undefined' && navigator.onLine === false)) {
      return;
    }
    this.clearDeviceLoginRetry();
    this.autoLogin().catch(e => console.error("Error in device login retry", e));
  }

  private readStoredUser(): CurrentUser | null {
    try {
      return JSON.parse(localStorage.getItem(CURRENT_USER_KEY) || 'null');
    } catch {
      return null;
    }
  }

  private async onAuthBroadcast(message: AuthBroadcastMessage) {
    if (message.type === "logged-out") {
      if (!message.userId || !this._currentUser || this._currentUser.userId === message.userId) {
        await this.dropLoginOfOtherTab();
      }
      return;
    }
    await this.followLogin(message.userId);
  }

  /** Brings this tab in line with CG_CURRENT_USER (idempotent). */
  private async followStoredUser() {
    const stored = this.readStoredUser();
    if (!stored) {
      if (!!this._currentUser && !this._loginRunning) {
        await this.dropLoginOfOtherTab();
      }
      return;
    }
    await this.followLogin(stored.userId);
  }

  private async followLogin(userId: string) {
    if (this._loginRunning || this.logoutPromise) {
      // this tab's own login or logout decides; it broadcasts its result
      return;
    }
    if (this._currentUser?.userId === userId) {
      return;
    }
    if (!!this._currentUser) {
      // logged in as another user here: that login is gone (session switched)
      await this.dropLoginOfOtherTab();
    }
    await this.adoptLoginOfOtherTab(userId);
  }

  /**
   * Catch-up of the entity data once the socket is live again after a gap
   * (connectionManager on `onLive('restored')`, visible tabs, debounced):
   * events of the gap are lost, so the tab re-runs the device `User/login`
   * for its snapshot (own communities, chats, own data, unread count) — one
   * request, under the login lock, without a state change. A device login of
   * the same user keeps the session; a session of another user is not
   * touched (the tab follows the stored user instead). The snapshot merges
   * of the entity databases do not regress newer local rows.
   */
  public async refreshAfterReconnect(): Promise<void> {
    if (
      this.state !== "loggedin" || !this.currentUser || this._windowReloadTriggered ||
      this._loginRunning || this.logoutPromise
    ) {
      return;
    }
    const { userId, deviceId } = this.currentUser;
    let result: { response: API.User.login.Response; requestStartedAt: number } | 'other-user' | undefined;
    try {
      result = await withLoginLock(async ({ signal }) => {
        if (this.readStoredUser()?.deviceId !== deviceId) {
          return 'other-user' as const;
        }
        const status = await userApi.checkLoginStatus().catch(() => null);
        if (!!status && status.userId !== null && status.userId !== userId) {
          return 'other-user' as const;
        }
        if (this.state !== "loggedin" || this.currentUser?.userId !== userId) {
          return undefined;
        }
        const request = await this.deviceLoginRequest(deviceId, signal);
        // lost the lock before the request: the next restored refreshes
        return request === LOCK_LOST ? undefined : request;
      });
    } catch (e) {
      if (e instanceof Error && e.message === errors.server.NOT_FOUND) {
        await this.signedOutElsewhere();
        return;
      }
      console.error("Error refreshing data after reconnect", e);
      return;
    }
    if (result === 'other-user') {
      await this.followStoredUser();
      return;
    }
    if (!result || this.state !== "loggedin" || this.currentUser?.userId !== userId) {
      return;
    }
    const { response, requestStartedAt } = result;
    if (typeof response.stepUpValidUntil === 'number') {
      stepUpManager.markAuthenticated(response.stepUpValidUntil);
    }
    securityStepState.set(response.securityStepRequired === true);
    await this.setupAfterLogin(response, requestStartedAt);
  }

  /**
   * Signs in with a transfer link (docs/auth-identity §11). Never into an
   * existing login: the caller signs out first, after asking. The session
   * then counts as authenticated by the link, which is not a recent
   * authentication for sensitive actions.
   */
  public async redeemTransferLink(token: string): Promise<API.User.redeemTransferLink.Response> {
    if (this.currentUser) {
      throw new Error(errors.server.ALREADY_LOGGED_IN);
    }
    this.state = "loggingin";
    try {
      const keyPair = await generateNewKeyPair();
      const publicKey = await window.crypto.subtle.exportKey("jwk", keyPair.publicKey as any);
      publicKey.key_ops = ["verify"];
      const responseData = await withLoginLock(() => userApi.redeemTransferLink({ token, device: { publicKey } }));
      await saveDeviceKeyPair(responseData.ownData.id, responseData.deviceId, keyPair);
      this.setCurrentUser({
        userId: responseData.ownData.id,
        deviceId: responseData.deviceId,
      });
      stepUpManager.clear();
      securityStepState.set(responseData.securityStepRequired === true);
      await this.setupAfterLogin(responseData);
      this.state = "loggedin";
      broadcastLoggedIn(responseData.ownData.id);
      return responseData;
    }
    catch (e) {
      if (!this.currentUser) {
        this.state = "anonymous";
      }
      throw e;
    }
  }

  /** legacy CG ID (gateway) instances only: the server refuses cg_evm elsewhere */
  public async prepareMnemonicLogin(mnemonic: string): Promise<API.User.prepareWalletAction.Response> {
    mnemonic = mnemonic.toLowerCase().trim().replace(/  +/, ' ');
    // Was ethers 5's `Wallet.fromMnemonic`; viem's account derivation produces
    // the same address and the same EIP-191 (`personal_sign`) signature, which
    // is what the backend verifies.
    const [ { mnemonicToAccount }, secret ] = await Promise.all([
      import("viem/accounts"),
      userApi.getSignableSecret()
    ]);

    const wallet = mnemonicToAccount(mnemonic);
    const siweMessage = getSiweMessage({
      address: wallet.address.toLowerCase() as Common.Address,
      chainId: 1,
      secret,
    });
    const signature = await wallet.signMessage({ message: siweMessage });
    console.log(`Deprecated mnemonic login with wallet address: ${wallet.address.toLowerCase()}`);
    const data: API.User.SignableWalletData = {
      address: wallet.address.toLowerCase() as Common.Address,
      siweMessage,
      secret,
      type: "evm"
    };
    return userApi.prepareWalletAction({ type: 'cg_evm', data, signature });
  }

  // Private

  /**
   * `mayTakeOver` (the page's device login): if another tab held the login
   * lock first and the session belongs to the stored user afterwards, that
   * tab has just logged in — take its session over (`'taken-over'`) instead
   * of a second login.
   */
  private _login(options: LoginOptions): Promise<API.User.login.Response>;
  private _login(options: LoginOptions, mayTakeOver: true): Promise<API.User.login.Response | 'taken-over'>;
  private async _login(options: LoginOptions, mayTakeOver = false): Promise<API.User.login.Response | 'taken-over'> {
    if (!this._loginRunning || !this._loginInProgress) {
      this._loginRunning = true;
      this._loginInProgress = new Promise<API.User.login.Response | 'taken-over'>(async (resolve, reject) => {
        try {
          this.state = "loggingin";
          let responseData: API.User.login.Response | undefined;
          let requestStartedAt: number | undefined;
          if ('deviceId' in options) {
            const { deviceId } = options;
            // secret, signature and login under one lock: the server keeps
            // one signable secret per session (shared by all tabs)
            type Outcome =
              { kind: 'superseded' } | { kind: 'take-over'; stored: CurrentUser } | { kind: 'cancelled' } |
              { kind: 'lock-lost' } | { kind: 'response'; response: API.User.login.Response; requestStartedAt: number };
            let outcome: Outcome = { kind: 'lock-lost' };
            // a holder that lost the lock before its request queues once more
            for (let round = 0; round < 2 && outcome.kind === 'lock-lost'; round++) {
              outcome = await withLoginLock(async ({ waited, signal }): Promise<Outcome> => {
                const stored = this.readStoredUser();
                if (!stored || stored.deviceId !== deviceId) {
                  // another tab logged out or in as someone else meanwhile
                  return { kind: 'superseded' };
                }
                if ((waited || round > 0) && mayTakeOver) {
                  const status = await userApi.checkLoginStatus().catch(() => null);
                  if (status?.userId === stored.userId) {
                    return { kind: 'take-over', stored };
                  }
                }
                if (this.state !== 'loggingin') {
                  return { kind: 'cancelled' };
                }
                const result = await this.deviceLoginRequest(deviceId, signal);
                return result === LOCK_LOST ? { kind: 'lock-lost' } : { kind: 'response', ...result };
              });
            }
            if (outcome.kind === 'lock-lost') {
              throw new Error("LOGIN_LOCK_LOST");
            }
            if (outcome.kind === 'take-over') {
              await this.takeOverSession(outcome.stored);
              this._deviceLoginRetryCount = 0;
              resolve('taken-over');
              return;
            }
            if (outcome.kind === 'superseded') {
              // this tab's device is not the stored one any more
              this._currentUser = null;
              // either way this account's in-memory chat data goes
              channelDatabaseManager.userId = undefined;
              clearChat();
              if (!this.readStoredUser()) {
                // another tab logged out
                securityStepState.setUser(null);
                webSocketManager.logout();
                this.state = "anonymous";
              }
              // else another tab logged in: autoLogin follows the stored user
              // once this login is over
              resolve('taken-over');
              return;
            }
            if (outcome.kind === 'response') {
              responseData = outcome.response;
              requestStartedAt = outcome.requestStartedAt;
            }
          } else {
            const keyPair = await generateNewKeyPair();
            const publicKey = await window.crypto.subtle.exportKey(
              "jwk",
              keyPair.publicKey as any
            );
            publicKey.key_ops = ["verify"];
            let loginRequest: API.User.login.Request;
            if ("account" in options && options.account === "twitter") {
              loginRequest = {
                type: 'twitter',
                device: { publicKey },
              };
            } else if ("account" in options && options.account === "lukso") {
              loginRequest = {
                type: 'lukso',
                device: { publicKey },
              };
            } else if ("account" in options && options.account === "passkey") {
              loginRequest = {
                type: 'passkey',
                authenticationResponse: options.authenticationResponse,
                device: { publicKey },
              };
            } else if ("account" in options && options.account === "passkey-legacy") {
              loginRequest = {
                type: 'passkey-success',
                device: { publicKey },
              };
            } else if ("account" in options && options.account === 'wallet') {
              loginRequest = {
                type: "wallet",
                device: { publicKey },
              };
            } else if ("account" in options && options.account === 'farcaster') {
              loginRequest = {
                type: "farcaster",
                device: { publicKey },
              };
            } else if ("email" in options && "code" in options) {
              loginRequest = {
                type: "verificationCode",
                device: { publicKey },
                email: options.email,
                code: options.code,
              };
            } else if ("aliasOrEmail" in options) {
              loginRequest = {
                aliasOrEmail: options.aliasOrEmail,
                password: options.password,
                type: "password",
                device: { publicKey },
              };
            } else {
              throw new Error(errors.server.INVALID_REQUEST);
            }
            if (this.state === 'loggingin') {
              const request = loginRequest;
              requestStartedAt = Date.now();
              responseData = await withLoginLock(() => userApi.login(request));
              await saveDeviceKeyPair(responseData.ownData.id, responseData.deviceId, keyPair);
            }
          }
    
          if (!!responseData) {
            if (this.state === 'loggingin') {
              this.setCurrentUser({
                userId: responseData.ownData.id,
                deviceId: responseData.deviceId
              });
              if (!("deviceId" in options)) {
                // an interactive login counts as a recent authentication for
                // sensitive actions; a device-key re-login does not
                stepUpManager.markAuthenticated();
              }
              else if (typeof responseData.stepUpValidUntil === 'number') {
                // a silent re-login keeps the session's earlier sign-in
                // (e.g. right after a reload): still fresh until then
                stepUpManager.markAuthenticated(responseData.stepUpValidUntil);
              }
              else {
                stepUpManager.clear();
              }
              securityStepState.set(responseData.securityStepRequired === true);
              await this.setupAfterLogin(responseData, requestStartedAt);
              this.state = "loggedin";
              this._deviceLoginRetryCount = 0;
              this.clearDeviceLoginRetry();
              broadcastLoggedIn(responseData.ownData.id);
              resolve(responseData);
            }
            else {
              reject("Login cancelled by user");
            }
          }
          else {
            reject("Login cancelled by user");
          }
    
        } catch (e) {
          if (
            e instanceof Error &&
            e.message === errors.server.NOT_FOUND &&
            "deviceId" in options
          ) {
            // device has been deleted from the server: signed out from
            // elsewhere
            this.signedOutElsewhere().catch((e) => {
              console.log(e);
            });
          } else {
            this.state = "anonymous";
          }
          reject(e);

        } finally {
          this._loginRunning = false;
          setTimeout(() => {
            this._loginInProgress = undefined;
          }, 0);
        }
      });
    }
    return this._loginInProgress as Promise<API.User.login.Response>;
  }

  /** `requestStartedAt`: when the request of this snapshot started (entity-db snapshot merges) */
  private async setupAfterLogin(data: API.User.login.Response, requestStartedAt?: number) {
    const serviceWorkerManager = (await import("./serviceWorker")).default;
    if (this._windowReloadTriggered === false) {
      channelDatabaseManager.userId = data.ownData.id;
      setupChatAfterLogin(data.unreadNotificationCount);
      // an account in the security step gets no realtime connection and no
      // push subscription until it finished the step (the page reloads then)
      const restricted = data.securityStepRequired === true;
      const promise = Promise.allSettled([
        userDatabase.setupAfterLogin(data.ownData).catch(async (e) => {
          await userDatabase.clear();
          return userDatabase.setupAfterLogin(data.ownData);
        }),
        communityDatabase.setupAfterLogin(data.communities, { requestStartedAt }).catch(async (e) => {
          await communityDatabase.clear();
          return communityDatabase.setupAfterLogin(data.communities, { requestStartedAt });
        }),
        chatDatabase.setupAfterLogin(data.chats, { requestStartedAt }).catch(async (e) => {
          await chatDatabase.clear();
          return chatDatabase.setupAfterLogin(data.chats, { requestStartedAt });
        }),
        // not awaited: `loggedin` does not wait for the socket login (the
        // transport reports `live` itself)
        restricted ? Promise.resolve() : (webSocketManager.login(data.deviceId).catch(e => debugLog("socket login", e)), Promise.resolve()),
        restricted ? Promise.resolve() : serviceWorkerManager.setupAfterLogin(data.webPushSubscription),
        notificationDatabase.setupAfterLogin(data.unreadNotificationCount, data.ownData).catch(async (e) => {
          await notificationDatabase.clear();
          return notificationDatabase.setupAfterLogin(data.unreadNotificationCount, data.ownData);
        }),
      ]);
      this._waitBeforeWindowReload = promise;
      try {
        await promise;
      } finally {
        delete this._waitBeforeWindowReload;
      }
    }
  }

  private async _clear() {
    if (this._windowReloadTriggered === false) {
      channelDatabaseManager.userId = undefined;
      const promise = Promise.allSettled([
        userDatabase.clear(),
        communityDatabase.clear(),
        chatDatabase.clear(),
        channelDatabaseManager.clear(),
        notificationDatabase.clear(),
      ]);
      this._waitBeforeWindowReload = promise;
      try {
        await promise;
        console.log("Clear for logout results", promise);
      } finally {
        delete this._waitBeforeWindowReload;
      }
    }
  }
}

const loginManager = new LoginManager();
export default loginManager;