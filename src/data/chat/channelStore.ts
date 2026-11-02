// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * In-memory message store of one tab (contract: ChannelStore in ./types.ts).
 * Pure TypeScript: the API, the event source, the clock and the id source are
 * injected. Everything that changes a channel's data ends in `notify()`,
 * which recomputes every window and watcher of that channel and calls their
 * listeners synchronously.
 */

import {
  CHANNEL_LRU_SIZE,
  GAP_RESYNC_DEBOUNCE_MS,
  GET_CHANGES_LIMIT,
  LATEST_SEGMENT_MAX,
  PAGE_SIZE,
  SEND_TIMEOUT_MS,
  WINDOW_ERROR,
  type ChannelStore,
  type ChannelStoreDeps,
  type ChannelWindow,
  type NewMessage,
  type Unsubscribe,
  type WindowChange,
  type WindowListener,
} from './types';
import {
  applyPartial,
  compareMessages,
  fromApiMessage,
  fromUpdateEvent,
  fullVerdict,
  keyOf,
  partialVerdict,
  type Key,
  type MessagePartial,
  type VersionVerdict,
} from './messageVersion';
import { isHttpNotFound, Timer } from './util';

type Message = Models.Message.Message;
type State = Models.ItemList.ItemListState<Message>;
type Access = API.Messages.MessageAccess;

/** coalesces onLive/onResume bursts into one catch-up round */
export const RESYNC_DEBOUNCE_MS = 50;

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

/** a contiguous run of server messages, ascending by (createdAt, id) */
class Segment {
  items: Message[] = [];
  /** the oldest message of the channel is included */
  startsAtBeginning = false;
}

/** first index with key >= k */
function lowerBound(items: Message[], k: Key): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareMessages(items[mid], k) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** first index with key > k */
function upperBound(items: Message[], k: Key): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compareMessages(items[mid], k) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function insertSorted(seg: Segment, m: Message): void {
  seg.items.splice(upperBound(seg.items, m), 0, m);
}

// ---------------------------------------------------------------------------
// Per-channel data
// ---------------------------------------------------------------------------

type PendingSend = {
  message: Message;
  moderation: boolean;
  attempt: number;
  timer: Timer;
};

type EditOverlay = {
  update: Pick<Message, 'body' | 'attachments' | 'parentMessageId'>;
  editedAt: string;
  /** undefined once the server confirmed the edit (overlay waits for a full version >= awaitSeq) */
  sendStatus: 'sending' | 'error-update' | undefined;
  awaitSeq?: number;
  attempt: number;
  timer: Timer;
  cache?: { base: Message; status: EditOverlay['sendStatus']; out: Message };
};

const UNSET = Symbol('unset');

type BufferedItem = { event: Events.Message.Message } | { own: Message };

type Watcher = {
  onChange: (message: Message | undefined) => void;
  last: Message | undefined | typeof UNSET;
};

class ChannelData {
  alive = true;
  latest: Segment | null = null;
  detached: Segment[] = [];
  loose = new Map<string, Message>();
  tombstones = new Set<string>();
  pending = new Map<string, PendingSend>();
  overlays = new Map<string, EditOverlay>();
  /** contiguous applied high-water mark; null = never synced */
  seenSeq: number | null = null;
  /** applied seqs above seenSeq */
  recorded = new Set<number>();
  windows = new Set<WindowImpl>();
  watchers = new Map<string, Set<Watcher>>();
  /** watched ids whose fetch is still due (not in memory, not known missing) */
  watchFetchDue = new Set<string>();
  watchFetching = new Set<string>();
  gapTimer: Timer;
  syncing: Promise<void> | null = null;
  syncAgain = false;
  /**
   * live events and confirmed own sends held back while the first sync (no
   * latest segment yet) is in flight; replayed after it
   */
  buffer: BufferedItem[] | null = null;
  lastUsed = 0;

  constructor(readonly id: string, clock: ChannelStoreDeps['clock']) {
    this.gapTimer = new Timer(clock);
  }

  segments(): Segment[] {
    return this.latest ? [this.latest, ...this.detached] : [...this.detached];
  }

  get pinned(): boolean {
    return this.windows.size > 0 || this.watchers.size > 0 || this.pending.size > 0;
  }

  locate(id: string): { seg: Segment; index: number } | { loose: Message } | null {
    for (const seg of this.segments()) {
      const index = seg.items.findIndex(m => m.id === id);
      if (index >= 0) return { seg, index };
    }
    const loose = this.loose.get(id);
    return loose ? { loose } : null;
  }

  stored(id: string): Message | undefined {
    const loc = this.locate(id);
    if (!loc) return undefined;
    return 'loose' in loc ? loc.loose : loc.seg.items[loc.index];
  }

  /** replace the stored copy of `next.id` wherever it is */
  replace(next: Message): void {
    const loc = this.locate(next.id);
    if (!loc) return;
    if ('loose' in loc) {
      this.loose.set(next.id, next);
    } else if (loc.seg.items[loc.index].createdAt.getTime() === next.createdAt.getTime()) {
      loc.seg.items[loc.index] = next;
    } else {
      loc.seg.items.splice(loc.index, 1);
      insertSorted(loc.seg, next);
    }
  }

  /** is the latest segment's range (or the whole channel) covering `m`? */
  latestCovers(m: Pick<Message, 'createdAt' | 'id'>): boolean {
    const latest = this.latest;
    if (!latest) return false;
    if (latest.startsAtBeginning) return true;
    return latest.items.length > 0 && compareMessages(m, latest.items[0]) >= 0;
  }
}

function emptyState(ready: boolean, destroyed: boolean): State {
  return {
    items: [],
    isDestroyed: destroyed,
    ready,
    rangeStart: null,
    rangeEnd: null,
    hasNextItemsLocally: false,
    hasNextItemsOnRemote: false,
    hasPreviousItemsLocally: false,
    hasPreviousItemsOnRemote: false,
    withStartOfList: false,
    withEndOfList: false,
    isEmpty: false,
  };
}

const STATE_FLAGS: (keyof State)[] = [
  'isDestroyed', 'ready', 'hasNextItemsLocally', 'hasNextItemsOnRemote', 'hasPreviousItemsLocally',
  'hasPreviousItemsOnRemote', 'withStartOfList', 'withEndOfList', 'isEmpty',
];

function superseded(): Error {
  return new Error(WINDOW_ERROR.SUPERSEDED);
}

function notFound(): Error {
  return new Error(WINDOW_ERROR.NOT_FOUND);
}

function iso(d: Date): string {
  return d.toISOString();
}

const noop = () => undefined;

// ---------------------------------------------------------------------------
// Window
// ---------------------------------------------------------------------------

class WindowImpl implements ChannelWindow {
  ch: ChannelData;
  seg: Segment | null = null;
  /** bounds of the visible slice; null = from the segment start / to the segment end */
  from: Key | null = null;
  to: Key | null = null;
  ready = false;
  destroyed = false;
  gen = 0;
  /** bumped whenever the slice is re-pointed under the window (reset); in-flight pages are dropped */
  epoch = 0;
  state: State = emptyState(false, false);
  serverCount = 0;
  pendingCount = 0;
  lastInit: Models.ItemList.ItemListInitOptions | undefined;
  private listeners = new Set<WindowListener<Message>>();
  private aborters = new Set<(e: Error) => void>();
  private loadingOlder: Promise<void> | undefined;
  private loadingNewer: Promise<void> | undefined;

  constructor(private readonly store: ChannelStoreImpl, ch: ChannelData) {
    this.ch = ch;
  }

  get channelId(): string {
    return this.ch.id;
  }

