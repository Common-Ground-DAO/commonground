// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * chat-sync transport contract (roadmap docs/todo/ROADMAP_chat-sync.md,
 * decision [1] "independent tabs + catch-up" and [8] "migration").
 *
 * Types and constants only: nothing here runs or is wired. It fixes what the
 * transport slice (webSocket.ts, connection.ts, login.ts, baseConnector.ts,
 * connection UI, CallProvider hold), the service-worker slice and the data
 * layer (src/data/chat) agree on.
 *
 * Model in one paragraph: every tab owns its socket, its login state and its
 * in-memory data. No tab roles, no relay, no service-worker referee. Visible
 * tabs are always connected; hidden tabs disconnect after
 * HIDDEN_DISCONNECT_AFTER_MS unless a SocketHold is active (a call), and close
 * their socket themselves on `freeze` and `pagehide`. Every return to "live"
 * and every resume is followed by a catch-up in the data layer.
 */

export type Unsubscribe = () => void;

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Request header carrying this tab's socket id on every API request (set in
 * baseConnector). The server then excludes only that socket from the echo of
 * the request's own events (instead of the whole device) and joins/leaves
 * article rooms per socket. Without the header the server keeps the old
 * per-device behaviour for old clients.
 *
 * FIXED NAME: the cg.box G1 gateway lists it in its CORS/origin allowlist. A
 * rename must be reported to the main line first.
 */
export const SOCKET_ID_HEADER = 'x-cg-socket-id';

/**
 * Format of a socket.io socket id, which is also the format the server
 * validates for SOCKET_ID_HEADER (`^[A-Za-z0-9_-]{20}$`). The tab's fallback id
 * (see Transport.getRequestSocketId) uses the same format.
 */
export const SOCKET_ID_PATTERN = /^[A-Za-z0-9_-]{20}$/;

/**
 * The only Web Lock of the design: serialises HTTP logins (device login and
 * interactive logins) across the tabs of one browser profile, because an
 * anonymous -> user login regenerates the session id and two concurrent ones
 * would invalidate each other's cookie. Held only around one login
 * exchange — for a device login `User/getSignableSecret`, the signature and
 * `User/login` together, since the session keeps one signable secret — plus
 * the re-check of `User/checkLoginStatus` when a tab got the lock after
 * another tab logged in (and the post-reconnect snapshot login). Nothing
 * else waits on it. Without `navigator.locks` the login runs unserialised.
 */
export const LOGIN_LOCK_NAME = 'cg:login';

/** A hidden tab without an active SocketHold closes its socket after this. */
export const HIDDEN_DISCONNECT_AFTER_MS = 5 * 60_000;

/**
 * A tab that becomes visible again while its socket stayed live fires the
 * resume signal only if it was hidden for at least this long (shorter
 * switches need no catch-up: the socket kept delivering).
 */
export const RESUME_MIN_HIDDEN_MS = 30_000;

// ---------------------------------------------------------------------------
// Live / resume / update signals
// ---------------------------------------------------------------------------

/**
 * Kind of a "live" transition.
 * - `established`: first time live in this page load.
 * - `restored`: live again after the socket was lost or closed by policy.
 * - `user`: live again on the same socket after its user changed (login,
 *   user switch, logout), which changes its rooms. `live` is false from the
 *   start of a socket login until its ack.
 *
 * connectionManager emits the app events `cliConnectionEstablished` /
 * `cliConnectionRestored` exactly at the `established` / `restored`
 * transitions (no longer on the raw socket `connect`; `user` has no app
 * event), and `Common.WebSocketState` reports `connected` only
 * while live. `version-update` stops being a socket state (see
 * Transport.updateAvailable).
 */
export type LiveKind = 'established' | 'restored' | 'user';

/**
 * Why a tab whose socket stayed live asks for a catch-up:
 * - `visible`: document visible again after >= RESUME_MIN_HIDDEN_MS hidden
 * - `pageshow`: `pageshow` with `persisted` (restored from bfcache)
 * - `resume`: page lifecycle `resume` after `freeze`
 * - `online`: browser `online` event
 * When the socket was not live at that moment, the transport reconnects
 * instead and only the later `live` signal fires (never both for one
 * occasion). A sequence gap seen in a live event is handled in the data layer
 * and is not a transport signal.
 */
