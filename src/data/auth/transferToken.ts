// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Transfer links (`/transfer#<token>`, docs/auth-identity §11): the token
 * travels in the URL fragment, which the browser never sends to a server.
 * `captureTransferToken` runs first thing in the app's entry module: it
 * takes the token out of the address bar (history.replaceState) before
 * anything else loads, and keeps it in memory only — a reload drops it, and
 * the user opens the link again.
 */

export const TRANSFER_PATH = '/transfer';
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

let capturedToken: string | null = null;

export function captureTransferToken(location: Pick<Location, 'pathname' | 'hash' | 'search'> = window.location, history: Pick<History, 'replaceState' | 'state'> = window.history): void {
  const pathname = location.pathname.replace(/\/+$/, '') || '/';
  if (pathname !== TRANSFER_PATH || !location.hash) {
    return;
  }
  const value = location.hash.slice(1);
  capturedToken = TOKEN_PATTERN.test(value) ? value : null;
  // never leave the token in the address bar or the history
  history.replaceState(history.state, '', `${TRANSFER_PATH}${location.search}`);
}

/** The captured token (null: none, or malformed). */
export function getTransferToken(): string | null {
  return capturedToken;
}

/** after the link was used or abandoned */
export function forgetTransferToken(): void {
  capturedToken = null;
}