  subscribe(listener: WindowListener<Message>): Unsubscribe {
    if (this.destroyed) return noop;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(state: State, change: WindowChange): void {
    for (const l of [...this.listeners]) l(state, change);
  }

  /** reject every awaited step of an older init */
  supersede(): number {
    const err = superseded();
    for (const abort of [...this.aborters]) abort(err);
    this.aborters.clear();
    return ++this.gen;
  }

  /** await `p` unless superseded meanwhile */
  guard<T>(gen: number, p: Promise<T>): Promise<T> {
    if (gen !== this.gen) return Promise.reject(superseded());
    return new Promise<T>((resolve, reject) => {
      const abort = (e: Error) => reject(e);
      this.aborters.add(abort);
      p.then(
        v => {
          this.aborters.delete(abort);
          if (gen !== this.gen) reject(superseded());
          else resolve(v);
        },
        e => {
          this.aborters.delete(abort);
          reject(gen !== this.gen ? superseded() : e);
        },
      );
    });
  }

  async init(options: Models.ItemList.ItemListInitOptions): Promise<number> {
    if (this.destroyed) throw superseded();
    const gen = this.supersede();
    this.lastInit = options;
    return this.store.initWindow(this, options, gen);
  }

  loadOlder(count: number = PAGE_SIZE): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (!this.loadingOlder) {
      this.loadingOlder = this.store.loadOlder(this, count).finally(() => {
        this.loadingOlder = undefined;
      });
    }
    return this.loadingOlder;
  }

  loadNewer(count: number = PAGE_SIZE): Promise<void> {
    if (this.destroyed) return Promise.resolve();
    if (!this.loadingNewer) {
      this.loadingNewer = this.store.loadNewer(this, count).finally(() => {
        this.loadingNewer = undefined;
      });
    }
    return this.loadingNewer;
  }

  trim(options: { keep: number; from: 'start' | 'end' }): void {
    if (this.destroyed) return;
    this.store.trimWindow(this, options);
  }

  async jumpToLatest(): Promise<void> {
    if (this.destroyed) return;
    const gen = this.supersede();
    await this.store.jumpToLatest(this, gen);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.supersede();
    this.destroyed = true;
    this.state = { ...emptyState(false, true) };
    this.listeners.clear();
    this.store.releaseWindow(this);
  }
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

type NotifyHints = Map<WindowImpl, WindowChange>;

type Placement = { kind: 'segment'; seg: Segment } | { kind: 'live' };

type LatestAnchor = { seg: Segment | null; first: Key | undefined };

class ChannelStoreImpl implements ChannelStore {
  private readonly channels = new Map<string, ChannelData>();
  private readonly access = new Map<string, Access>();
  private readonly accessWaiters = new Map<string, Set<{ resolve: (a: Access) => void; reject: (e: Error) => void }>>();
  /** `getChanges` answered 404 in this page load: use loadMessages-based reconcile */
  private fallback = false;
  private useCounter = 0;
  private readonly resyncTimer: Timer;
  private readonly unsubs: Unsubscribe[] = [];
  private disposed = false;

  constructor(private readonly deps: ChannelStoreDeps) {
    this.resyncTimer = new Timer(deps.clock);
    const { events } = deps;
    this.unsubs.push(
      events.onMessageEvent(e => this.onMessageEvent(e)),
      events.onLive(() => this.scheduleResync()),
      events.onResume(() => this.scheduleResync()),
    );
  }

  // ----- access ------------------------------------------------------------

  registerAccessForChannel(access: Access): void {
    this.access.set(access.channelId, access);
    const waiters = this.accessWaiters.get(access.channelId);
    if (waiters) {
      this.accessWaiters.delete(access.channelId);
      for (const w of waiters) w.resolve(access);
    }
  }

  getAccessForChannel(channelId: string): Access | undefined {
    return this.access.get(channelId);
  }

  private waitAccess(channelId: string): Promise<Access> {
    const known = this.access.get(channelId);
    if (known) return Promise.resolve(known);
    if (this.disposed) return Promise.reject(new Error('ChannelStore disposed'));
    return new Promise<Access>((resolve, reject) => {
      let set = this.accessWaiters.get(channelId);
      if (!set) {
        set = new Set();
        this.accessWaiters.set(channelId, set);
      }
      set.add({ resolve, reject });
    });
  }

  private requireAccess(channelId: string): Access {
    const access = this.access.get(channelId);
    if (!access) throw new Error('ChannelAccess has not been set up');
    return access;
  }

  // ----- channel lifecycle -------------------------------------------------

  private getOrCreate(channelId: string): ChannelData {
    let ch = this.channels.get(channelId);
    if (!ch) {
      ch = new ChannelData(channelId, this.deps.clock);
      this.channels.set(channelId, ch);
    }
    ch.lastUsed = ++this.useCounter;
    return ch;
  }

  private evict(): void {
    const unpinned = [...this.channels.values()].filter(ch => !ch.pinned);
    if (unpinned.length <= CHANNEL_LRU_SIZE) return;
    unpinned.sort((a, b) => a.lastUsed - b.lastUsed);
    for (const ch of unpinned.slice(0, unpinned.length - CHANNEL_LRU_SIZE)) this.dropChannel(ch);
  }

  private dropChannel(ch: ChannelData): void {
    ch.alive = false;
    ch.gapTimer.clear();
    for (const p of ch.pending.values()) p.timer.clear();
    for (const o of ch.overlays.values()) o.timer.clear();
    if (this.channels.get(ch.id) === ch) this.channels.delete(ch.id);
  }

  /** for tests: is the channel cached? */
  hasChannel(channelId: string): boolean {
    return this.channels.has(channelId);
  }

  openWindow(channelId: string): ChannelWindow {
    const ch = this.getOrCreate(channelId);
    const w = new WindowImpl(this, ch);
    ch.windows.add(w);
    this.evict();
    return w;
  }

  releaseWindow(w: WindowImpl): void {
    w.ch.windows.delete(w);
    w.ch.lastUsed = ++this.useCounter;
    this.enforceLatestMax(w.ch);
    this.evict();
  }

  forgetChannel(channelId: string): void {
    const ch = this.channels.get(channelId);
    if (!ch) return;
    this.replaceChannel(ch, false);
  }

  clear(): void {
    this.resyncTimer.clear();
    for (const ch of [...this.channels.values()]) this.replaceChannel(ch, true);
  }

  /** drop a channel's data; windows get an empty reset, watchers move to a fresh channel */
  private replaceChannel(ch: ChannelData, refetchWatched: boolean): void {
    this.dropChannel(ch);
    if (ch.windows.size === 0 && ch.watchers.size === 0) return;
    const fresh = this.getOrCreate(ch.id);
    for (const w of ch.windows) {
      w.supersede();
      w.ch = fresh;
      w.seg = null;
      w.from = null;
      w.to = null;
      fresh.windows.add(w);
    }
    for (const [id, set] of ch.watchers) {
      fresh.watchers.set(id, set);
      if (refetchWatched) fresh.watchFetchDue.add(id);
    }
    const hints: NotifyHints = new Map();
    for (const w of fresh.windows) hints.set(w, { kind: 'reset', cause: 'resync' });
    this.notify(fresh, hints);
    if (refetchWatched) this.fetchWatched(fresh);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.resyncTimer.clear();
    for (const ch of [...this.channels.values()]) this.dropChannel(ch);
    const err = new Error('ChannelStore disposed');
    for (const set of this.accessWaiters.values()) for (const w of set) w.reject(err);
    this.accessWaiters.clear();
  }

  // ----- notify ------------------------------------------------------------

