// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Cross-tab auth plumbing of the login manager (contract: ./transport.ts):
 * - the login lock LOGIN_LOCK_NAME that serialises HTTP logins across tabs,
 * - the AUTH_BROADCAST_CHANNEL notices "logged in" / "logged out",
 * - for one release, the plain `'anonymous'` on the legacy CG_LOGIN_STATE
 *   channel for still-open old pages.
 * The `storage` event on CG_CURRENT_USER stays the fallback; the login
 * manager listens for it itself.
 */

import { randomSocketId } from './requestSocketId';
import {
  AUTH_BROADCAST_CHANNEL,
  LEGACY_LOGIN_STATE_CHANNEL,
  LOGIN_LOCK_NAME,
  type AuthBroadcastMessage,
  type Unsubscribe,
} from './transport';

/**
 * How long a tab waits for the login lock before it logs in anyway. A frozen
 * tab keeps its Web Locks, so a login lock held by a tab that was frozen in
 * the middle of a login must not block every other tab for good.
 */
export const LOGIN_LOCK_WAIT_MS = 15_000;

/** Sender id of this tab's auth broadcasts (receivers ignore their own). */
export const authTabId = randomSocketId();

/**
 * How long a tab may hold the login lock (one login: secret, signature,
 * request). A slow request must not block the other tabs' logins: after this
 * the lock is released (before waiting tabs give up on it,
 * LOGIN_LOCK_WAIT_MS) and `info.signal` aborts, but the holder's own call
 * goes on and its result is returned — the holder only must not start a new
 * step outside the lock (check `signal.aborted` between steps).
 */
export const LOGIN_LOCK_HOLD_MAX_MS = 10_000;

export type LoginLockInfo = {
  /** another tab held the lock first (it may just have logged in) */
  waited: boolean;
  /** aborts when this tab no longer holds the lock (hold cap) */
  signal: AbortSignal;
};

/**
 * Runs `fn` in the lock callback and returns once `fn` settled or the hold
 * cap is reached, whichever comes first; `result` is `fn`'s own promise.
 */
function startHeld<T>(fn: (info: LoginLockInfo) => Promise<T>, waited: boolean): { held: Promise<void>; result: Promise<T> } {
  const controller = new AbortController();
  const result = Promise.resolve().then(() => fn({ waited, signal: controller.signal }));
  let timer: ReturnType<typeof setTimeout> | undefined;
  const cap = new Promise<void>(resolve => {
    timer = setTimeout(() => {
      controller.abort();
      resolve();
    }, LOGIN_LOCK_HOLD_MAX_MS);
  });
  const held = Promise.race([result.then(() => undefined, () => undefined), cap]).finally(() => clearTimeout(timer));
  return { held, result };
}

/**
 * Runs `fn` while holding the login lock (released at the latest after
 * LOGIN_LOCK_HOLD_MAX_MS, see there). Without `navigator.locks`, or when the
 * lock cannot be had within LOGIN_LOCK_WAIT_MS, `fn` runs unserialised.
 * `info.waited` tells whether another tab held the lock first. Never call it
 * from inside `fn` (the lock is not reentrant).
 */
export async function withLoginLock<T>(fn: (info: LoginLockInfo) => Promise<T>): Promise<T> {
  const locks = typeof navigator !== 'undefined' ? navigator.locks : undefined;
  if (!locks || typeof locks.request !== 'function') {
    return startHeld(fn, false).result;
  }
  let run: { held: Promise<void>; result: Promise<T> } | undefined;
  await locks.request(LOGIN_LOCK_NAME, { ifAvailable: true }, (lock) => {
    if (!lock) return undefined;
    run = startHeld(fn, false);
    return run.held;
  });
  if (run) {
    return run.result;
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LOGIN_LOCK_WAIT_MS);
  try {
    await locks.request(LOGIN_LOCK_NAME, { signal: controller.signal }, () => {
      clearTimeout(timer);
      run = startHeld(fn, true);
      return run.held;
    });
  } catch (e) {
    if (!run) {
      // timed out waiting (or the lock manager failed): do not block the login
      console.warn('Login lock not available, logging in without it', e);
      clearTimeout(timer);
      return startHeld(fn, true).result;
    }
  }
  return run!.result;
}

function openChannel(name: string): BroadcastChannel | undefined {
  try {
    return typeof BroadcastChannel === 'function' ? new BroadcastChannel(name) : undefined;
  } catch {
    return undefined;
  }
}

let channel: BroadcastChannel | undefined;
const listeners = new Set<(message: AuthBroadcastMessage) => void>();

function authChannel(): BroadcastChannel | undefined {
  if (!channel) {
    channel = openChannel(AUTH_BROADCAST_CHANNEL);
    if (channel) {
      channel.onmessage = (event: MessageEvent<AuthBroadcastMessage>) => {
        const message = event.data;
        if (!message || message.v !== 1 || message.tabId === authTabId) {
          return;
        }
        for (const listener of Array.from(listeners)) {
          try {
            listener(message);
          } catch (e) {
            console.error('Error in auth broadcast listener', e);
          }
        }
      };
    }
  }
  return channel;
}

/** Listens for other tabs' auth notices. */
export function onAuthBroadcast(listener: (message: AuthBroadcastMessage) => void): Unsubscribe {
  listeners.add(listener);
  authChannel();
  return () => {
    listeners.delete(listener);
  };
}

/** Tells the other tabs that this tab logged in as `userId`. */
export function broadcastLoggedIn(userId: string) {
  authChannel()?.postMessage({ v: 1, type: 'logged-in', tabId: authTabId, userId } satisfies AuthBroadcastMessage);
}

/** Tells the other tabs (new and, for one release, old pages) that this tab logged out. */
export function broadcastLoggedOut(userId: string | null) {
  authChannel()?.postMessage({ v: 1, type: 'logged-out', tabId: authTabId, userId } satisfies AuthBroadcastMessage);
  // old pages (before chat-sync) handle this as "another tab logged out";
  // new pages never listen on that channel. Remove in the release after chat-sync.
  const legacy = openChannel(LEGACY_LOGIN_STATE_CHANNEL);
  if (legacy) {
    legacy.postMessage('anonymous');
    legacy.close();
  }
}
