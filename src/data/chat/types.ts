// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * chat-sync data-layer contract: catch-up, messages, read state,
 * notifications. Overview: docs/frontend §3 "Chat stores"; summary of the
 * rules: ./README.md.
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
// Limits and error values
// ---------------------------------------------------------------------------

/** Channels without a pin (see ChannelStore) kept in memory per tab (LRU). */
export const CHANNEL_LRU_SIZE = 20;
/**
 * Max server messages of a channel's latest segment; older ones are dropped
 * from memory, except items inside a visible slice of an open window.
 */
export const LATEST_SEGMENT_MAX = 200;
/** Page size for loadOlder/loadNewer/init when no count is given. */
export const PAGE_SIZE = 30;
/** `getChanges` limit the client sends. */
export const GET_CHANGES_LIMIT = 200;
/** A seq gap that is still open after this triggers a `getChanges`. */
export const GAP_RESYNC_DEBOUNCE_MS = 1_500;
/** A send without answer after this shows "error-send"; a late success still resolves it. */
export const SEND_TIMEOUT_MS = 20_000;
/**
 * A window operation (init, jump) on a channel whose access is still not
 * registered after this rejects with WINDOW_ERROR.NO_ACCESS.
 */
export const ACCESS_WAIT_MS = 30_000;
/** Trailing throttle of setChannelLastRead after the first, immediate call. */
export const MARK_READ_THROTTLE_MS = 1_000;
/** ChannelReadState.counted keeps at most this many (the highest) seqs. */
export const COUNTED_SEQS_MAX = 50;

/**
 * `Error.message` values a window's `init` rejects with.
 * - NOT_FOUND (same string as `errors.client.NOT_FOUND`): `atItemId` target
 *   does not exist, is deleted or not readable.
 * - SUPERSEDED: a later `init` (or `destroy`) on the same window replaced
 *   this one; callers ignore it (no snackbar).
 * - NO_ACCESS: the channel's access (community/chat/call/article) did not
 *   become known within ACCESS_WAIT_MS; a later `init` may succeed.
 */
export const WINDOW_ERROR = {
  NOT_FOUND: 'NOT_FOUND',
  SUPERSEDED: 'WINDOW_INIT_SUPERSEDED',
  NO_ACCESS: 'CHANNEL_ACCESS_UNKNOWN',
} as const;

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

  /**
   * Transport.onLive: socket logged in and rooms joined (also `user` after a
   * login, user switch or logout on a live socket). Stores resync.
   */
  onLive(listener: (kind: LiveKind) => void): Unsubscribe;
  /** Transport.onResume: socket stayed live, but the tab was away. Stores resync. */
  onResume(listener: (reason: ResumeReason) => void): Unsubscribe;
  readonly live: boolean;

  /** `document.visibilityState === 'visible'` (level input for read marking). */
  readonly visible: boolean;
  onVisibilityChange(listener: (visible: boolean) => void): Unsubscribe;

  /**
   * Logged-in user of this tab; `undefined` while anonymous or logging in.
   * When it becomes defined while `live`, the source also fires
   * `onLive('user')` (the socket went live before the login settled).
   */
  readonly userId: string | undefined;
  onUserChange(listener: (userId: string | undefined) => void): Unsubscribe;
  /**
   * The tab's account, known before the login settles (stored user); used
   * only to classify a message as own. Falls back to `userId` when absent.
   */
  readonly accountId?: string | undefined;
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
  /**
   * Called once per own message when the server confirmed it (createMessage
   * response, or the own `new` event / a page with the id, whichever comes
   * first). The own socket gets no `new` event for it, so the façade
   * forwards it to ReadStateStore.apply as
   * `{ kind: 'message', own: true, … }`.
   */
  onOwnMessage?(message: Models.Message.Message): void;
};