  private render(ch: ChannelData, m: Message): Message {
    const ov = ch.overlays.get(m.id);
    if (!ov) return m;
    if (ov.cache && ov.cache.base === m && ov.cache.status === ov.sendStatus) return ov.cache.out;
    const out: Message = {
      ...m,
      body: ov.update.body,
      attachments: ov.update.attachments,
      parentMessageId: ov.update.parentMessageId,
      editedAt: ov.editedAt,
    };
    if (ov.sendStatus) out.sendStatus = ov.sendStatus;
    else delete out.sendStatus;
    ov.cache = { base: m, status: ov.sendStatus, out };
    return out;
  }

  computeState(w: WindowImpl): { state: State; serverCount: number; pendingCount: number } {
    if (w.destroyed) return { state: emptyState(false, true), serverCount: 0, pendingCount: 0 };
    const ch = w.ch;
    const seg = w.seg;
    if (!seg) return { state: emptyState(w.ready, false), serverCount: 0, pendingCount: 0 };
    const all = seg.items;
    const startIdx = w.from ? lowerBound(all, w.from) : 0;
    const endIdx = Math.max(startIdx, w.to ? upperBound(all, w.to) : all.length);
    const visible = all.slice(startIdx, endIdx).map(m => this.render(ch, m));
    const atEnd = seg === ch.latest && w.to === null;
    const pending = atEnd ? [...ch.pending.values()].map(p => p.message) : [];
    const withStartOfList = startIdx === 0 && seg.startsAtBeginning;
    const state: State = {
      items: pending.length ? [...visible, ...pending] : visible,
      isDestroyed: false,
      ready: w.ready,
      rangeStart: visible.length ? visible[0].createdAt : null,
      rangeEnd: visible.length ? visible[visible.length - 1].createdAt : null,
      hasPreviousItemsLocally: startIdx > 0,
      hasPreviousItemsOnRemote: !seg.startsAtBeginning,
      hasNextItemsLocally: endIdx < all.length,
      hasNextItemsOnRemote: seg !== ch.latest,
      withStartOfList,
      withEndOfList: atEnd,
      isEmpty: w.ready && visible.length === 0 && withStartOfList && atEnd,
    };
    return { state, serverCount: visible.length, pendingCount: pending.length };
  }

  private diffKind(prev: State, prevServer: number, prevPending: number, next: State, nextServer: number, nextPending: number): WindowChange | null {
    const a = prev.items;
    const b = next.items;
    const flagsSame = STATE_FLAGS.every(f => prev[f] === next[f]);
    if (flagsSame && a.length === b.length && a.every((m, i) => m === b[i])) return null;
    if (b.length > a.length && prev.withEndOfList && next.withEndOfList) {
      let prefix = true;
      for (let i = 0; i < prevServer && prefix; i++) prefix = a[i].id === b[i].id;
      for (let i = 0; i < prevPending && prefix; i++) prefix = a[prevServer + i].id === b[nextServer + i].id;
      if (prefix && nextServer >= prevServer && nextPending >= prevPending) {
        return { kind: 'append-live', count: b.length - a.length, own: nextPending > prevPending };
      }
    }
    if (b.length > a.length && nextPending === prevPending) {
      const shift = nextServer - prevServer;
      let suffix = shift > 0;
      for (let i = 0; i < prevServer && suffix; i++) suffix = a[i].id === b[i + shift].id;
      if (suffix) return { kind: 'prepend', count: shift };
    }
    return { kind: 'update' };
  }

  /** recompute every window and watcher of the channel; listeners run synchronously */
  notify(ch: ChannelData, hints?: NotifyHints): void {
    if (this.disposed) return;
    for (const w of [...ch.windows]) {
      if (w.destroyed || w.ch !== ch) continue;
      const { state, serverCount, pendingCount } = this.computeState(w);
      const explicit = hints?.get(w);
      const change = explicit ?? this.diffKind(w.state, w.serverCount, w.pendingCount, state, serverCount, pendingCount);
      // a slice bound that follows the segment start is pinned to the first item, so
      // trimming and late older inserts do not change what the window shows
      if (w.seg && w.from === null && serverCount > 0) w.from = keyOf(state.items[0]);
      if (!change) continue;
      w.state = state;
      w.serverCount = serverCount;
      w.pendingCount = pendingCount;
      w.emit(state, change);
    }
    for (const [id, set] of ch.watchers) {
      const current = this.watchedValue(ch, id);
      if (current === UNSET) continue;
      for (const watcher of [...set]) {
        if (watcher.last === current) continue;
        watcher.last = current;
        watcher.onChange(current);
      }
    }
  }

  private watchedValue(ch: ChannelData, id: string): Message | undefined | typeof UNSET {
    if (ch.tombstones.has(id)) return undefined;
    const stored = ch.stored(id);
    if (stored) return this.render(ch, stored);
    return UNSET;
  }

  // ----- version-rule writes ----------------------------------------------

  /** a server copy of an own pending send arrived: drop the pending item */
  private resolvePending(ch: ChannelData, m: Message): void {
    const p = ch.pending.get(m.id);
    if (!p) return;
    p.timer.clear();
    ch.pending.delete(m.id);
    if (!ch.tombstones.has(m.id)) this.deps.onOwnMessage?.(m);
  }

  private dropOverlayOnFull(ch: ChannelData, m: Message): void {
    const ov = ch.overlays.get(m.id);
    if (!ov || ov.sendStatus !== undefined || ov.awaitSeq === undefined) return;
    if (m.syncSeq !== undefined && m.syncSeq >= ov.awaitSeq) {
      ov.timer.clear();
      ch.overlays.delete(m.id);
    }
  }

  /**
   * Store a FULL version. `live` inserts unknown ids into the latest segment
   * if it covers them; `segment` inserts them into that segment.
   */
  private upsertFull(ch: ChannelData, m: Message, placement: Placement): VersionVerdict | 'tombstoned' | 'unheld' {
    this.resolvePending(ch, m);
    if (ch.tombstones.has(m.id)) return 'tombstoned';
    const loc = ch.locate(m.id);
    if (loc) {
      const stored = 'loose' in loc ? loc.loose : loc.seg.items[loc.index];
      const verdict = fullVerdict(m, stored);
      if (verdict === 'apply') ch.replace(m);
      if (verdict !== 'older') this.dropOverlayOnFull(ch, m);
      if ('loose' in loc && placement.kind === 'segment') {
        // a loose item that a page now covers moves into the segment
        ch.loose.delete(m.id);
        insertSorted(placement.seg, verdict === 'older' ? stored : m);
      }
      return verdict;
    }
    if (placement.kind === 'segment') {
      insertSorted(placement.seg, m);
      return 'apply';
    }
    if (ch.latestCovers(m)) {
      insertSorted(ch.latest!, m);
      return 'apply';
    }
    return 'unheld';
  }

  private applyPartialUpdate(ch: ChannelData, partial: MessagePartial): VersionVerdict | 'tombstoned' | 'unheld' {
    if (ch.tombstones.has(partial.id)) return 'tombstoned';
    const stored = ch.stored(partial.id);
    if (!stored) return 'unheld';
    const verdict = partialVerdict(partial, stored);
    if (verdict === 'apply') ch.replace(applyPartial(stored, partial));
    return verdict;
  }

  private tombstone(ch: ChannelData, ids: string[]): void {
    for (const id of ids) {
      ch.tombstones.add(id);
      for (const seg of ch.segments()) {
        const i = seg.items.findIndex(m => m.id === id);
        if (i >= 0) seg.items.splice(i, 1);
      }
      ch.loose.delete(id);
      const ov = ch.overlays.get(id);
      if (ov) {
        ov.timer.clear();
        ch.overlays.delete(id);
      }
      const p = ch.pending.get(id);
      if (p) {
        p.timer.clear();
        ch.pending.delete(id);
      }
      ch.watchFetchDue.delete(id);
    }
  }

  // ----- cursor ------------------------------------------------------------

