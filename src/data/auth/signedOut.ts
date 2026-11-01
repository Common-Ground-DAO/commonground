// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * This device was signed out from elsewhere (docs/auth-identity §2, "Signing
 * out other devices"): another device used "Sign out other devices", or the
 * account's password, email or sign-in methods changed there. The server
 * says so with `cliSignedOut`, or the device's key is gone at the next
 * automatic login. LoginManager signs out locally and raises this notice;
 * `SignedOutNotice` shows it until it is dismissed.
 * Kept free of React so the data layer can import it.
 */

type Listener = (shown: boolean) => void;

class SignedOutNotice {
  private _shown = false;
  private listeners = new Set<Listener>();

  public get shown() {
    return this._shown;
  }

  public show() {
    this.update(true);
  }

  public dismiss() {
    this.update(false);
  }

  private update(shown: boolean) {
    if (this._shown !== shown) {
      this._shown = shown;
      for (const listener of this.listeners) {
        listener(shown);
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

const signedOutNotice = new SignedOutNotice();
export default signedOutNotice;

/**
 * "Signed out 3 other devices." — or null when there was none. `delayed`:
 * the server could not end their sessions right away (they end within a
 * minute).
 */
export function signedOutDevicesText(count: number, delayed = false): string | null {
  if (delayed) {
    return 'Other devices will be signed out within a minute.';
  }
  if (count <= 0) {
    return null;
  }
  return count === 1 ? 'Signed out 1 other device.' : `Signed out ${count} other devices.`;
}
