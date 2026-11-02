// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * chat-sync data-layer contract (roadmap docs/todo/ROADMAP_chat-sync.md,
 * decisions [2] catch-up, [4] messages, [5] read state, [6] notifications).
 * Summary for implementers: ./README.md.
 *
 * Types and constants only. The store cores are pure TypeScript with injected
 * dependencies (ChatApi, NotificationApi, ChatEventSource, ChatClock), so
 * they run in vitest (node) against a scripted fake server. Wiring them to
 * messageApi / notificationApi / connectionManager / the transport happens in
 * the façade (`data.channelManager`, `data.notification`).
 *
 * Dates: models keep today's types (Date on Models.Message.Message /
 * Models.Notification.Notification, ISO strings on API types and on
 * ChannelReadState). ISO strings are compared by `Date.parse`, never as
 * strings (servers may differ in fractional digits).
 */

import type { LiveKind, ResumeReason, Unsubscribe } from 'data/appstate/transport';

export type { Unsubscribe };

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** Channels without an open window kept in memory per tab (LRU). */
export const CHANNEL_LRU_SIZE = 20;
/** Max server messages of a channel's latest segment; older ones are dropped from memory. */
export const LATEST_SEGMENT_MAX = 200;
/** Page size for loadOlder/loadNewer/init when no count is given. */
export const PAGE_SIZE = 30;
/** `getChanges` limit the client sends. */
export const GET_CHANGES_LIMIT = 200;
/** Debounce of the catch-up scheduled by a sequence gap in a live event. */
export const GAP_RESYNC_DEBOUNCE_MS = 1_500;
/** A send without answer after this shows "error-send"; a late success still resolves it. */
export const SEND_TIMEOUT_MS = 20_000;
/** Trailing throttle of setChannelLastRead after the first, immediate call. */
export const MARK_READ_THROTTLE_MS = 1_000;

// ---------------------------------------------------------------------------
// Injected dependencies
// ---------------------------------------------------------------------------

/**
 * Message, read-state and sync calls. Method names and signatures match the
 * connector `src/data/api/messages.ts` (`messageApi`), so the façade can pass
 * it directly once `getChanges`/`getSyncState` exist there.
 *
 * Fallback against servers without chat-sync (deploy window): when
 * `getChanges` or `getSyncState` fails with HTTP 404, the stores remember
 * that for the page load and fall back to `loadMessages` (latest page, merged
 * by the rules below) and to the existing community/chat snapshots.
 */
export interface ChatApi {
  loadMessages(data: API.Messages.loadMessages.Request): Promise<API.Messages.loadMessages.Response>;
  messagesById(data: API.Messages.messagesById.Request): Promise<API.Messages.messagesById.Response>;
  getChanges(data: API.Messages.getChanges.Request): Promise<API.Messages.getChanges.Response>;
  getSyncState(data: API.Messages.getSyncState.Request): Promise<API.Messages.getSyncState.Response>;
  createMessage(data: API.Messages.createMessage.Request): Promise<API.Messages.createMessage.Response>;
  createModerationMessage(data: API.Messages.createMessage.Request): Promise<API.Messages.createMessage.Response>;
  editMessage(data: API.Messages.editMessage.Request): Promise<API.Messages.editMessage.Response>;
  deleteMessage(data: API.Messages.deleteMessage.Request): Promise<API.Messages.deleteMessage.Response>;
  setReaction(data: API.Messages.setReaction.Request): Promise<API.Messages.setReaction.Response>;
  unsetReaction(data: API.Messages.unsetReaction.Request): Promise<API.Messages.unsetReaction.Response>;
  setChannelLastRead(data: API.Messages.setChannelLastRead.Request): Promise<API.Messages.setChannelLastRead.Response>;
}