  private record(ch: ChannelData, seq: number | undefined): void {
    if (seq === undefined || ch.seenSeq === null || seq <= ch.seenSeq) return;
    ch.recorded.add(seq);
    this.advance(ch);
  }

  private advance(ch: ChannelData): void {
    if (ch.seenSeq === null) return;
    while (ch.recorded.has(ch.seenSeq + 1)) {
      ch.recorded.delete(ch.seenSeq + 1);
      ch.seenSeq++;
    }
    for (const s of ch.recorded) if (s <= ch.seenSeq) ch.recorded.delete(s);
    if (ch.recorded.size === 0) {
      ch.gapTimer.clear();
    } else {
      ch.gapTimer.ensure(GAP_RESYNC_DEBOUNCE_MS, () => this.onGapTimer(ch));
    }
  }

  private onGapTimer(ch: ChannelData): void {
    if (!ch.alive || ch.recorded.size === 0 || ch.windows.size === 0) return;
    this.sync(ch).catch(noop);
  }

  /** for tests and the façade: the request cursor of a channel */
  getCursor(channelId: string): API.Messages.SyncCursor | null {
    const ch = this.channels.get(channelId);
    return ch && ch.seenSeq !== null ? `1:${ch.seenSeq}` : null;
  }

  // ----- live events -------------------------------------------------------

  private onMessageEvent(event: Events.Message.Message): void {
    if (this.disposed) return;
    const ch = this.channels.get(event.data.channelId);
    if (!ch) return;
    if (ch.buffer) {
      ch.buffer.push({ event });
      return;
    }
    this.applyMessageEvent(ch, event);
    this.enforceLatestMax(ch);
    this.notify(ch);
  }

  private applyMessageEvent(ch: ChannelData, event: Events.Message.Message): void {
    switch (event.action) {
      case 'new': {
        const m = fromApiMessage(event.data);
        const verdict = this.upsertFull(ch, m, { kind: 'live' });
        if (verdict !== 'older') this.record(ch, m.syncSeq);
        break;
      }
      case 'update': {
        const partial = fromUpdateEvent(event.data);
        const verdict = this.applyPartialUpdate(ch, partial);
        if (verdict !== 'older') this.record(ch, partial.syncSeq);
        break;
      }
      case 'delete': {
        this.tombstone(ch, event.data.deletedIds);
        const seqs = event.data.syncSeqs ?? (event.data.syncSeq !== undefined ? [event.data.syncSeq] : []);
        for (const s of seqs) this.record(ch, s);
        break;
      }
    }
  }

  // ----- catch-up ----------------------------------------------------------

  private scheduleResync(): void {
    if (this.disposed) return;
    this.resyncTimer.start(RESYNC_DEBOUNCE_MS, () => this.resyncAll());
  }

  private resyncAll(): void {
    for (const ch of [...this.channels.values()]) {
      if (ch.windows.size > 0) {
        this.sync(ch).catch(noop);
      } else {
        // no catch-up runs for this channel: refresh what is watched (pins, reply parents)
        for (const id of ch.watchers.keys()) if (!ch.tombstones.has(id)) ch.watchFetchDue.add(id);
      }
      if (ch.watchFetchDue.size > 0) this.fetchWatched(ch);
    }
  }

  /**
   * Catch up one channel: getChanges from the cursor (following hasMore), or
   * the loadMessages reconcile against old servers. One at a time per
   * channel; a call during a running sync runs it once more afterwards
   * (`join` only waits for the running one).
   */
  sync(ch: ChannelData, options: { join?: boolean } = {}): Promise<void> {
    if (ch.syncing) {
      if (!options.join) ch.syncAgain = true;
      return ch.syncing;
    }
    const run = async () => {
      try {
        do {
          ch.syncAgain = false;
          await this.syncOnce(ch);
        } while (ch.syncAgain && ch.alive);
      } finally {
        ch.syncing = null;
      }
    };
    ch.syncing = run();
    return ch.syncing;
  }

  private async syncOnce(ch: ChannelData): Promise<void> {
    const access = await this.waitAccess(ch.id);
    if (!ch.alive) return;
    const first = ch.latest === null;
    if (first) ch.buffer = ch.buffer ?? [];
    try {
      if (!this.fallback) {
        try {
          let more = true;
          while (more && ch.alive) {
            const cursorSeq = ch.seenSeq === null || ch.latest === null ? null : ch.seenSeq;
            const cursor: API.Messages.SyncCursor | null = cursorSeq === null ? null : `1:${cursorSeq}`;
            const resp = await this.deps.api.getChanges({ access, cursor, limit: GET_CHANGES_LIMIT });
            if (!ch.alive || this.disposed) return;
            if (resp.reset) this.applyReset(ch, resp.messages.map(fromApiMessage), resp.messages.length < PAGE_SIZE, resp.syncSeq);
            else this.applyChanges(ch, resp);
            // follow hasMore only while the server makes progress
            more = resp.hasMore && !resp.reset && cursorSeq !== null && resp.syncSeq > cursorSeq;
          }
          return;
        } catch (e) {
          if (!isHttpNotFound(e)) throw e;
          this.fallback = true;
        }
      }
      const page = await this.deps.api.loadMessages({ access, order: 'DESC' });
      if (!ch.alive || this.disposed) return;
      this.applyFallbackPage(ch, page.map(fromApiMessage));
    } finally {
      const buffered = ch.buffer;
      ch.buffer = null;
      if (buffered && ch.alive && !this.disposed) {
        for (const item of buffered) {
          if ('event' in item) {
            this.applyMessageEvent(ch, item.event);
          } else {
            const verdict = this.upsertFull(ch, item.own, { kind: 'live' });
            if (verdict !== 'older') this.record(ch, item.own.syncSeq);
          }
        }
        this.enforceLatestMax(ch);
        this.notify(ch);
      }
    }
  }

  private applyChanges(ch: ChannelData, resp: API.Messages.getChanges.Response): void {
    for (const api of resp.messages) this.upsertFull(ch, fromApiMessage(api), { kind: 'live' });
    this.tombstone(ch, resp.deletedIds);
    ch.seenSeq = Math.max(ch.seenSeq ?? 0, resp.syncSeq);
    this.advance(ch);
    this.enforceLatestMax(ch);
    this.notify(ch);
  }

  /**
   * Replace the latest segment with a snapshot page (reset rule). `seq` is
   * the snapshot's channel seq; without one (old-server fallback) local items
   * newer than the page are kept instead.
   */
  private applyReset(ch: ChannelData, rawPage: Message[], reachesStart: boolean, seq: number | undefined): void {
    const page = rawPage.filter(m => !ch.tombstones.has(m.id)).sort(compareMessages);
    const old = ch.latest;
    const first = old === null;
    const next = new Segment();
    next.startsAtBeginning = reachesStart;
    for (const m of page) this.resolvePending(ch, m);
    next.items = page;
    const pageOldest = page[0];
    const pageNewest = page[page.length - 1];
    const keep = (m: Message) => {
      if (seq !== undefined) {
        return (m.syncSeq ?? -1) > seq && (reachesStart || !pageOldest || compareMessages(m, pageOldest) >= 0);
      }
      return !pageNewest || compareMessages(m, pageNewest) > 0;
    };
    const dropped: Message[] = [];
    if (old) {
      for (const m of old.items) {
        if (keep(m)) {
          const i = next.items.findIndex(x => x.id === m.id);
          if (i < 0) insertSorted(next, m);
          else if (fullVerdict(m, next.items[i]) === 'apply') next.items[i] = m;
        } else if (!next.items.some(x => x.id === m.id)) {
          dropped.push(m);
        }
      }
    }
    for (const m of next.items) this.dropOverlayOnFull(ch, m);
    ch.latest = next;
    const hints: NotifyHints = new Map();
    const reinit: WindowImpl[] = [];
    if (first) {
      // first load: detached segments fetched meanwhile stay; join those that meet
      for (const m of next.items) ch.loose.delete(m.id);
      this.mergeIntersecting(ch, next);
    } else {
      // a reset replaces everything the cursor no longer vouches for
      const droppedSegs = new Set(ch.detached);
      for (const seg of ch.detached) dropped.push(...seg.items);
      dropped.push(...ch.loose.values());
      ch.detached = [];
      ch.loose.clear();
      for (const m of dropped) if (ch.watchers.has(m.id)) ch.watchFetchDue.add(m.id);
      for (const w of ch.windows) {
        if (!w.seg) continue;
        if (w.seg === old) {
          const inside = next.startsAtBeginning || w.from === null || (next.items.length > 0 && compareMessages(w.from, next.items[0]) >= 0);
          if (w.to === null || inside) {
            w.seg = next;
            w.epoch++;
            if (!inside) w.from = null;
            hints.set(w, { kind: 'reset', cause: 'resync' });
            continue;
          }
        } else if (!droppedSegs.has(w.seg)) {
          continue;
        }
        reinit.push(w);
      }
    }
    if (seq !== undefined) {
      ch.seenSeq = seq;
      this.advance(ch);
    }
    this.enforceLatestMax(ch);
    this.notify(ch, hints);
    for (const w of reinit) this.reinitDetached(w);
    if (ch.watchFetchDue.size > 0) this.fetchWatched(ch);
  }

