// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Value of the SOCKET_ID_HEADER for API requests (see Transport.getRequestSocketId
 * in ./transport.ts). A leaf module on purpose: baseConnector reads it on
 * every request, and importing webSocket.ts there would close an import cycle
 * (webSocket -> data/api/user -> baseConnector). webSocket.ts registers the
 * provider when it is created.
 */

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_-';

/** A random id in socket.io's id format (SOCKET_ID_PATTERN) that matches no socket. */
export function randomSocketId(): string {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  let id = '';
  for (const byte of bytes) {
    id += ALPHABET[byte & 63];
  }
  return id;
}

/** This tab's fallback id, used while no socket is connected. */
export const fallbackSocketId = randomSocketId();

let provider: (() => string) | undefined;

export function setRequestSocketIdProvider(fn: (() => string) | undefined): void {
  provider = fn;
}

/** Never empty: the connected socket's id, else this tab's fallback id. */
export function getRequestSocketId(): string {
  return provider?.() || fallbackSocketId;
}