/** Notification calls; names match `src/data/api/notifications.ts`. */
export interface NotificationApi {
  loadNotifications(data: API.Notification.loadNotifications.Request): Promise<API.Notification.loadNotifications.Response>;
  getUnreadCount(data: API.Notification.getUnreadCount.Request): Promise<API.Notification.getUnreadCount.Response>;
  markAsRead(data: API.Notification.markAsRead.Request): Promise<API.Notification.markAsRead.Response>;
  markAllAsRead(data: API.Notification.markAllAsRead.Request): Promise<API.Notification.markAllAsRead.Response>;
}

/**
 * Everything the stores observe. The façade builds it from
 * connectionManager.registerClientEventHandler, the Transport
 * (data/appstate/transport.ts), document visibility and loginManager.
 * Events may arrive duplicated, out of order, and overlapping with HTTP
 * responses and catch-up pages; the stores are idempotent against that.
 */
export interface ChatEventSource {
  onMessageEvent(listener: (event: Events.Message.Message) => void): Unsubscribe;
  onLastReadEvent(listener: (event: Events.Channel.LastRead) => void): Unsubscribe;
  onNotificationEvent(listener: (event: Events.Notification.Notification) => void): Unsubscribe;

  /** Transport.onLive: socket logged in and rooms joined. Stores resync. */
  onLive(listener: (kind: LiveKind) => void): Unsubscribe;
  /** Transport.onResume: socket stayed live, but the tab was away. Stores resync. */
  onResume(listener: (reason: ResumeReason) => void): Unsubscribe;
  readonly live: boolean;

  /** `document.visibilityState === 'visible'` (level input for read marking). */
  readonly visible: boolean;
  onVisibilityChange(listener: (visible: boolean) => void): Unsubscribe;

  /** Logged-in user of this tab; `undefined` while anonymous or logging in. */
  readonly userId: string | undefined;
  onUserChange(listener: (userId: string | undefined) => void): Unsubscribe;
}

/** Time source; tests pass a fake. */
export interface ChatClock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export type ChannelStoreDeps = {
  api: ChatApi;
  events: ChatEventSource;
  clock: ChatClock;
  /** client UUIDs for new messages (crypto.randomUUID in the app) */
  newId(): string;
};

export type ReadStateStoreDeps = {
  api: Pick<ChatApi, 'setChannelLastRead' | 'getSyncState'>;
  events: ChatEventSource;
  clock: ChatClock;
  /** registered access of a channel (ChannelStore.getAccessForChannel) */
  getAccess(channelId: string): API.Messages.MessageAccess | undefined;
  /** shared persistence (community/chat Dexie DBs); optional in tests */
  persistence?: ReadStatePersistence;
};

export type NotificationStoreDeps = {
  api: NotificationApi;
  events: ChatEventSource;
  clock: ChatClock;
};

export type CreateChannelStore = (deps: ChannelStoreDeps) => ChannelStore;
export type CreateReadStateStore = (deps: ReadStateStoreDeps) => ReadStateStore;
export type CreateNotificationStore = (deps: NotificationStoreDeps) => NotificationStore;

// ---------------------------------------------------------------------------
// Windows
// ---------------------------------------------------------------------------

/**
 * What changed in a window, passed to listeners together with the new state
 * so the list sets its scroll lock BEFORE rendering (listeners are called
 * synchronously; set the lock first, then the React state).
 */
export type WindowChange =
  /**
   * The visible slice was replaced. `init`: first load; `jump`: init at an
   * item/date or a detached segment; `latest`: jumpToLatest; `resync`: a
   * catch-up reset replaced the latest segment while it was shown (keep the
   * reading position by date).
   */
  | { kind: 'reset'; cause: 'init' | 'jump' | 'latest' | 'resync' }
  /** older items added at the start (loadOlder) */
  | { kind: 'prepend'; count: number }
  /** newer items added at the end by a page (loadNewer while detached) */
  | { kind: 'append-page'; count: number }
  /**
   * live items added at the end while `withEndOfList`: incoming messages, or
   * the own pending send (`own: true`, the list scrolls to the bottom)
   */
  | { kind: 'append-live'; count: number; own: boolean }
  /** items changed in place: edit, reaction, sendStatus, removal by delete */
  | { kind: 'update' }
  /** items removed from one end of the visible slice (trim) */
  | { kind: 'trim'; from: 'start' | 'end'; count: number };