  /** old server: merge the latest page, or replace the segment when it does not meet */
  private applyFallbackPage(ch: ChannelData, rawPage: Message[]): void {
    const page = rawPage.sort(compareMessages);
    const reachesStart = page.length < PAGE_SIZE;
    const latest = ch.latest;
    if (latest && (latest.items.length === 0 || page.length === 0 || compareMessages(page[0], latest.items[latest.items.length - 1]) <= 0)) {
      this.applyPage(ch, latest, page, { reachesStart: reachesStart && latest.items.length === 0 });
      this.enforceLatestMax(ch);
      this.notify(ch);
      return;
    }
    this.applyReset(ch, page, reachesStart, undefined);
  }

  /** a window whose data a reset dropped: load around its first visible item as a detached segment */
  private reinitDetached(w: WindowImpl): void {
    const first = w.state.items.find(m => m.sendStatus !== 'sending' && m.sendStatus !== 'error-send');
    const gen = w.supersede();
    const date = first ? first.createdAt : new Date(this.deps.clock.now());
    this.loadAround(w, gen, { date }, 'resync').catch(noop);
  }

  // ----- pages and segments -----------------------------------------------

  private intersects(ch: ChannelData, seg: Segment, lo: Message, hi: Message): boolean {
    if (seg === ch.latest) {
      return seg.startsAtBeginning || (seg.items.length > 0 && compareMessages(hi, seg.items[0]) >= 0);
    }
    if (seg.items.length === 0) return false;
    const first = seg.items[0];
    const last = seg.items[seg.items.length - 1];
    if (compareMessages(lo, last) > 0) return false;
    return seg.startsAtBeginning || compareMessages(hi, first) >= 0;
  }

  /** merge `group` into one segment (the latest one if it is part of it); windows follow */
  private mergeSegments(ch: ChannelData, group: Set<Segment>): Segment {
    if (group.size === 1) return [...group][0];
    const target = ch.latest && group.has(ch.latest) ? ch.latest : [...group][0];
    for (const seg of group) {
      if (seg === target) continue;
      for (const m of seg.items) {
        const i = target.items.findIndex(x => x.id === m.id);
        if (i < 0) insertSorted(target, m);
        else if (fullVerdict(m, target.items[i]) === 'apply') target.items[i] = m;
      }
      if (seg.startsAtBeginning) target.startsAtBeginning = true;
      ch.detached = ch.detached.filter(d => d !== seg);
      for (const w of ch.windows) if (w.seg === seg) w.seg = target;
    }
    return target;
  }

  private mergeIntersecting(ch: ChannelData, seg: Segment): Segment {
    if (seg.items.length === 0 && seg !== ch.latest) return seg;
    const lo = seg.items[0];
    const hi = seg.items[seg.items.length - 1];
    const group = new Set<Segment>([seg]);
    for (const other of ch.segments()) {
      if (other === seg) continue;
      if (seg === ch.latest) {
        if (other.items.length > 0 && (seg.startsAtBeginning || (lo && compareMessages(other.items[other.items.length - 1], lo) >= 0))) group.add(other);
      } else if (lo && hi && this.intersects(ch, other, lo, hi)) {
        group.add(other);
      }
    }
    return this.mergeSegments(ch, group);
  }

  /**
   * Upsert a page into `target`: segments the page touches are merged first,
   * so segments stay disjoint. A page never removes anything.
   */
  private applyPage(
    ch: ChannelData,
    target: Segment,
    rawPage: Message[],
    flags: { reachesStart?: boolean; reachesEnd?: boolean; latestAnchor?: LatestAnchor },
  ): Segment {
    const page = [...rawPage].sort(compareMessages);
    let seg = target;
    if (page.length > 0) {
      const lo = page[0];
      const hi = page[page.length - 1];
      const ids = new Set(page.map(m => m.id));
      const group = new Set<Segment>([target]);
      for (const other of ch.segments()) {
        if (other === target) continue;
        if (this.intersects(ch, other, lo, hi) || other.items.some(m => ids.has(m.id))) group.add(other);
      }
      seg = this.mergeSegments(ch, group);
      for (const m of page) this.upsertFull(ch, m, { kind: 'segment', seg });
    }
    if (flags.reachesStart) seg.startsAtBeginning = true;
    if (flags.reachesEnd && seg !== ch.latest && ch.latest && this.latestUnchanged(ch, flags.latestAnchor)) {
      seg = this.mergeSegments(ch, new Set([seg, ch.latest]));
    }
    return seg;
  }

  /** the latest segment as it was when a request started */
  private latestAnchor(ch: ChannelData): LatestAnchor {
    const latest = ch.latest;
    return { seg: latest, first: latest && latest.items.length ? keyOf(latest.items[0]) : undefined };
  }

  /**
   * A short ASC page means "reached the end of the channel at request time";
   * it joins the latest segment only if that segment still starts where it
   * did then (no reset or trim in between could have left a hole). Without an
   * anchor, or when there was no latest segment yet, it joins.
   */
  private latestUnchanged(ch: ChannelData, anchor: LatestAnchor | undefined): boolean {
    if (!anchor || anchor.seg === null) return true;
    return anchor.seg === ch.latest && this.edgeUnchanged(ch, anchor.seg, 'start', anchor.first);
  }

  /** a segment is still part of the channel and still has the same first/last item */
  private edgeUnchanged(ch: ChannelData, seg: Segment, edge: 'start' | 'end', key: Key | undefined): boolean {
    if (!ch.alive || !ch.segments().includes(seg)) return false;
    const item = edge === 'start' ? seg.items[0] : seg.items[seg.items.length - 1];
    if (!key || !item) return !key && !item;
    return item.id === key.id && item.createdAt.getTime() === key.createdAt.getTime();
  }

  /** keep the latest segment at LATEST_SEGMENT_MAX without touching any visible slice */
  private enforceLatestMax(ch: ChannelData): void {
    const latest = ch.latest;
    if (!latest || latest.items.length <= LATEST_SEGMENT_MAX) return;
    let cut = latest.items.length - LATEST_SEGMENT_MAX;
    for (const w of ch.windows) {
      if (w.seg !== latest) continue;
      const start = w.from ? lowerBound(latest.items, w.from) : 0;
      cut = Math.min(cut, start);
    }
    if (cut <= 0) return;
    const removed = latest.items.splice(0, cut);
    latest.startsAtBeginning = false;
    for (const m of removed) if (ch.watchers.has(m.id)) ch.loose.set(m.id, m);
  }

