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
import messageDatabase from "data/databases/messages";
import channelDatabaseManager from "data/databases/channel";
import { UserProfileTypeEnum } from "common/enums";
import getSiweMessage from "util/siwe";
import uniqueDb from "data/databases/unique";
import stepUpManager from "data/auth/stepUp";
import securityStepState from "data/auth/securityStep";
import signedOutNotice from "data/auth/signedOut";
import { getAuthMode } from "data/auth/authMode";
import { type AuthenticationResponseJSON } from "@simplewebauthn/browser";

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
  private _loginInProgress?: Promise<API.User.login.Response>;
  private _currentUser: CurrentUser | null = JSON.parse(localStorage.getItem(CURRENT_USER_KEY) || 'null');
  private _windowReloadTriggered = false;
  private _waitBeforeWindowReload?: Promise<any>;
  private loginStateBroadcast = new BroadcastChannel('CG_LOGIN_STATE');
  private __loginEventPromise: {
    promise: Promise<void>;
    resolve: () => void;
    reject: (e: any) => void;
  } | undefined;

  constructor() {
    const storageListener = (event: StorageEvent) => {
      if (event.key === CURRENT_USER_KEY) {
        const previousUserId = this._currentUser?.userId;
        this._currentUser = JSON.parse(event.newValue || 'null');
        securityStepState.setUser(this._currentUser?.userId ?? null);
        if (this._currentUser?.userId !== previousUserId) {
          // logged out (or switched account) in another tab
          stepUpManager.clear();
        }
        if (!!this._currentUser) {
          webSocketManager.login(this._currentUser.deviceId);
        }
      }
    };
    window.addEventListener("storage", storageListener);
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
      webSocketManager.login(this._currentUser.deviceId);
      channelDatabaseManager.userId = this._currentUser.userId;
    }

    this.loginStateBroadcast.onmessage = async (event: MessageEvent<Common.LoginState | 'LOGIN_REQUIRED' | 'LOGIN_FINISHED' | 'LOGIN_ERROR'>) => {
      console.log(`Received new login state: ${event.data}`);
      if (event.data === 'LOGIN_REQUIRED') {
        if (webSocketManager.tabState === 'active' || webSocketManager.tabState === 'active-throttled') {
          debugLog("LoginManager: Received LOGIN_REQUIRED from other tab, handling...");
          try {
            await this.loginRequiredErrorHandler();
            this.loginStateBroadcast.postMessage('LOGIN_FINISHED');
            debugLog("LoginManager: LOGIN_FINISHED");
          }
          catch (e) {
            this.loginStateBroadcast.postMessage('LOGIN_ERROR');
            debugLog("LoginManager: LOGIN_ERROR");
          }
        }
      }
      else if (event.data === 'LOGIN_FINISHED') {
        if (this.__loginEventPromise) {
          debugLog("LoginManager: Received LOGIN_FINISHED from other tab");
          this.__loginEventPromise.resolve();
        }
      }
      else if (event.data === 'LOGIN_ERROR') {
        if (this.__loginEventPromise) {
          debugLog("LoginManager: Received LOGIN_ERROR from other tab");
          this.__loginEventPromise.reject('LOGIN_ERROR');
        }
      }
      else {
        if (event.data === 'loggingout' || event.data === 'anonymous') {
          // another tab logged out
          stepUpManager.clear();
          this._loggedOutInOtherTabAt = Date.now();
        }
        this.state = event.data;
      }
    };
  }

  public get state() {
    return this._state;
  }
  public set state(state: Common.LoginState) {
    const oldState = this._state;
    if (oldState !== state) {
      this._state = state;
      if (webSocketManager.tabState === 'active' || webSocketManager.tabState === 'active-throttled') {
        this.loginStateBroadcast.postMessage(state);
      }
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
            webSocketManager.login(this.currentUser.deviceId);
            this.state = "loggedin";
            this.loginStateBroadcast.postMessage('LOGIN_ERROR');
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
            result = await this._login({ deviceId: this.currentUser.deviceId });
          } catch (e) {
            if (e instanceof Error) {
              if (e.message === errors.server.NOT_FOUND) {
                // the device key is gone: this device was signed out from
                // elsewhere (the sign-out on this device clears it locally)
                await this.signedOutElsewhere();
                return;
              }
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

  public async checkLoginStatus(forceAutoLogin = false) {
    if (
      this.state === "loggedin" &&
      (
        webSocketManager.tabState === 'active' ||
        webSocketManager.tabState === 'active-throttled'
      )
    ) {
      try {
        const { userId } = await userApi.checkLoginStatus();
        if (userId === null || forceAutoLogin) {
          this.autoLogin();
        }
        else if (userId !== this.currentUser?.userId) {
          console.error(`Error! User ID returned by server (${userId}) does not match own userId (${this.currentUser?.userId})`);
          await this.logout();
        }
      } catch (e) {
        console.error("Error in checkLoginStatus", e);
        // Todo: Check for network error, or whatever else is the reason?
      }
    }
  }

  /** interactive login (or a device-key re-login with `deviceId`) */
  public async login(options: LoginOptions) {
    return this._login(options);
  }

  private __loginRequiredLoginPromise: Promise<void> | undefined;
  public async loginRequiredErrorHandler(): Promise<void> {
    if (!this.__loginRequiredLoginPromise) {
      this.__loginRequiredLoginPromise = new Promise(async (resolve, reject) => {
        const connectionManager = (await import("./connection")).default;
        try {
          // when this tab is passive, wait for login from the active tab
          const tabIsPassiveHandler = async () => {
            debugLog("LoginRequiredErrorHandler: tabState is passive or passive-throttled, waiting for active tab to handle login");
            if (!this.__loginEventPromise) {
              debugLog("LoginRequiredErrorHandler: setting up promise to wait for login");
              this.__loginEventPromise = {} as any;
              const promise = new Promise<void>((res, rej) => {
                const resolve = () => {
                  delete this.__loginEventPromise;
                  res();
                };
                const reject = (e: any) => {
                  delete this.__loginEventPromise;
                  rej(e);
                };
                this.__loginEventPromise!.resolve = resolve;
                this.__loginEventPromise!.reject = reject;
              });
              this.__loginEventPromise!.promise = promise;
            }
            await this.__loginEventPromise!.promise;
            this.loginStateBroadcast.postMessage('LOGIN_REQUIRED');
          }
      
          if (!!this.currentUser) {
            // if this is the active tab, login again
            if (connectionManager.tabState === 'active' || connectionManager.tabState === 'active-throttled') {
              debugLog("LoginRequiredErrorHandler: tabState is active or active-throttled, trying login");
              await this.autoLogin();
            }
            // if tabState is unknown, wait for tabState update before login
            else if (connectionManager.tabState === 'unknown') {
              debugLog("LoginRequiredErrorHandler: tabState is unknown, waiting for state change...");
              const promise = new Promise<void>((resolve, reject) => {
                const listener = async (tabState: Common.TabState) => {
                  connectionManager.removeListener("tabStateChange", listener);
                  if (tabState === 'active' || tabState === 'active-throttled') {
                    try {
                      debugLog("LoginRequiredErrorHandler: tabState is active or active-throttled, trying login");
                      await this.autoLogin();
                      resolve();
                    }
                    catch (e) {
                      debugLog("LoginRequiredErrorHandler: error logging in", e);
                      reject(e);
                    }
                  }
                  else {
                    await tabIsPassiveHandler();
                    resolve();
                  }
                };
                connectionManager.addListener("tabStateChange", listener);
              });
              await Promise.race([
                promise,
                new Promise((_, reject) => setTimeout(reject, 5000)), // fallback, because worst case, tab state detection + login can take a while
              ]);
            }
            // tab is passive
            else {
              await tabIsPassiveHandler();
            }
          } else if (this.state === "anonymous") {
            console.log("Todo: Show login window now?");
          } else if (this.state === "loggingin") {
            console.log("The last request requested a LOGIN_REQUIRED resource before login completion");
          } else if (this.state === "loggingout") {
            console.log("The last request requested a LOGIN_REQUIRED resource after logout completion");
          }
          delete this.__loginRequiredLoginPromise;
          resolve();
        }
        catch (e) {
          delete this.__loginRequiredLoginPromise;
          reject(e);
        }
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
    const responseData = await userApi.createUser(requestData);
    stepUpManager.markAuthenticated();
    await saveDeviceKeyPair(responseData.ownData.id, responseData.deviceId, keyPair);
    this.setCurrentUser({
      userId: responseData.ownData.id,
      deviceId: responseData.deviceId,
    });
    securityStepState.set(responseData.securityStepRequired === true);
    await this.setupAfterLogin(responseData);
    this.state = "loggedin";
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
    const stored = JSON.parse(localStorage.getItem(CURRENT_USER_KEY) || 'null') as CurrentUser | null;
    const ownLogout = stored?.userId !== this.currentUser.userId || Date.now() - this._loggedOutInOtherTabAt < 30_000;
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
        try {
          await userApi.logout();
          webSocketManager.logout()
          await this._clear();
          if (!!this.currentUser) {
            await deleteDeviceKeyPair(this.currentUser.deviceId);
            this.setCurrentUser(null);
          }
          this.state = 'anonymous';
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
      const responseData = await userApi.redeemTransferLink({ token, device: { publicKey } });
      await saveDeviceKeyPair(responseData.ownData.id, responseData.deviceId, keyPair);
      this.setCurrentUser({
        userId: responseData.ownData.id,
        deviceId: responseData.deviceId,
      });
      stepUpManager.clear();
      securityStepState.set(responseData.securityStepRequired === true);
      await this.setupAfterLogin(responseData);
      this.state = "loggedin";
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

  private async _login(options: LoginOptions): Promise<API.User.login.Response> {
    if (!this._loginInProgress) {
      this._loginInProgress = new Promise<API.User.login.Response>(async (resolve, reject) => {
        try {
          this.state = "loggingin";
          let responseData: API.User.login.Response | undefined;
          if ('deviceId' in options) {
            const { deviceId } = options;
            const [keyPairObj, signableSecret] = await Promise.all([
              getDeviceKeyPair(deviceId),
              userApi.getSignableSecret()
            ]);
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
            if (this.state === 'loggingin') {
              responseData = await userApi.login({ 
                type: "device",
                deviceId,
                base64Signature,
                secret: signableSecret
              });
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
              responseData = await userApi.login(loginRequest);
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
              await this.setupAfterLogin(responseData);
              this.state = "loggedin";
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
          setTimeout(() => {
            this._loginInProgress = undefined;
          }, 0);
        }
      });
    }
    return this._loginInProgress;
  }

  private async setupAfterLogin(data: API.User.login.Response) {
    const serviceWorkerManager = (await import("./serviceWorker")).default;
    if (this._windowReloadTriggered === false) {
      channelDatabaseManager.userId = data.ownData.id;
      // an account in the security step gets no realtime connection and no
      // push subscription until it finished the step (the page reloads then)
      const restricted = data.securityStepRequired === true;
      const promise = Promise.allSettled([
        userDatabase.setupAfterLogin(data.ownData).catch(async (e) => {
          await userDatabase.clear();
          return userDatabase.setupAfterLogin(data.ownData);
        }),
        communityDatabase.setupAfterLogin(data.communities).catch(async (e) => {
          await communityDatabase.clear();
          return communityDatabase.setupAfterLogin(data.communities);
        }),
        chatDatabase.setupAfterLogin(data.chats).catch(async (e) => {
          await chatDatabase.clear();
          return chatDatabase.setupAfterLogin(data.chats);
        }),
        restricted ? Promise.resolve() : webSocketManager.login(data.deviceId),
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