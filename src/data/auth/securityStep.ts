// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Client side of the account-security step (docs/auth-identity §11).
 *
 * The server decides: login responses carry `securityStepRequired`, and any
 * other request of an account that still has to finish the step is answered
 * with SECURITY_STEP_REQUIRED (BaseApiConnector reports it here). While the
 * flag is set, the app shows only the security step (`SecurityStepView`).
 *
 * The flag is remembered per account in localStorage, so after a reload the
 * app knows it before the automatic device login (which only runs once the
 * socket is connected) has answered — the normal app never mounts first.
 * The login response then confirms or clears it.
 * Kept free of React so the data layer can import it.
 */

type Listener = (required: boolean) => void;

const STORAGE_KEY = 'CG_SECURITY_STEP';

function readStored(userId: string): boolean {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
    return !!stored && stored.userId === userId && stored.required === true;
  }
  catch {
    return false;
  }
}

function writeStored(userId: string | null, required: boolean) {
  try {
    if (userId && required) {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ userId, required: true }));
    }
    else {
      localStorage.removeItem(STORAGE_KEY);
    }
  }
  catch {
    // storage unavailable: the login response still sets the flag
  }
}

class SecurityStepState {
  private _required = false;
  private _userId: string | null = null;
  private listeners = new Set<Listener>();

  public get required() {
    return this._required;
  }

  /** the signed-in account (null: none) — loads what is remembered for it */
  public setUser(userId: string | null) {
    if (this._userId !== userId) {
      this._userId = userId;
      this.update(userId ? readStored(userId) : false);
    }
  }

  public set(required: boolean) {
    writeStored(this._userId, required);
    this.update(required);
  }

  private update(required: boolean) {
    if (this._required !== required) {
      this._required = required;
      for (const listener of this.listeners) {
        listener(required);
      }
    }
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}

const securityStepState = new SecurityStepState();
export default securityStepState;

/**
 * Whether the app shows the security step instead of its routes: whenever
 * the flag is set for a user who is (or is being) signed in — also while the
 * automatic re-login after a reload is still running, so the normal app
 * never mounts first.
 */
export function showSecurityStep(required: boolean, loginState: Common.LoginState): boolean {
  return required && loginState !== 'anonymous' && loginState !== 'loggingout';
}

export type SecurityStepTask = 'email' | 'new-password' | 'sign-in-method';

/** What to do next, in the order the screen asks for it. */
export function nextSecurityStepTask(status: API.User.getSecurityStatus.Response): SecurityStepTask | null {
  if (!status.required) {
    return null;
  }
  // the address first: the notice about a new sign-in method then reaches it
  if (status.needsVerifiedEmail) {
    return 'email';
  }
  if (status.needsNewPassword) {
    return 'new-password';
  }
  if (status.needsSignInMethod) {
    return 'sign-in-method';
  }
  return null;
}