  private async fetchPage(access: Access, order: 'ASC' | 'DESC', bound?: Date): Promise<Message[]> {
    const req: API.Messages.loadMessages.Request = { access, order };
    if (bound && order === 'DESC') req.createdBefore = iso(bound);
    if (bound && order === 'ASC') req.createdAfter = iso(bound);
    const page = await this.deps.api.loadMessages(req);
    return page.map(fromApiMessage);
  }

  // ----- window operations -------------------------------------------------

  async initWindow(w: WindowImpl, options: Models.ItemList.ItemListInitOptions, gen: number): Promise<number> {
    const ch = w.ch;
    ch.lastUsed = ++this.useCounter;
    const count = Math.max(PAGE_SIZE, options.minimumItemCount ?? 0);
    await w.guard(gen, this.waitAccess(ch.id));
    if (options.type === 'recent') {
      if (!ch.latest) await w.guard(gen, this.sync(ch, { join: true }));
      else this.sync(ch, { join: true }).catch(noop);
      if (!w.ch.latest) throw new Error('Could not load channel');
      await this.fillOlder(w, gen, count);
      const latest = w.ch.latest!;
      w.seg = latest;
      w.to = null;
      w.from = latest.items.length > count ? keyOf(latest.items[latest.items.length - count]) : null;
      const cause = w.ready ? 'latest' : 'init';
      w.ready = true;
      this.notify(w.ch, new Map([[w, { kind: 'reset', cause }]]));
      return w.serverCount;
    }
    const cause = w.ready ? 'jump' : 'init';
    if (options.type === 'atItemId') return this.loadAround(w, gen, { itemId: options.itemId, count }, cause === 'init' ? 'jump' : cause);
    return this.loadAround(w, gen, { date: options.date, count }, cause === 'init' ? 'jump' : cause);
  }

  /** older pages into the latest segment until it has `count` items or reaches the start */
  private async fillOlder(w: WindowImpl, gen: number, count: number): Promise<void> {
    const ch = w.ch;
    const access = this.requireAccess(ch.id);
    for (let i = 0; i < Math.ceil(count / PAGE_SIZE) + 1; i++) {
      const seg = ch.latest;
      if (!seg || seg.startsAtBeginning || seg.items.length >= count || seg.items.length === 0) return;
      const first = keyOf(seg.items[0]);
      const page = await w.guard(gen, this.fetchPage(access, 'DESC', first.createdAt));
      // a reset or trim meanwhile: the page no longer adjoins the segment
      if (ch.latest !== seg || !this.edgeUnchanged(ch, seg, 'start', first)) return;
      this.applyPage(ch, seg, page, { reachesStart: page.length < PAGE_SIZE });
    }
  }

  /**
   * Show a slice around an item or a date: from memory when a segment holds
   * it, otherwise as a detached segment from the server (merged into the
   * latest one when they meet).
   */
  async loadAround(
    w: WindowImpl,
    gen: number,
    target: { itemId: string; count?: number } | { date: Date; count?: number },
    cause: 'jump' | 'resync',
  ): Promise<number> {
    const ch = w.ch;
    const count = target.count ?? PAGE_SIZE;
    const half = Math.max(1, Math.floor(count / 2));
    const access = await w.guard(gen, this.waitAccess(ch.id));
    if ('itemId' in target && ch.tombstones.has(target.itemId)) throw notFound();
    const latestReady = ch.latest ? Promise.resolve() : this.sync(ch, { join: true });
    latestReady.catch(noop);

    let anchor: Key | null = null;
    let seg: Segment | null = null;
    if ('itemId' in target) {
      const loc = ch.locate(target.itemId);
      if (loc && !('loose' in loc)) {
        seg = loc.seg;
        anchor = keyOf(loc.seg.items[loc.index]);
      }
    } else {
      const probe = { createdAt: target.date, id: '' };
      for (const s of ch.segments()) {
        if (s.items.length === 0) continue;
        const coversStart = s.startsAtBeginning || compareMessages(probe, s.items[0]) >= 0;
        const coversEnd = s === ch.latest || compareMessages(probe, s.items[s.items.length - 1]) <= 0;
        if (coversStart && coversEnd) {
          seg = s;
          const i = Math.min(lowerBound(s.items, probe), s.items.length - 1);
          anchor = keyOf(s.items[i]);
          break;
        }
      }
    }

    if (!seg) {
      let date: Date;
      let item: Message | undefined;
      if ('itemId' in target) {
        const found = await w.guard(gen, this.deps.api.messagesById({ access, messageIds: [target.itemId] }));
        const api = found.find(m => m.id === target.itemId);
        if (!api || ch.tombstones.has(target.itemId)) throw notFound();
        item = fromApiMessage(api);
        date = item.createdAt;
      } else {
        date = target.date;
      }
      const anchorOfLatest = this.latestAnchor(ch);
      const [older, newer] = await w.guard(gen, Promise.all([
        this.fetchPage(access, 'DESC', item ? date : new Date(date.getTime() + 1)),
        this.fetchPage(access, 'ASC', item ? date : new Date(date.getTime())),
      ]));
      if (item && ch.tombstones.has(item.id)) throw notFound();
      await w.guard(gen, latestReady);
      if (!w.ch.alive) throw superseded();
      const fresh = new Segment();
      w.ch.detached.push(fresh);
      const page = item ? [...older, item, ...newer] : [...older, ...newer];
      seg = this.applyPage(w.ch, fresh, page, { reachesStart: older.length < PAGE_SIZE, reachesEnd: newer.length < PAGE_SIZE, latestAnchor: anchorOfLatest });
      if (seg === fresh && seg.items.length === 0) {
        w.ch.detached = w.ch.detached.filter(d => d !== fresh);
        seg = w.ch.latest;
      }
      if (!seg) throw new Error('Could not load channel');
      if (item) anchor = keyOf(item);
      else if (seg.items.length > 0) anchor = keyOf(seg.items[Math.min(lowerBound(seg.items, { createdAt: date, id: '' }), seg.items.length - 1)]);
    } else {
      await w.guard(gen, latestReady);
    }

    // the segment may have been merged meanwhile (first sync, other windows)
    let finalSeg: Segment = seg;
    if (!w.ch.segments().includes(seg)) {
      const loc = anchor ? w.ch.locate(anchor.id) : null;
      finalSeg = loc && !('loose' in loc) ? loc.seg : (w.ch.latest ?? seg);
    }
    const items = finalSeg.items;
    if (anchor && items.length > 0) {
      const idx = Math.min(lowerBound(items, anchor), items.length - 1);
      const startIdx = Math.max(0, idx - half);
      const endIdx = Math.min(items.length - 1, idx + half);
      w.seg = finalSeg;
      w.from = keyOf(items[startIdx]);
      w.to = finalSeg === w.ch.latest && endIdx >= items.length - 1 ? null : keyOf(items[endIdx]);
    } else {
      w.seg = finalSeg;
      w.from = null;
      w.to = finalSeg === w.ch.latest ? null : (items.length ? keyOf(items[items.length - 1]) : null);
    }
    w.ready = true;
    this.notify(w.ch, new Map([[w, { kind: 'reset', cause }]]));
    return w.serverCount;
  }

  /** the window still shows `seg` as it did when a request started */
  private sameSlice(w: WindowImpl, ch: ChannelData, seg: Segment, gen: number, epoch: number): boolean {
    return !this.disposed && !w.destroyed && w.gen === gen && w.epoch === epoch && w.ch === ch && w.seg === seg;
  }