export type ResumeReason = 'visible' | 'pageshow' | 'resume' | 'online';

/** Keeps the socket open while the tab is hidden. Release exactly once. */
export interface SocketHold {
  release(): void;
}

/**
 * What the transport exposes to the data layer and the UI. The transport
 * slice implements it (on webSocketManager / connectionManager or a small
 * façade over both); consumers depend only on this interface.
 */
export interface Transport {
  /**
   * Live = socket connected AND, for a logged-in tab, the socket `login`
   * acked with "OK" (the server joins all rooms before acking). For an
   * anonymous tab: socket connected and the socket-scoped joins re-sent
   * (community visitor rooms, CG ID watch). Events emitted by the server
   * before that moment are lost; a catch-up started on `onLive` covers them.
   * "SECURITY_STEP_REQUIRED" or "ERROR" acks are not live. `live` is false
   * from the start of every socket login (also a login or user switch on a
   * connected socket) until its ack.
   */
  readonly live: boolean;
  /** Fires on every transition to live (see LiveKind). */
  onLive(listener: (kind: LiveKind) => void): Unsubscribe;
  /** Fires on every transition of `live` (true and false). */
  onLiveChange(listener: (live: boolean) => void): Unsubscribe;
  /** Catch-up request while the socket stayed live (see ResumeReason). */
  onResume(listener: (reason: ResumeReason) => void): Unsubscribe;

  /**
   * A newer build is deployed (the server's `buildId` differs). Separate from
   * the socket state: the socket, pings, socket re-login and remote paging
   * keep working; the UI may offer a reload and the service-worker update
   * runs as before. Never resets to false within a page load.
   */
  readonly updateAvailable: boolean;
  onUpdateAvailable(listener: () => void): Unsubscribe;

  /**
   * Keep the socket while the tab is hidden (CallProvider takes one for the
   * whole time the tab is in a call). While at least one hold is active the
   * hidden-disconnect timer does not run. After the last release of a hidden
   * tab the timer starts from the release, i.e. the socket closes at
   * `releaseTime + HIDDEN_DISCONNECT_AFTER_MS` at the earliest. `freeze` and
   * `pagehide` close the socket regardless of holds (browsers do not freeze
   * a tab with live media).
   */
  holdSocket(reason: 'call'): SocketHold;

  /**
   * Value for SOCKET_ID_HEADER, read per request: the current socket's id
   * while a socket is connected, otherwise a random per-tab id in the same
   * format that matches no socket (so the server excludes nobody and the tab
   * dedupes its own echo by message id). Never empty, so a new client never
   * falls back to the per-device exclusion. The id changes on reconnect;
   * requests in flight across a reconnect may echo back, which the data
   * layer handles by id.
   *
   * Requests that create per-socket server state (today: article event
   * rooms via `Message/joinArticleEventRoom`) are sent only while `live`
   * and re-sent on every `onLive` (any kind): a new socket, or a socket
   * whose user changed, starts without that state, and a join sent while not
   * live targets no socket (the fallback id) and has no effect.
   */
  getRequestSocketId(): string;
}

/*
 * Hidden-tab policy (implemented by the transport slice):
 * - Visible tabs keep (or re-open) their socket at all times.
 * - Hidden: after HIDDEN_DISCONNECT_AFTER_MS without a SocketHold, close the
 *   socket (client disconnect, no auto-reconnect).
 * - `freeze` and `pagehide`: close the socket immediately (`pagehide`
 *   replaces `beforeunload`; nothing is written to localStorage per event).
 * - After such a policy close the tab reconnects only on `visibilitychange`
 *   to visible, `pageshow`, `resume` or `online` while visible; hidden tabs
 *   never reconnect on a timer. Inside the grace period socket.io's own
 *   reconnection stays on.
 * - A reconnect performs the socket login only, no HTTP device login; the
 *   HTTP device login runs once per page load, under LOGIN_LOCK_NAME. The
 *   community/chat/user refresh that the forced re-login used to do on every
 *   reconnect is triggered from `onLive('restored')` instead.
 */

// ---------------------------------------------------------------------------
// Cross-tab auth broadcast
// ---------------------------------------------------------------------------

/** BroadcastChannel for AuthBroadcastMessage (new pages only). */
export const AUTH_BROADCAST_CHANNEL = 'cg:auth';