export type WindowListener<T extends Models.ItemList.Item> =
  (state: Models.ItemList.ItemListState<T>, change: WindowChange) => void;

/**
 * A view on an ordered item list. `state` keeps the existing
 * `Models.ItemList.ItemListState` shape (src/common/types/models/itemlist.d.ts):
 * - `items`: ascending by (createdAt, id). A new array on every change;
 *   unchanged items keep their object identity.
 * - `rangeStart`/`rangeEnd`: createdAt of the first/last server item in
 *   `items` (null when there is none). No far-future sentinel any more.
 * - `withEndOfList`: the slice ends at the newest end of the latest segment;
 *   live items are appended (`append-live`).
 * - `withStartOfList`: the oldest item of the list is included (the server
 *   returned a short page).
 * - `hasPreviousItemsLocally` / `hasNextItemsLocally`: items in memory were
 *   trimmed off that end; `load*` returns them without a request.
 * - `hasPreviousItemsOnRemote` / `hasNextItemsOnRemote`: more items exist
 *   only on the server (true while unknown).
 * - `ready`: the first `init` settled. `isEmpty`: ready, no server items,
 *   start and end of list included. `isDestroyed`: after `destroy()`.
 */
export interface ItemWindow<T extends Models.ItemList.Item> {
  readonly state: Models.ItemList.ItemListState<T>;
  /**
   * `recent`: latest items; `atItemId`: the item and its neighbours, fetched
   * from the server when not in memory, rejects with NOT_FOUND if it does not
   * exist or is deleted; `atDate`: items around the date. Resolves with the
   * number of items in the slice. May be called again (jump); a running
   * init is superseded.
   */
  init(options: Models.ItemList.ItemListInitOptions): Promise<number>;
  /** older items: from memory first, then one server page (default PAGE_SIZE) */
  loadOlder(count?: number): Promise<void>;
  /** newer items: only when not `withEndOfList`; re-attaches to the latest segment when they meet */
  loadNewer(count?: number): Promise<void>;
  /** drop items from one end of the visible slice so `keep` remain (replaces shrinkStart/shrinkEnd) */
  trim(options: { keep: number; from: 'start' | 'end' }): void;
  /** listener is called synchronously on every change; not called on subscribe */
  subscribe(listener: WindowListener<T>): Unsubscribe;
  /** release this window (ref count); no listener calls afterwards */
  destroy(): void;
}

/**
 * A window on one channel's messages. Any number per channel (main view,
 * desktop notification preview, mobile/desktop layout switch); each has its
 * own slice and listeners over the shared per-channel data.
 */
export interface ChannelWindow<T extends Models.ItemList.Item = Models.Message.Message> extends ItemWindow<T> {
  readonly channelId: string;
  /** leave a detached segment and show the latest one (`reset`, cause `latest`) */
  jumpToLatest(): Promise<void>;
}

// ---------------------------------------------------------------------------
// ChannelStore
// ---------------------------------------------------------------------------

/** Input of createMessage; the creator is ChatEventSource.userId. */
export type NewMessage = Pick<Models.Message.Message, 'channelId' | 'body' | 'attachments' | 'parentMessageId'>;