  async loadOlder(w: WindowImpl, count: number): Promise<void> {
    const gen = w.gen;
    const epoch = w.epoch;
    const ch = w.ch;
    if (!w.seg || !w.ready) return;
    let seg = w.seg;
    let startIdx = w.from ? lowerBound(seg.items, w.from) : 0;
    if (startIdx === 0 && !seg.startsAtBeginning && seg.items.length > 0) {
      const access = this.requireAccess(ch.id);
      const first = keyOf(seg.items[0]);
      let page: Message[];
      try {
        page = await w.guard(gen, this.fetchPage(access, 'DESC', first.createdAt));
      } catch (e) {
        if (gen !== w.gen) return;
        throw e;
      }
      // only splice the page onto the edge it was fetched for: a reset, merge
      // or trim meanwhile would leave a hole between it and the segment
      if (!this.sameSlice(w, ch, seg, gen, epoch) || !this.edgeUnchanged(ch, seg, 'start', first)) return;
      seg = this.applyPage(ch, seg, page, { reachesStart: page.length < PAGE_SIZE });
      w.seg = seg;
      startIdx = w.from ? lowerBound(seg.items, w.from) : 0;
    }
    const newStart = Math.max(0, startIdx - count);
    const added = startIdx - newStart;
    if (seg.items.length > 0) w.from = keyOf(seg.items[newStart]);
    this.notify(w.ch, new Map([[w, { kind: 'prepend', count: added }]]));
  }

  async loadNewer(w: WindowImpl, count: number): Promise<void> {
    const gen = w.gen;
    if (!w.seg || !w.ready) return;
    if (w.seg === w.ch.latest && w.to === null) return;
    let seg = w.seg;
    let endIdx = w.to ? upperBound(seg.items, w.to) : seg.items.length;
    const lastKey = w.to;
    if (endIdx >= seg.items.length && seg !== w.ch.latest) {
      const ch = w.ch;
      const epoch = w.epoch;
      const access = this.requireAccess(ch.id);
      const newest = seg.items[seg.items.length - 1];
      const last = newest ? keyOf(newest) : undefined;
      const latestAnchor = this.latestAnchor(ch);
      let page: Message[];
      try {
        page = await w.guard(gen, this.fetchPage(access, 'ASC', newest?.createdAt));
      } catch (e) {
        if (gen !== w.gen) return;
        throw e;
      }
      if (!this.sameSlice(w, ch, seg, gen, epoch) || !this.edgeUnchanged(ch, seg, 'end', last)) return;
      seg = this.applyPage(ch, seg, page, { reachesEnd: page.length < PAGE_SIZE, latestAnchor });
      w.seg = seg;
      endIdx = lastKey ? upperBound(seg.items, lastKey) : seg.items.length;
    }
    const newEnd = Math.min(seg.items.length, endIdx + count);
    const added = newEnd - endIdx;
    if (seg === w.ch.latest && newEnd >= seg.items.length) w.to = null;
    else if (newEnd > 0) w.to = keyOf(seg.items[newEnd - 1]);
    this.notify(w.ch, new Map([[w, { kind: 'append-page', count: added }]]));
  }

  trimWindow(w: WindowImpl, options: { keep: number; from: 'start' | 'end' }): void {
    const seg = w.seg;
    if (!seg) return;
    const startIdx = w.from ? lowerBound(seg.items, w.from) : 0;
    const endIdx = Math.max(startIdx, w.to ? upperBound(seg.items, w.to) : seg.items.length);
    const visible = endIdx - startIdx;
    const keep = Math.max(1, Math.floor(options.keep));
    if (visible <= keep) return;
    const count = visible - keep;
    if (options.from === 'start') {
      w.from = keyOf(seg.items[startIdx + count]);
    } else {
      w.to = keyOf(seg.items[startIdx + keep - 1]);
    }
    this.notify(w.ch, new Map([[w, { kind: 'trim', from: options.from, count }]]));
    this.enforceLatestMax(w.ch);
  }

  async jumpToLatest(w: WindowImpl, gen: number): Promise<void> {
    await w.guard(gen, this.waitAccess(w.ch.id));
    if (!w.ch.latest) await w.guard(gen, this.sync(w.ch, { join: true }));
    const latest = w.ch.latest;
    if (!latest) return;
    w.seg = latest;
    w.to = null;
    w.from = latest.items.length > PAGE_SIZE ? keyOf(latest.items[latest.items.length - PAGE_SIZE]) : null;
    w.ready = true;
    this.notify(w.ch, new Map([[w, { kind: 'reset', cause: 'latest' }]]));
  }

  // ----- watchers ----------------------------------------------------------

  watchMessage(channelId: string, messageId: string, onChange: (message: Message | undefined) => void): Unsubscribe {
    const ch = this.getOrCreate(channelId);
    const watcher: Watcher = { onChange, last: UNSET };
    let set = ch.watchers.get(messageId);
    if (!set) {
      set = new Set();
      ch.watchers.set(messageId, set);
    }
    set.add(watcher);
    const current = this.watchedValue(ch, messageId);
    if (current !== UNSET) {
      watcher.last = current;
      onChange(current);
    } else {
      ch.watchFetchDue.add(messageId);
      this.fetchWatched(ch);
    }
    this.evict();
    let active = true;
    return () => {
      if (!active) return;
      active = false;
      const owner = this.channels.get(channelId);
      for (const c of new Set([ch, owner])) {
        const s = c?.watchers.get(messageId);
        if (!s || !s.delete(watcher)) continue;
        if (s.size === 0) {
          c!.watchers.delete(messageId);
          c!.watchFetchDue.delete(messageId);
          c!.loose.delete(messageId);
        }
      }
      this.evict();
    };
  }

  private fetchWatched(ch: ChannelData): void {
    const ids = [...ch.watchFetchDue].filter(id => !ch.watchFetching.has(id) && ch.watchers.has(id));
    if (ids.length === 0) return;
    for (const id of ids) ch.watchFetching.add(id);
    const run = async () => {
      try {
        const access = await this.waitAccess(ch.id);
        const found = await this.deps.api.messagesById({ access, messageIds: ids });
        if (!ch.alive || this.disposed) return;
        const byId = new Map(found.map(m => [m.id, fromApiMessage(m)]));
        for (const id of ids) {
          ch.watchFetchDue.delete(id);
          const m = byId.get(id);
          if (!m) {
            // the server says it does not exist (or no longer): drop any copy
            if (ch.stored(id)) {
              this.tombstone(ch, [id]);
              continue;
            }
            for (const watcher of ch.watchers.get(id) ?? []) {
              if (watcher.last === undefined) continue;
              watcher.last = undefined;
              watcher.onChange(undefined);
            }
            continue;
          }
          if (ch.tombstones.has(id)) continue;
          const stored = ch.stored(id);
          if (stored) {
            if (fullVerdict(m, stored) === 'apply') ch.replace(m);
          } else if (ch.latestCovers(m)) {
            insertSorted(ch.latest!, m);
          } else {
            ch.loose.set(id, m);
          }
        }
        this.notify(ch);
      } catch {
        // retried on the next live signal
      } finally {
        for (const id of ids) ch.watchFetching.delete(id);
      }
    };
    run().catch(noop);
  }

  // ----- sending -----------------------------------------------------------

  createMessage(message: NewMessage, options?: { moderation?: boolean }): Promise<void> {
    const ch = this.getOrCreate(message.channelId);
    const now = new Date(this.deps.clock.now());
    const pending: PendingSend = {
      message: {
        id: this.deps.newId(),
        creatorId: this.deps.events.userId ?? '',
        channelId: message.channelId,
        body: message.body,
        attachments: message.attachments ?? [],
        parentMessageId: message.parentMessageId ?? null,
        editedAt: null,
        createdAt: now,
        updatedAt: now,
        reactions: {},
        ownReaction: null,
        sendStatus: 'sending',
      },
      moderation: !!options?.moderation,
      attempt: 0,
      timer: new Timer(this.deps.clock),
    };
    ch.pending.set(pending.message.id, pending);
    this.notify(ch);
    this.sendAttempt(ch, pending);
    return Promise.resolve();
  }