/**
 * Posted by the tab that performed the change, after the server call
 * returned. Receivers:
 * - `logged-out`: emit socket `logout` (or disconnect), drop all in-memory
 *   data (stores' `clear()`), become anonymous and reconnect as anonymous.
 *   They do NOT call `User/logout` again.
 * - `logged-in`: if this tab is anonymous, re-check the session
 *   (`User/checkLoginStatus`) and run its own in-memory setup; no second
 *   HTTP login. If this tab is logged in as another `userId`, handle it as
 *   `logged-out` first (drop socket login and memory), then as `logged-in`.
 *   Same `userId`: nothing to do.
 * The `storage` event on the existing `CG_CURRENT_USER` localStorage key
 * (removed/changed) stays the fallback trigger for both (BroadcastChannel can
 * be missing or the message lost); handlers must be idempotent.
 */
export type AuthBroadcastMessage = {
  v: 1;
  type: 'logged-out';
  /** sender tab (receivers ignore their own) */
  tabId: string;
  /** user that was logged out, if known */
  userId: string | null;
} | {
  v: 1;
  type: 'logged-in';
  tabId: string;
  userId: string;
};

/**
 * Legacy channel of old pages. New pages never listen on it. For one release,
 * on logout a new page additionally posts the plain string `'anonymous'` on
 * it, which still-open old pages handle as "another tab logged out" (their
 * existing behaviour). Nothing else is posted there.
 */
export const LEGACY_LOGIN_STATE_CHANNEL = 'CG_LOGIN_STATE';

// ---------------------------------------------------------------------------
// Service-worker compatibility with old pages (one release)
// ---------------------------------------------------------------------------

/**
 * BroadcastChannel over which old pages (before chat-sync) talk to the tab
 * referee in the service worker. New pages never open it: neither post nor
 * listen (so an old worker that still controls a new page stays inert for
 * it).
 */
export const LEGACY_WEBSOCKET_STATE_CHANNEL = 'CG_WEBSOCKET_STATE';

type LegacyTabState =
  'unknown' | 'active' | 'active-throttled' | 'passive' | 'passive-throttled';
type LegacySocketState =
  'disconnected' | 'connecting' | 'connected' | 'version-update';

/**
 * Old page -> worker on LEGACY_WEBSOCKET_STATE_CHANNEL (copy of
 * `TabToWorkerMessage`, src/service-worker.ts before chat-sync). An old page
 * sends `tabState: 'unknown'` every 500 ms until it gets a WorkerToTab for its
 * `tabId`, then heartbeats every 2 s with its current role; `'tabClosed'` on
 * `beforeunload`.
 */
export type LegacyTabToWorkerMessage = {
  type: 'TabToWorker';
  tabId: string;
  tabState: LegacyTabState | 'tabClosed';
  visible?: boolean;
  socketState?: LegacySocketState;
  lastEventTime?: number;
  lastDisconnect?: number;
};

/**
 * Worker -> old page on LEGACY_WEBSOCKET_STATE_CHANNEL (copy of
 * `WorkerToTabMessage`). An old page acts on it only when `tabId` is its own.
 * If it carries `socketState`/`lastEventTime`/`lastDisconnect`, a passive old
 * page mirrors them.
 */
export type LegacyWorkerToTabMessage = {
  type: 'WorkerToTab';
  tabId: string;
  tabState: LegacyTabState;
  socketState?: LegacySocketState;
  lastEventTime?: number;
  lastDisconnect?: number;
};

/**
 * The compat answer of the new worker: for every LegacyTabToWorkerMessage
 * with `tabState === 'unknown'`, post exactly this on
 * LEGACY_WEBSOCKET_STATE_CHANNEL. It carries no socket state, so the old page
 * does not mirror stale values; it connects as "active". All other legacy
 * messages (heartbeats, 'tabClosed') are ignored; there are no bans. Several
 * old pages answered this way resolve collisions among themselves as before
 * (visible tab wins). Of the page-to-worker `postMessage`s of old pages,
 * `{ type: 'STOP_TAB_HANDLING' }` is accepted and ignored;
 * `{ type: 'CHANNEL_VISITED', channelId }` stays handled (it closes that
 * channel's push notifications, for new pages too). Remove this in the
 * release after chat-sync.
 */
export type LegacyCompatAnswer = {
  type: 'WorkerToTab';
  tabId: string;
  tabState: 'active';
};