/**
 * In-memory message store of one tab; replaces ChannelDatabaseManager and
 * keeps the name `data.channelManager` (façade).
 *
 * Per channel: a contiguous "latest" segment (ends at "now", at most
 * LATEST_SEGMENT_MAX server messages, live-updated), detached segments
 * created by jumps (merged into latest when they meet), pending sends, edit
 * overlays, tombstones (deleted ids, kept for the channel's cache lifetime), a
 * loose map of single items (reply parents, pins; never part of a segment),
 * and the catch-up cursor (`getChanges` cursor + its numeric syncSeq).
 * Memory only. Channels with an open window are pinned; at most
 * CHANNEL_LRU_SIZE others stay cached (LRU), the rest are forgotten.
 *
 * Merge rule (one function for every source: pages, getChanges, live events,
 * HTTP responses):
 * - A stored message is replaced only by a version with a higher `syncSeq`;
 *   equal seq = same version, keep the stored one. `update` events are
 *   partial: their fields are applied only if their `syncSeq` is higher.
 *   When either side lacks `syncSeq` (old server, row not yet sequenced),
 *   compare `updatedAt` instead (full versions: newer or equal wins; partial
 *   updates: strictly newer wins).
 * - Tombstones (delete events, `deletedIds`) are terminal and beat any
 *   version; a later page cannot resurrect a tombstoned id.
 * - A server page (loadMessages, messagesById, getChanges non-reset) is
 *   authoritative only for its own range: it upserts what it contains and
 *   never removes items, and it never touches items outside
 *   [oldest, newest] of the page. So a snapshot can never delete a newer
 *   live item. Removals come only from tombstones and resets.
 * - `getChanges` reset (`reset: true`): the latest segment becomes the reset
 *   page, plus local items with `syncSeq` > the reset's `syncSeq` (newer than
 *   the page's snapshot), plus pending sends. Other local items of the latest
 *   segment are dropped. The cursor becomes the reset's cursor.
 *
 * Catch-up (`resync`): on ChatEventSource.onLive / onResume, for every
 * channel with an open window (debounced, one at a time per channel):
 * `getChanges` from the stored cursor (`null` the first time), following
 * `hasMore`. A cached channel without window catches up from its cursor when
 * a window opens again. Live events that arrive meanwhile are applied too.
 * Gaps: a live event with `syncSeq > cursorSeq + 1` schedules a `getChanges`
 * after GAP_RESYNC_DEBOUNCE_MS (some seq bumps have no own event, so false
 * gaps happen and are cheap); an event with `syncSeq === cursorSeq + 1`
 * advances the cursor locally. Catch-up never plays sounds or alerts.
 *
 * Sending: createMessage inserts the pending item synchronously, before the
 * first await (`sendStatus: 'sending'`, `createdAt` = local send time, no
 * syncSeq), shown after the newest server item while `withEndOfList` (in
 * send order). It resolves by id with whichever comes first: the API
 * response, a live `new` event, or a page containing the id. Failure or
 * SEND_TIMEOUT_MS -> `error-send` (kept until retried or discarded, body and
 * attachments preserved). A retry reuses the id (idempotent create).
 * Edit: an overlay on the server item (`sendStatus: 'sending'`, new body,
 * attachments) until the response; success applies the server fields and
 * clears `sendStatus`; failure -> `error-update`. The overlay is also
 * dropped when a server version newer than the edit arrives.
 */
export interface ChannelStore {
  /** remember how to address a channel; idempotent, later calls update it */
  registerAccessForChannel(access: API.Messages.MessageAccess): void;
  getAccessForChannel(channelId: string): API.Messages.MessageAccess | undefined;

  /**
   * Open a ref-counted window. Never throws: a window opened before its
   * channel's access is registered waits for it in `init`.
   */
  openWindow(channelId: string): ChannelWindow;

  /**
   * Observe one message (reply parent, pinned message) without an open
   * window. Calls `onChange` synchronously when the message is in memory,
   * otherwise after a `messagesById` fetch; again on every change; with
   * `undefined` when it is deleted or not found.
   */
  watchMessage(
    channelId: string,
    messageId: string,
    onChange: (message: Models.Message.Message | undefined) => void,
  ): Unsubscribe;