  private setPendingStatus(ch: ChannelData, p: PendingSend, status: 'sending' | 'error-send'): void {
    if (ch.pending.get(p.message.id) !== p || p.message.sendStatus === status) return;
    p.message = { ...p.message, sendStatus: status };
    this.notify(ch);
  }

  private sendAttempt(ch: ChannelData, p: PendingSend): void {
    const attempt = ++p.attempt;
    const id = p.message.id;
    const current = () => ch.alive && ch.pending.get(id) === p && p.attempt === attempt;
    p.timer.start(SEND_TIMEOUT_MS, () => {
      if (current()) this.setPendingStatus(ch, p, 'error-send');
    });
    const run = async () => {
      const access = await this.waitAccess(ch.id);
      const req: API.Messages.createMessage.Request = {
        id,
        access,
        body: p.message.body,
        parentMessageId: p.message.parentMessageId,
        attachments: p.message.attachments,
      };
      try {
        const resp = p.moderation ? await this.deps.api.createModerationMessage(req) : await this.deps.api.createMessage(req);
        this.confirmOwn(ch, fromApiMessage(resp));
      } catch {
        if (attempt > 1) {
          // older servers reject a repeated id; it may have been stored by the first attempt
          try {
            const found = await this.deps.api.messagesById({ access, messageIds: [id] });
            const api = found.find(m => m.id === id);
            if (api) {
              this.confirmOwn(ch, fromApiMessage(api));
              return;
            }
          } catch {
            // fall through to error-send
          }
        }
        if (current()) {
          p.timer.clear();
          this.setPendingStatus(ch, p, 'error-send');
        }
      }
    };
    run().catch(noop);
  }

  private confirmOwn(ch: ChannelData, m: Message): void {
    if (!ch.alive || this.disposed) return;
    if (ch.buffer) {
      // first sync in flight: the snapshot may predate this message; insert it after the reset
      ch.pending.get(m.id)?.timer.clear();
      ch.buffer.push({ own: m });
      return;
    }
    const verdict = this.upsertFull(ch, m, { kind: 'live' });
    if (verdict !== 'older') this.record(ch, m.syncSeq);
    this.enforceLatestMax(ch);
    this.notify(ch);
    this.evict();
  }

  retrySend(channelId: string, messageId: string): Promise<void> {
    const ch = this.channels.get(channelId);
    if (!ch) return Promise.resolve();
    const p = ch.pending.get(messageId);
    if (p) {
      if (p.message.sendStatus === 'error-send') {
        this.setPendingStatus(ch, p, 'sending');
        this.sendAttempt(ch, p);
      }
      return Promise.resolve();
    }
    const ov = ch.overlays.get(messageId);
    if (ov && ov.sendStatus === 'error-update') {
      ov.sendStatus = 'sending';
      this.notify(ch);
      this.editAttempt(ch, messageId, ov);
    }
    return Promise.resolve();
  }

  discardPending(channelId: string, messageId: string): void {
    const ch = this.channels.get(channelId);
    if (!ch) return;
    const p = ch.pending.get(messageId);
    if (p) {
      p.timer.clear();
      ch.pending.delete(messageId);
      this.notify(ch);
      this.evict();
      return;
    }
    const ov = ch.overlays.get(messageId);
    if (ov) {
      ov.timer.clear();
      ch.overlays.delete(messageId);
      this.notify(ch);
    }
  }

  editMessage(message: Message, update: Pick<Message, 'body' | 'attachments' | 'parentMessageId'>): Promise<void> {
    const ch = this.getOrCreate(message.channelId);
    const p = ch.pending.get(message.id);
    if (p) {
      // not on the server yet: change what will be (re)sent
      p.message = { ...p.message, body: update.body, attachments: update.attachments, parentMessageId: update.parentMessageId };
      this.notify(ch);
      return Promise.resolve();
    }
    const previous = ch.overlays.get(message.id);
    previous?.timer.clear();
    const ov: EditOverlay = {
      update: { body: update.body, attachments: update.attachments, parentMessageId: update.parentMessageId },
      editedAt: new Date(this.deps.clock.now()).toISOString(),
      sendStatus: 'sending',
      attempt: 0,
      timer: new Timer(this.deps.clock),
    };
    ch.overlays.set(message.id, ov);
    this.notify(ch);
    this.editAttempt(ch, message.id, ov);
    return Promise.resolve();
  }

  private editAttempt(ch: ChannelData, id: string, ov: EditOverlay): void {
    const attempt = ++ov.attempt;
    const current = () => ch.alive && ch.overlays.get(id) === ov && ov.attempt === attempt;
    ov.timer.start(SEND_TIMEOUT_MS, () => {
      if (current() && ov.sendStatus === 'sending') {
        ov.sendStatus = 'error-update';
        this.notify(ch);
      }
    });
    const run = async () => {
      const access = await this.waitAccess(ch.id);
      try {
        const resp = await this.deps.api.editMessage({
          access,
          id,
          body: ov.update.body,
          attachments: ov.update.attachments,
          parentMessageId: ov.update.parentMessageId,
        });
        if (!ch.alive) return;
        const partial: MessagePartial = {
          id,
          updatedAt: new Date(resp.updatedAt ?? resp.editedAt),
          body: ov.update.body,
          attachments: resp.attachments ?? ov.update.attachments,
          parentMessageId: ov.update.parentMessageId,
          editedAt: resp.editedAt,
        };
        if (typeof resp.syncSeq === 'number') partial.syncSeq = resp.syncSeq;
        const verdict = this.applyPartialUpdate(ch, partial);
        if (verdict === 'apply' || verdict === 'same' || verdict === 'unheld') this.record(ch, partial.syncSeq);
        if (ch.overlays.get(id) === ov) {
          ov.timer.clear();
          if (verdict === 'older' && partial.syncSeq !== undefined) {
            // a newer partial (e.g. a reaction) is stored: keep showing the edit until a full row covers it
            ov.sendStatus = undefined;
            ov.awaitSeq = partial.syncSeq;
            ov.editedAt = resp.editedAt;
          } else {
            ch.overlays.delete(id);
          }
        }
        this.notify(ch);
      } catch {
        if (current()) {
          ov.timer.clear();
          ov.sendStatus = 'error-update';
          this.notify(ch);
        }
      }
    };
    run().catch(noop);
  }

  async deleteMessage(channelId: string, messageId: string, creatorId: string): Promise<void> {
    const access = this.requireAccess(channelId);
    await this.deps.api.deleteMessage({ access, messageId, creatorId });
    const ch = this.channels.get(channelId);
    if (!ch) return;
    this.tombstone(ch, [messageId]);
    this.notify(ch);
  }

  async setReaction(channelId: string, messageId: string, reaction: string): Promise<void> {
    const access = this.requireAccess(channelId);
    await this.deps.api.setReaction({ access, messageId, reaction });
  }

  async unsetReaction(channelId: string, messageId: string): Promise<void> {
    const access = this.requireAccess(channelId);
    await this.deps.api.unsetReaction({ access, messageId });
  }
}

/** ChannelStore factory (contract: CreateChannelStore) */
export function createChannelStore(deps: ChannelStoreDeps): ChannelStore & {
  /** the catch-up cursor of a channel (tests, diagnostics) */
  getCursor(channelId: string): API.Messages.SyncCursor | null;
  /** whether a channel is cached (tests, diagnostics) */
  hasChannel(channelId: string): boolean;
} {
  return new ChannelStoreImpl(deps);
}
