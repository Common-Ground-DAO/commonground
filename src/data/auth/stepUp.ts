// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Step-up (re-authentication) coordination for sensitive actions
 * (docs/auth-identity §8).
 *
 * The server answers a protected request with REAUTH_REQUIRED when the
 * session's last authentication is older than its window. `BaseApiConnector`
 * then calls `stepUpManager.request(...)`, which opens the ReauthDialog
 * (registered by StepUpProvider) and resolves `true` once the user confirmed
 * with a passkey, the password or a wallet — the connector retries the
 * request once. Screens that run a WebAuthn ceremony afterwards (adding a
 * passkey) ask `isFresh()` first, because a ceremony must start from a click.
 *
 * Kept free of React so the API layer can import it.
 */

/** Mirrors the server's STEP_UP_MAX_AGE_MS (srv/util/authSession.ts). */
export const STEP_UP_WINDOW_MS = 5 * 60 * 1000;
/** Treat the window as closed a little early: clocks and latency differ. */
const FRESHNESS_MARGIN_MS = 20 * 1000;
/**
 * A REAUTH_REQUIRED that arrives this soon after a confirmation in the dialog
 * (e.g. a second request that was already in flight) is retried without
 * asking again.
 */
const RECENT_CONFIRMATION_MS = 60 * 1000;

export type StepUpRequest = {
  /** completes "Confirm it's you to …" */
  action: string;
  /**
   * false while a wallet action is in flight: a wallet re-authentication
   * would replace the session's prepared wallet the request depends on
   */
  allowWallet: boolean;
};

export type StepUpHandler = (request: StepUpRequest) => Promise<boolean>;

class StepUpManager {
  private handler: StepUpHandler | undefined;
  private validUntil = 0;
  private pending: Promise<boolean> | undefined;
  private lastConfirmedAt = 0;
  private _confirmations = 0;

  public setHandler(handler: StepUpHandler | undefined) {
    this.handler = handler;
  }

  public get hasHandler() {
    return !!this.handler;
  }

  /** after an interactive login, account creation or User/reauthenticate */
  public markAuthenticated(validUntil: number = Date.now() + STEP_UP_WINDOW_MS) {
    this.validUntil = validUntil;
  }

  public clear() {
    this.validUntil = 0;
    this.lastConfirmedAt = 0;
  }

  /**
   * Counts confirmations in the dialog. A caller that must not run a WebAuthn
   * ceremony after an (async) dialog compares it before and after a request.
   */
  public get confirmations() {
    return this._confirmations;
  }

  /** best guess whether the server still accepts the last authentication */
  public isFresh(now: number = Date.now()) {
    return now + FRESHNESS_MARGIN_MS < this.validUntil;
  }

  /**
   * Asks the user to confirm it's them. Resolves true after a successful
   * re-authentication, false when cancelled or when no UI is mounted.
   * Concurrent requests share one dialog.
   */
  public request(request: StepUpRequest, now: number = Date.now()): Promise<boolean> {
    const handler = this.handler;
    if (!handler) {
      return Promise.resolve(false);
    }
    if (!this.pending && now - this.lastConfirmedAt < RECENT_CONFIRMATION_MS && this.isFresh(now)) {
      // just confirmed in the dialog: don't ask a second time
      return Promise.resolve(true);
    }
    if (!this.pending) {
      this.pending = handler(request)
        .catch((e) => {
          console.error("Step-up dialog failed", e);
          return false;
        })
        .then((confirmed) => {
          if (confirmed) {
            this.lastConfirmedAt = Date.now();
            this._confirmations += 1;
          }
          return confirmed;
        })
        .finally(() => {
          this.pending = undefined;
        });
    }
    return this.pending;
  }
}

const stepUpManager = new StepUpManager();
export default stepUpManager;

/**
 * What a protected API route does, in words for the dialog. Keys are
 * `<Domain>/<route>` as the connectors call them.
 */
const ACTIONS: Record<string, string> = {
  "User/setPassword": "change your password",
  "User/updateOwnData": "change your email address",
  "User/addPreparedWallet": "add a wallet you can sign in with",
  "User/updateWallet": "change how a wallet signs in",
  "User/deleteWallet": "remove a wallet",
  "User/addUserAccount": "connect an account you can sign in with",
  "User/removeUserAccount": "disconnect an account",
  "Passkey/registrationOptions": "add a passkey",
  "Passkey/verifyRegistration": "add a passkey",
  "Passkey/remove": "remove a passkey",
  "Bot/tokens/issue": "issue a bot token",
  "Bot/disable": "disable a bot",
};

export function stepUpRequestForRoute(route: string): StepUpRequest {
  const key = route.replace(/^\/+/, "").replace(/\/{2,}/g, "/");
  return {
    action: ACTIONS[key] || "continue",
    allowWallet: key !== "User/addPreparedWallet",
  };
}