  /**
   * Send. The pending item is visible when this returns (synchronously);
   * the promise resolves when the server accepted the message and rejects on
   * failure (the item then shows `error-send`).
   */
  createMessage(message: NewMessage, options?: { moderation?: boolean }): Promise<void>;
  /** re-send a failed send (same id) or a failed edit */
  retrySend(channelId: string, messageId: string): Promise<void>;
  /** drop a failed or pending send, or revert a failed edit overlay */
  discardPending(channelId: string, messageId: string): void;
  editMessage(
    message: Models.Message.Message,
    update: Pick<Models.Message.Message, 'body' | 'attachments'>,
  ): Promise<void>;
  /** delete on the server; tombstones the id on success without waiting for the event */
  deleteMessage(channelId: string, messageId: string, creatorId: string): Promise<void>;
  setReaction(channelId: string, messageId: string, reaction: string): Promise<void>;
  unsetReaction(channelId: string, messageId: string): Promise<void>;

  /** drop everything of a channel (left community, closed chat); was deleteChannelDatabase */
  forgetChannel(channelId: string): void;
  /** logout: drop all channels, windows get an empty reset */
  clear(): void;
  /** tests / teardown: unsubscribe from the event source and stop timers */
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Read state
// ---------------------------------------------------------------------------

/**
 * Read state of one community channel or DM. Article comment channels and
 * call chats have none (articles keep their localStorage marker).
 */
export type ChannelReadState = {
  channelId: string;
  /** max of every value ever seen (ISO); null = never read */
  lastRead: string | null;
  /** messages of others after lastRead; capped at API.Messages.UnreadCap */
  unread: number;
  /** channel syncSeq that `unread` is valid at; 0 = unknown */
  seq: number;
  /** max of every value ever seen (ISO) */
  lastMessageDate: string | null;
};

/**
 * Every source of read-state information. All merges go through one pure
 * function (exported by the store-core slice as
 * `mergeReadState(stored: ChannelReadState | undefined, input: ReadStateInput): ChannelReadState`,
 * in src/data/chat/readState.ts) that both the in-memory ReadStateStore and
 * the Dexie writers (community/chat DBs, inside their transaction) use, so
 * several tabs applying the same inputs converge:
 * - always: `lastRead := max`, `lastMessageDate := max`; afterwards, if
 *   lastRead >= lastMessageDate then `unread := 0`.
 * - `snapshot`: its `unread` is trusted only if its `lastRead` >= the stored
 *   one (null counts as oldest) and, when both have a seq, its `syncSeq` >=
 *   the stored `seq`; then `unread`/`seq` are taken from it. Otherwise the
 *   stored count stays (the snapshot is older than a local mark).
 * - `lastRead` (cliChannelLastRead, setChannelLastRead response, own mark):
 *   its `unread`, when present, is trusted if its `lastRead` >= the stored
 *   one after the max-merge.
 * - `message` (live `new`): own -> `lastRead := max(lastRead, createdAt)`
 *   (the server marks own posts read). Other -> counts +1 only if
 *   `createdAt > lastRead` and, with a syncSeq, `syncSeq > seq` (then
 *   `seq := syncSeq`); without a syncSeq (old server) only if
 *   `createdAt > lastMessageDate`. This makes a duplicate event a no-op;
 *   between snapshots the count is approximate and the next snapshot
 *   corrects it.
 */
export type ReadStateInput = {
  kind: 'snapshot';
  channelId: string;
  lastRead: string | null;
  unread: number;
  /** from getSyncState; absent for the older snapshots (login, getOwnCommunities, getChats) */
  syncSeq?: number;
  lastMessageDate: string | null;
} | {
  kind: 'lastRead';
  channelId: string;
  lastRead: string;
  unread?: number;
} | {
  kind: 'message';
  channelId: string;
  messageId: string;
  createdAt: string;
  syncSeq?: number;
  own: boolean;
};

/**
 * Shared persistence of read state (the community and chat Dexie DBs,
 * implemented by the entity-dbs slice). `apply` re-reads the stored record and
 * applies `mergeReadState` in one transaction; idempotent.
 */
export interface ReadStatePersistence {
  apply(input: ReadStateInput): Promise<void>;
}

/** Level inputs of one window for read marking (from the list UI). */
export type ReadMarkingInput = {
  /** window.state.withEndOfList */
  atLatest: boolean;
  /** the list is scrolled to the bottom (within the list's threshold) */
  atBottom: boolean;
  /** newest server item in the window (pending items excluded) */
  newest: { id: string; createdAt: Date } | null;
};

/** One window's handle for read marking. */
export interface ReadMarker {
  /** report the current level inputs; call on every change of them */
  update(input: ReadMarkingInput): void;
  dispose(): void;
}

/**
 * Read state of all channels and DMs of one tab, plus level-triggered marking.
 *
 * Marking: the channel is marked read up to `newest.createdAt` (+ `messageId`
 * once the server supports it) while ANY of its markers has
 * `atLatest && atBottom && newest`, AND ChatEventSource.visible AND a user is
 * logged in. Re-evaluated on every marker update, visibility change and user
 * change: a level, not an edge. Sent only if newer than
 * max(lastRead, last sent value); the first call immediately, then a trailing
 * throttle of MARK_READ_THROTTLE_MS. While logged out or failing, the value
 * stays pending and is sent on the next login, live signal or trigger. No
 * IntersectionObserver, no DOM timestamps.
 *
 * Catch-up: on onLive / onResume it calls `getSyncState` and applies every
 * entry as a `snapshot` input (with syncSeq).
 *
 * Events: it subscribes itself to onLastReadEvent (`lastRead` input) and to
 * `new` message events (`message` input, `own` = creatorId === userId) of
 * channels that already have a read state or a registered access with
 * `communityId` or `chatId`. The older snapshots (login response,
 * getOwnCommunities, getChats, community/chat `new` events) are fed in by
 * their owners through `apply`.
 */
export interface ReadStateStore {
  get(channelId: string): ChannelReadState | undefined;
  /** listener gets every changed channel state */
  subscribe(listener: (state: ChannelReadState) => void): Unsubscribe;
  /** merge one input (in memory and via persistence); returns the merged state */
  apply(input: ReadStateInput): ChannelReadState;
  /** one marker per mounted message window */
  createMarker(channelId: string): ReadMarker;
  /** logout */
  clear(): void;
  dispose(): void;
}

// ---------------------------------------------------------------------------
// Notifications
// ---------------------------------------------------------------------------

/**
 * Notifications of one tab: memory + server, no Dexie, no chunks.
 *
 * Count: from the server only — login response (`Number()` it), the
 * `unreadCount` of every notification event, `getUnreadCount` on resync
 * (onLive / onResume), after markAsRead/markAllAsRead (unless an event with a
 * count arrived meanwhile) and whenever an event lacks `unreadCount` (old
 * server; debounced). Never `++`/`--`.
 *
 * List (`openList`): first page on `init('recent')` (one fetch even if init
 * is called twice), the newest page again on resync while open. Live events
 * are applied idempotently: `new` upserts by id (append-live when
 * withEndOfList), `update` merges if `updatedAt` >= stored, `delete` removes,
 * `allread` marks all loaded items read.
 *
 * markAsRead: no-op when the item is known read or a call for it is in
 * flight; optimistic `read: true`, reverted on failure.
 */
export interface NotificationStore {
  readonly unreadCount: number;
  /** multi-subscriber; called on every change of the count */
  subscribeUnreadCount(listener: (count: number) => void): Unsubscribe;
  openList(): ItemWindow<Models.Notification.Notification>;
  markAsRead(notificationId: string): Promise<void>;
  markAllAsRead(): Promise<void>;
  /** synchronous; takes the login response value (number or numeric string) */
  setupAfterLogin(unreadCount: number | string): void;
  /** logout */
  clear(): void;
  dispose(): void;
}