export type ReadStateStoreDeps = {
  api: Pick<ChatApi, 'setChannelLastRead' | 'getSyncState'>;
  events: ChatEventSource;
  clock: ChatClock;
  /** registered access of a channel (ChannelStore.getAccessForChannel) */
  getAccess(channelId: string): API.Messages.MessageAccess | undefined;
  /**
   * registers the access of a channel getSyncState reported (its
   * `communityId`/`chatId`) that has none yet (ChannelStore.registerAccessForChannel)
   */
  registerAccess?(access: API.Messages.MessageAccess): void;
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
   * catch-up reset replaced the data under the slice (keep the reading
   * position by date).
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
 * - `items`: server items ascending by (createdAt, id), then pending items
 *   (own unsent messages) in send order. A new array on every change;
 *   unchanged items keep their object identity.
 * - `rangeStart`/`rangeEnd`: createdAt of the first/last server item in
 *   `items` (null when there is none). No far-future sentinel any more.
 * - `withEndOfList`: the slice ends at the newest end of the latest segment;
 *   live items are appended (`append-live`); pending items are shown only
 *   then.
 * - `withStartOfList`: the oldest item of the list is included (the server
 *   returned a short page).
 * - `hasPreviousItemsLocally` / `hasNextItemsLocally`: items in memory were
 *   trimmed off that end; `load*` returns them without a request.
 * - `hasPreviousItemsOnRemote` / `hasNextItemsOnRemote`: more items exist
 *   only on the server (true while unknown).
 * - `ready`: the first `init` settled. `isEmpty`: ready, no server items
 *   (pending items do not count: check `items.length` before showing an
 *   empty-channel text),
 *   start and end of list included. `isDestroyed`: after `destroy()`.
 */
export interface ItemWindow<T extends Models.ItemList.Item> {
  readonly state: Models.ItemList.ItemListState<T>;
  /**
   * `recent`: latest items; `atItemId`: the item and its neighbours, fetched
   * from the server when not in memory; `atDate`: items around the date.
   * Resolves with the number of items in the slice. May be called again
   * (jump). Rejects with `new Error(WINDOW_ERROR.NOT_FOUND)` for a missing
   * `atItemId` target and with `new Error(WINDOW_ERROR.SUPERSEDED)` when a
   * later `init` or `destroy` replaced it; other errors are network/server
   * errors.
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
 * In-memory message store of one tab, exposed under the name
 * `data.channelManager` too (façade, data/databases/channel.ts).
 *
 * DATA PER CHANNEL: a contiguous "latest" segment (ends at "now", at most
 * LATEST_SEGMENT_MAX server messages, live-updated), detached segments
 * created by jumps (merged into latest when they meet), pending sends, edit
 * overlays, tombstones (deleted ids, kept for the channel's cache lifetime), a
 * loose map of single items (reply parents, pins; never part of a segment),
 * and `seenSeq` (below). Memory only. A channel is pinned while it has an
 * open window, a `watchMessage` watcher or a pending/failed send; at most
 * CHANNEL_LRU_SIZE unpinned channels stay cached (LRU), the rest are
 * forgotten. Trimming the latest segment to LATEST_SEGMENT_MAX never drops
 * items inside the visible slice of an open window.
 *
 * VERSION RULE (one function for every source: pages, getChanges, live
 * events, HTTP responses). chat-sync servers send `syncSeq` on loadMessages,
 * messagesById, getChanges, the createMessage/editMessage responses and all
 * message events; it can still be missing (old server, row not written since
 * the migration).
 * - FULL version (a complete ApiMessage: pages, `new` events, create
 *   response) replaces the stored one when `incoming.syncSeq >= stored.syncSeq`.
 * - PARTIAL update (`update` event delta, edit/reaction responses) applies
 *   its fields only when `incoming.syncSeq > stored.syncSeq`, and then sets
 *   the stored syncSeq/updatedAt to its own.
 * - Mixed: a version with syncSeq beats one without, unless the one without
 *   has a strictly newer `updatedAt`. Both without: compare `updatedAt`
 *   (full: newer or equal wins; partial: strictly newer wins).
 * - Example: an edit at seq 11 and a reaction at seq 12 arrive as events in
 *   the order 12, 11. The reaction delta (12) applies; the edit delta (11) is
 *   dropped (11 < 12), so the body is stale for a moment. The gap 11 stays
 *   open, the catch-up returns the full row at seq 12 (with the edit), and it
 *   replaces the stored one because full versions win on `>=`.
 * - Tombstones (delete events, `deletedIds`) are terminal and beat any
 *   version; nothing resurrects a tombstoned id.
 *
 * PAGES (loadMessages, messagesById) are authoritative only for their own
 * range [oldest, newest]: they upsert what they contain, never remove items
 * and never touch items outside that range. So a snapshot can never delete a
 * newer live item. Removals come only from tombstones and resets.
 *
 * GETCHANGES (non-reset) is a change list, not a range page: each message
 * updates the known copy wherever it is (latest segment, detached segment,
 * loose map) by the version rule. An unknown id is inserted into the latest
 * segment only if its createdAt >= the oldest item of the latest segment (or
 * the latest segment starts at the beginning of the channel); otherwise it is
 * ignored (it is fetched when someone pages there). `deletedIds` tombstone.
 *
 * GETCHANGES RESET (`reset: true`, snapshot seq S):
 * - The latest segment becomes the reset page, plus local items with
 *   `syncSeq > S` whose createdAt >= the page's oldest item (or any createdAt
 *   when the page reaches the start of the channel), plus pending sends.
 *   Everything else of the latest segment is dropped.
 * - Detached segments and loose items of the channel are dropped (watched
 *   loose items are refetched with messagesById).
 * - A window whose visible slice is not inside the new latest segment is
 *   re-initialised as a detached segment at the createdAt of its first
 *   visible item; its listeners get `reset{cause:'resync'}`. A window at the
 *   latest end gets `reset{cause:'resync'}` too.
 * - `seenSeq := S`.
 *
 * CURSOR AND GAPS. `seenSeq` is the contiguous applied high-water mark: all
 * changes up to it are applied. Every applied syncSeq from any source (live
 * events, getChanges, create/edit responses — own sends get no own event)
 * is recorded (a delete event records every seq in `syncSeqs`, else its
 * `syncSeq`); while `seenSeq + 1` is recorded, `seenSeq` advances. A delta
 * dropped because the stored syncSeq is higher is NOT recorded: its gap
 * stays open and the gap catch-up fetches the full row. An equal-seq
 * duplicate counts as recorded. A
 * recorded seq above `seenSeq + 1` is a gap; if it is still open after
 * GAP_RESYNC_DEBOUNCE_MS, a `getChanges` runs (some seq bumps have no own
 * event, so false gaps happen and are cheap). The request cursor is
 * `` `1:${seenSeq}` `` (or `null` when the channel was never synced); after
 * a getChanges, `seenSeq := max(seenSeq, response.syncSeq)` (all changes up
 * to it are included).
 *
 * CATCH-UP (`resync`): on ChatEventSource.onLive / onResume, for every
 * channel with an open window (debounced, one at a time per channel):
 * `getChanges` from the cursor, following `hasMore`. A cached channel without
 * window catches up when a window opens again. Live events that arrive
 * meanwhile are applied too. Catch-up never plays sounds or alerts.
 *
 * SENDING: createMessage inserts the pending item synchronously
 * (`sendStatus: 'sending'`, `createdAt` = local send time, no syncSeq). It is
 * resolved by id by whichever comes first: the API response, a live `new`
 * event, or a page containing the id. Failure or SEND_TIMEOUT_MS ->
 * `error-send` (kept until retried or discarded, body and attachments
 * preserved; a late success still resolves it). A retry reuses the id
 * (idempotent create). A send confirmed while the channel's first sync (no
 * latest segment yet) is in flight stays pending and is queued with the
 * buffered live events: it is inserted after the reset (when the reset page
 * does not contain it already), so a snapshot older than the send cannot
 * lose it.
 * EDIT: an overlay on the server item (`sendStatus: 'sending'`, new body,
 * attachments, parentMessageId). Success applies the edit as a partial
 * update with the response's `syncSeq`/`updatedAt` and clears `sendStatus`.
 * The overlay is dropped only once that response partial was applied, or
 * once a FULL version with `syncSeq >= response.syncSeq` is stored (without
 * seq: on the response). A newer partial from someone else (e.g. a
 * reaction) does not drop it. Failure -> `error-update`.
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
   * `undefined` only when it is deleted or the server says it does not
   * exist. A network error produces no callback; the fetch is retried on the
   * next live signal.
   */
  watchMessage(
    channelId: string,
    messageId: string,
    onChange: (message: Models.Message.Message | undefined) => void,
    /** optional: a failed fetch for this watcher's message (retried on the next live signal) */
    onError?: (error: unknown) => void,
  ): Unsubscribe;

  /**
   * Send. Resolves once the pending item is inserted (synchronously, before
   * the API call) and never rejects: the outcome is reported only through
   * the item's `sendStatus` in the windows (`error-send` -> retrySend /
   * discardPending). Same call-site semantics as today.
   */
  createMessage(message: NewMessage, options?: { moderation?: boolean }): Promise<void>;
  /** re-send a failed send (same id) or a failed edit; same semantics as createMessage */
  retrySend(channelId: string, messageId: string): Promise<void>;
  /** drop a failed or pending send, or revert a failed edit overlay */
  discardPending(channelId: string, messageId: string): void;
  /** like createMessage: resolves once the overlay is shown, never rejects; failure = `error-update` */
  editMessage(
    message: Models.Message.Message,
    update: Pick<Models.Message.Message, 'body' | 'attachments' | 'parentMessageId'>,
  ): Promise<void>;
  /** delete on the server; tombstones the id on success without waiting for the event; rejects on failure */
  deleteMessage(channelId: string, messageId: string, creatorId: string): Promise<void>;
  /** reactions reject on failure (no item state for them) */
  setReaction(channelId: string, messageId: string, reaction: string): Promise<void>;
  unsetReaction(channelId: string, messageId: string): Promise<void>;

  /** drop everything of a channel (left community, closed chat); was deleteChannelDatabase */
  forgetChannel(channelId: string): void;
  /** logout: drop all channels, windows get an empty reset, watchers `undefined` (then refetched) */
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
  /** channel syncSeq of the last trusted server count; 0 = unknown */
  seq: number;
  /**
   * syncSeqs (> seq) of live messages already counted into `unread` since
   * that server count; ascending, at most COUNTED_SEQS_MAX (the highest).
   * Truncation is an accepted approximation: a duplicate event below the
   * lowest kept seq can be counted twice until the next server count.
   */
  counted: number[];
  /** max of every value ever seen (ISO) */
  lastMessageDate: string | null;
};

/**
 * Every source of read-state information. All merges go through one pure
 * function (exported by the store-core slice as
 * `mergeReadState(stored: ChannelReadState | undefined, input: ReadStateInput): ChannelReadState`,
 * in src/data/chat/mergeReadState.ts) that both the in-memory ReadStateStore and
 * the Dexie writers (community/chat DBs, inside their transaction) use, so
 * several tabs applying the same inputs converge.
 *
 * Rules ("stored" = the record before this merge; "null" lastRead counts
 * as oldest; dates compared by Date.parse):
 * - Always `lastRead := max(stored, input)`.
 * - `snapshot` WITH syncSeq S: taken when its lastRead >= stored lastRead and
 *   S >= stored seq: `unread := snap.unread + counted.filter(s => s > S).length`,
 *   `seq := S`, `counted := counted.filter(s => s > S)`. Otherwise the stored
 *   count stays (the snapshot is older than a local mark or another
 *   snapshot). `lastMessageDate := max`.
 * - `snapshot` WITHOUT syncSeq (login response, getOwnCommunities, getChats,
 *   community/chat events): sets `unread` only while stored `seq === 0`,
 *   only if its lastRead >= stored lastRead, and only if its lastMessageDate
 *   >= stored lastMessageDate (otherwise it predates a live message already
 *   counted); never changes `seq`/`counted`. `lastMessageDate := max`.
 * - `lastRead` (cliChannelLastRead, setChannelLastRead response, own mark):
 *   its `unread` is trusted only with a `syncSeq` >= stored seq and a lastRead
 *   >= stored lastRead; then handled like a seq'd snapshot. Without syncSeq,
 *   only the lastRead is merged.
 * - `message` (live `new` of another user, or own via onOwnMessage):
 *   own -> `lastRead := max(lastRead, createdAt)` (the server marks own posts
 *   read). Other -> counts +1 only if `createdAt > lastRead` and, with a
 *   syncSeq s, `s > seq && !counted.includes(s)` (then s is added to
 *   `counted`); without a syncSeq (old server) only if
 *   `createdAt > lastMessageDate`. AFTER that decision, always
 *   `lastMessageDate := max(lastMessageDate, createdAt)`.
 * - Finally, if lastRead >= lastMessageDate: `unread := 0`, `counted := []`.
 *   `unread` is capped at API.Messages.UnreadCap.
 * Between server counts the value is approximate; the next seq'd snapshot
 * corrects it without losing messages counted live during its round trip.
 */
export type ReadStateInput = {
  kind: 'snapshot';
  channelId: string;
  lastRead: string | null;
  unread: number;
  /** from getSyncState; absent for the older snapshots */
  syncSeq?: number;
  lastMessageDate: string | null;
} | {
  kind: 'lastRead';
  channelId: string;
  lastRead: string;
  unread?: number;
  syncSeq?: number;
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
 * Marking: the channel is marked read up to `newest.createdAt` while ANY of
 * its markers has `atLatest && atBottom && newest`, AND
 * ChatEventSource.visible AND a user is logged in. Re-evaluated on every
 * marker update, visibility change and user change: a level, not an edge.
 * Sent only if newer than max(server-acknowledged lastRead, last value the
 * server accepted from this tab) — not the merged local lastRead, which also
 * holds own marks and persisted local values (display only), so a mark whose
 * call never landed is sent again. Acknowledged: getSyncState snapshots,
 * cliChannelLastRead, setChannelLastRead responses, own posts; via `apply`
 * only inputs with a syncSeq (or own posts). The first call
 * immediately, then a trailing throttle of MARK_READ_THROTTLE_MS. While
 * logged out or failing, the value stays pending and is sent on the next
 * login, live signal or trigger. `messageId` (= `newest.id`) is added once
 * the server has shown chat-sync support in this page load; if the server
 * still rejects it in validation, the call is retried without it and
 * `messageId` is not sent again in this page load. The response is applied
 * as a `lastRead` input. No IntersectionObserver, no DOM timestamps.
 *
 * Catch-up: on onLive / onResume it calls `getSyncState` and applies every
 * entry as a `snapshot` input (with syncSeq).
 *
 * Events: it subscribes itself to onLastReadEvent (`lastRead` input) and to
 * `new` message events of other users (`message` input) of channels that
 * already have a read state or a registered access with `communityId` or
 * `chatId`. Own messages arrive through ChannelStoreDeps.onOwnMessage (and
 * own `new` events from other tabs/devices). The older snapshots are fed in
 * by their owners through `apply`.
 */
export interface ReadStateStore {
  get(channelId: string): ChannelReadState | undefined;
  /** listener gets every changed channel state */
  subscribe(listener: (state: ChannelReadState) => void): Unsubscribe;
  /** merge one input (in memory and via persistence); returns the merged state */
  apply(input: ReadStateInput): ChannelReadState;
  /**
   * Mirror a state that is already persisted (a merged community/chat row)
   * into memory: like a seq'd snapshot when it carries a seq (its `counted`
   * seqs kept, so duplicates are not counted twice), else like a seq-less
   * one. Memory only; never counts as server-acknowledged for sending.
   */
  applyStored(state: ChannelReadState): ChannelReadState;
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
 * Count: from the server only, never `++`/`--`. Sources: login response
 * (`Number()` it), `unreadCount` of notification events,
 * `getUnreadCount({ withTime: true })` on resync (onLive / onResume), after
 * markAsRead/markAllAsRead, and (debounced) whenever an event lacks
 * `unreadCount` (old server). The newest count wins: a count with
 * `unreadCountAt` is taken only if that time is >= the stored one; a count
 * without a time (login response, old server) is taken when it arrives and
 * makes the stored time unknown (any timed count wins next).
 *
 * List (`openList`): first page on `init('recent')` (one fetch even if init
 * is called twice), the newest page again on resync while open (a resync
 * while no window is open makes the next `init` reload it). Live events
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
