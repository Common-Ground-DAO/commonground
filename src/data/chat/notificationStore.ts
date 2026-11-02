// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Notifications of one tab: memory + server (contract: NotificationStore in
 * ./types.ts). The unread count comes only from the server; the list is one
 * shared, newest-anchored item list with ref-counted windows.
 */

import {
  PAGE_SIZE,
  WINDOW_ERROR,
  type ItemWindow,
  type NotificationStore,
  type NotificationStoreDeps,
  type Unsubscribe,
  type WindowChange,
  type WindowListener,
} from './types';
import { Timer } from './util';

type Notification = Models.Notification.Notification;
type State = Models.ItemList.ItemListState<Notification>;

/** an event without `unreadCount` (old server) refetches the count after this */
export const COUNT_REFETCH_DEBOUNCE_MS = 500;
/** coalesces onLive/onResume bursts */
export const NOTIFICATION_RESYNC_DEBOUNCE_MS = 50;

function fromApi(n: Models.Notification.ApiNotification): Notification {
  return { ...n, createdAt: new Date(n.createdAt), updatedAt: new Date(n.updatedAt) };
}

function compare(a: Notification, b: Notification): number {
  const d = a.createdAt.getTime() - b.createdAt.getTime();
  if (d !== 0) return d;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

type Key = { createdAt: Date; id: string };

function lowerBound(items: Notification[], k: Key): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compare(items[mid], k as Notification) < 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

function upperBound(items: Notification[], k: Key): number {
  let lo = 0;
  let hi = items.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (compare(items[mid], k as Notification) <= 0) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

const keyOf = (n: Notification): Key => ({ createdAt: n.createdAt, id: n.id });

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

const FLAGS: (keyof State)[] = [
  'isDestroyed', 'ready', 'hasNextItemsLocally', 'hasNextItemsOnRemote', 'hasPreviousItemsLocally',
  'hasPreviousItemsOnRemote', 'withStartOfList', 'withEndOfList', 'isEmpty',
];

const noop = () => undefined;

class ListWindow implements ItemWindow<Notification> {
  state: State = emptyState(false, false);
  from: Key | null = null;
  to: Key | null = null;
  ready = false;
  destroyed = false;
  gen = 0;
  private listeners = new Set<WindowListener<Notification>>();

  constructor(private readonly store: NotificationStoreImpl) {}

  subscribe(listener: WindowListener<Notification>): Unsubscribe {
    if (this.destroyed) return noop;
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  emit(change: WindowChange): void {
    for (const l of [...this.listeners]) l(this.state, change);
  }

  async init(options: Models.ItemList.ItemListInitOptions): Promise<number> {
    if (this.destroyed) throw new Error(WINDOW_ERROR.SUPERSEDED);
    const gen = ++this.gen;
    return this.store.initWindow(this, options, gen);
  }

  loadOlder(count: number = PAGE_SIZE): Promise<void> {
    return this.store.loadOlder(this, count);
  }

  async loadNewer(count: number = PAGE_SIZE): Promise<void> {
    this.store.loadNewer(this, count);
  }

  trim(options: { keep: number; from: 'start' | 'end' }): void {
    this.store.trim(this, options);
  }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.gen++;
    this.state = emptyState(false, true);
    this.listeners.clear();
    this.store.releaseWindow(this);
  }
}

class NotificationStoreImpl implements NotificationStore {
  private count = 0;
  /** ms of the stored count; null = unknown (any timed count wins) */
  private countAt: number | null = null;
  private readonly countListeners = new Set<(count: number) => void>();

  /** loaded notifications, ascending */
  private items: Notification[] = [];
  private loaded = false;
  private startsAtBeginning = false;
  private loading: Promise<void> | null = null;
  private olderLoading: Promise<void> | null = null;
  private readonly windows = new Set<ListWindow>();
  private readonly inFlightRead = new Set<string>();
  /** ids marked read by this tab that are not in the loaded list */
  private readonly readIds = new Set<string>();

  private readonly refetchTimer: Timer;
  private readonly resyncTimer: Timer;
  private readonly unsubs: Unsubscribe[] = [];
  private disposed = false;
  private generation = 0;

  constructor(private readonly deps: NotificationStoreDeps) {
    this.refetchTimer = new Timer(deps.clock);
    this.resyncTimer = new Timer(deps.clock);
    this.unsubs.push(
      deps.events.onNotificationEvent(e => this.onEvent(e)),
      deps.events.onLive(() => this.scheduleResync()),
      deps.events.onResume(() => this.scheduleResync()),
    );
  }

  // ----- count -------------------------------------------------------------

  get unreadCount(): number {
    return this.count;
  }

  subscribeUnreadCount(listener: (count: number) => void): Unsubscribe {
    this.countListeners.add(listener);
    return () => {
      this.countListeners.delete(listener);
    };
  }

  private setCount(value: unknown, at?: string): void {
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) return;
    if (at !== undefined) {
      const t = Date.parse(at);
      if (Number.isNaN(t)) return;
      if (this.countAt !== null && t < this.countAt) return;
      this.countAt = t;
    } else {
      this.countAt = null;
    }
    const next = Math.floor(n);
    if (next === this.count) return;
    this.count = next;
    for (const l of [...this.countListeners]) l(next);
  }

  setupAfterLogin(unreadCount: number | string): void {
    this.setCount(unreadCount);
  }

  private async fetchCount(): Promise<void> {
    const generation = this.generation;
    const resp = await this.deps.api.getUnreadCount({ withTime: true });
    if (generation !== this.generation || this.disposed) return;
    if (typeof resp === 'object' && resp !== null) this.setCount(resp.unreadCount, resp.unreadCountAt);
    else this.setCount(resp);
  }

  private scheduleCountRefetch(): void {
    this.refetchTimer.start(COUNT_REFETCH_DEBOUNCE_MS, () => {
      this.fetchCount().catch(noop);
    });
  }

  // ----- events ------------------------------------------------------------

  private onEvent(event: Events.Notification.Notification): void {
    if (this.disposed) return;
    if (typeof event.unreadCount === 'number') this.setCount(event.unreadCount, event.unreadCountAt);
    else this.scheduleCountRefetch();
    if (!this.loaded) return;
    let change = false;
    switch (event.action) {
      case 'new':
        change = this.upsert(fromApi(event.data));
        break;
      case 'update': {
        const i = this.items.findIndex(n => n.id === event.data.id);
        if (i >= 0) {
          const stored = this.items[i];
          const updatedAt = new Date(event.data.updatedAt);
          if (updatedAt.getTime() >= stored.updatedAt.getTime()) {
            const next: Notification = { ...stored, ...(event.data as Partial<Models.Notification.ApiNotification>), createdAt: stored.createdAt, updatedAt } as Notification;
            if (JSON.stringify(next) !== JSON.stringify(stored)) {
              this.items[i] = next;
              change = true;
            }
          }
        }
        break;
      }
      case 'delete': {
        const ids = new Set(Array.isArray(event.id) ? event.id : [event.id]);
        const before = this.items.length;
        this.items = this.items.filter(n => !ids.has(n.id));
        change = this.items.length !== before;
        break;
      }
      case 'allread': {
        const updatedAt = new Date(event.data.updatedAt);
        this.items = this.items.map(n => {
          if (n.read) return n;
          change = true;
          return { ...n, read: true, updatedAt: updatedAt.getTime() > n.updatedAt.getTime() ? updatedAt : n.updatedAt };
        });
        break;
      }
    }
    if (change) this.notify();
  }

  /** insert or replace by id (newer or equal updatedAt wins); true if anything changed */
  private upsert(n: Notification): boolean {
    const i = this.items.findIndex(x => x.id === n.id);
    if (i >= 0) {
      const stored = this.items[i];
      if (n.updatedAt.getTime() < stored.updatedAt.getTime()) return false;
      if (JSON.stringify(n) === JSON.stringify(stored)) return false;
      this.items[i] = n;
      return true;
    }
    this.items.splice(upperBound(this.items, keyOf(n)), 0, n);
    return true;
  }

  // ----- resync ------------------------------------------------------------

  private scheduleResync(): void {
    if (this.disposed) return;
    this.resyncTimer.start(NOTIFICATION_RESYNC_DEBOUNCE_MS, () => {
      this.fetchCount().catch(noop);
      if (this.loaded && this.windows.size > 0) this.refreshNewest().catch(noop);
    });
  }

  /** the newest page again: merged when it meets the list, otherwise it replaces it */
  private async refreshNewest(): Promise<void> {
    const generation = this.generation;
    const page = (await this.deps.api.loadNotifications({ order: 'DESC' })).map(fromApi).sort(compare);
    if (generation !== this.generation || this.disposed) return;
    const newestLoaded = this.items[this.items.length - 1];
    if (page.length === PAGE_SIZE && newestLoaded && compare(page[0], newestLoaded) > 0) {
      this.items = page;
      this.startsAtBeginning = false;
      for (const w of this.windows) {
        w.from = null;
        w.to = null;
      }
      this.notify(new Map([...this.windows].map(w => [w, { kind: 'reset', cause: 'resync' } as WindowChange])));
      return;
    }
    let change = false;
    for (const n of page) change = this.upsert(n) || change;
    if (page.length < PAGE_SIZE && !this.startsAtBeginning) {
      this.startsAtBeginning = true;
      change = true;
    }
    if (change) this.notify();
  }

  // ----- list --------------------------------------------------------------

  openList(): ItemWindow<Notification> {
    const w = new ListWindow(this);
    this.windows.add(w);
    return w;
  }

  releaseWindow(w: ListWindow): void {
    this.windows.delete(w);
  }

  private ensureLoaded(): Promise<void> {
    if (this.loaded) return Promise.resolve();
    if (!this.loading) {
      const generation = this.generation;
      this.loading = this.deps.api.loadNotifications({ order: 'DESC' }).then(
        page => {
          this.loading = null;
          if (generation !== this.generation) return;
          for (const n of page.map(fromApi)) this.upsert(n);
          this.startsAtBeginning = page.length < PAGE_SIZE;
          this.loaded = true;
        },
        e => {
          this.loading = null;
          throw e;
        },
      );
    }
    return this.loading;
  }

  private computeState(w: ListWindow): State {
    if (w.destroyed) return emptyState(false, true);
    if (!w.ready) return emptyState(false, false);
    const all = this.items;
    const startIdx = w.from ? lowerBound(all, w.from) : 0;
    const endIdx = Math.max(startIdx, w.to ? upperBound(all, w.to) : all.length);
    const items = all.slice(startIdx, endIdx);
    const withStartOfList = startIdx === 0 && this.startsAtBeginning;
    const withEndOfList = w.to === null;
    return {
      items,
      isDestroyed: false,
      ready: true,
      rangeStart: items.length ? items[0].createdAt : null,
      rangeEnd: items.length ? items[items.length - 1].createdAt : null,
      hasPreviousItemsLocally: startIdx > 0,
      hasPreviousItemsOnRemote: !this.startsAtBeginning,
      hasNextItemsLocally: endIdx < all.length,
      hasNextItemsOnRemote: false,
      withStartOfList,
      withEndOfList,
      isEmpty: items.length === 0 && withStartOfList && withEndOfList,
    };
  }

  private diff(prev: State, next: State): WindowChange | null {
    const a = prev.items;
    const b = next.items;
    const flagsSame = FLAGS.every(f => prev[f] === next[f]);
    if (flagsSame && a.length === b.length && a.every((n, i) => n === b[i])) return null;
    if (b.length > a.length) {
      if (prev.withEndOfList && next.withEndOfList && a.every((n, i) => n.id === b[i].id)) {
        return { kind: 'append-live', count: b.length - a.length, own: false };
      }
      const shift = b.length - a.length;
      if (a.every((n, i) => n.id === b[i + shift].id)) return { kind: 'prepend', count: shift };
    }
    return { kind: 'update' };
  }

  private notify(hints?: Map<ListWindow, WindowChange>): void {
    for (const w of [...this.windows]) {
      const next = this.computeState(w);
      const change = hints?.get(w) ?? this.diff(w.state, next);
      if (w.from === null && next.items.length > 0) w.from = keyOf(next.items[0]);
      if (!change) continue;
      w.state = next;
      w.emit(change);
    }
  }

  async initWindow(w: ListWindow, options: Models.ItemList.ItemListInitOptions, gen: number): Promise<number> {
    await this.ensureLoaded();
    if (gen !== w.gen || w.destroyed) throw new Error(WINDOW_ERROR.SUPERSEDED);
    const count = Math.max(PAGE_SIZE, options.minimumItemCount ?? 0);
    const all = this.items;
    if (options.type === 'atItemId') {
      const idx = all.findIndex(n => n.id === options.itemId);
      if (idx < 0) throw new Error(WINDOW_ERROR.NOT_FOUND);
      const half = Math.floor(count / 2);
      w.from = keyOf(all[Math.max(0, idx - half)]);
      w.to = idx + half >= all.length - 1 ? null : keyOf(all[idx + half]);
    } else if (options.type === 'atDate') {
      const probe = { createdAt: options.date, id: '' };
      for (let i = 0; i < 10 && !this.startsAtBeginning && (all.length === 0 || compare(this.items[0], probe as Notification) > 0); i++) {
        await this.fetchOlderPage();
        if (gen !== w.gen || w.destroyed) throw new Error(WINDOW_ERROR.SUPERSEDED);
      }
      const items = this.items;
      const idx = Math.min(lowerBound(items, probe), Math.max(0, items.length - 1));
      const half = Math.floor(count / 2);
      w.from = items.length ? keyOf(items[Math.max(0, idx - half)]) : null;
      w.to = idx + half >= items.length - 1 ? null : keyOf(items[idx + half]);
    } else {
      w.from = all.length > count ? keyOf(all[all.length - count]) : null;
      w.to = null;
    }
    const cause = w.ready ? (options.type === 'recent' ? 'latest' : 'jump') : 'init';
    w.ready = true;
    this.notify(new Map([[w, { kind: 'reset', cause }]]));
    return w.state.items.length;
  }

  private fetchOlderPage(): Promise<void> {
    if (!this.olderLoading) {
      const generation = this.generation;
      const oldest = this.items[0];
      const request: API.Notification.loadNotifications.Request = { order: 'DESC' };
      if (oldest) request.createdBefore = oldest.createdAt.toISOString();
      this.olderLoading = this.deps.api.loadNotifications(request).then(
        page => {
          this.olderLoading = null;
          if (generation !== this.generation) return;
          for (const n of page.map(fromApi)) this.upsert(n);
          if (page.length < PAGE_SIZE) this.startsAtBeginning = true;
        },
        e => {
          this.olderLoading = null;
          throw e;
        },
      );
    }
    return this.olderLoading;
  }

  async loadOlder(w: ListWindow, count: number): Promise<void> {
    if (!w.ready || w.destroyed) return;
    const gen = w.gen;
    let startIdx = w.from ? lowerBound(this.items, w.from) : 0;
    if (startIdx === 0 && !this.startsAtBeginning) {
      await this.fetchOlderPage();
      if (gen !== w.gen || w.destroyed) return;
      startIdx = w.from ? lowerBound(this.items, w.from) : 0;
    }
    const newStart = Math.max(0, startIdx - count);
    if (this.items.length) w.from = keyOf(this.items[newStart]);
    this.notify(new Map([[w, { kind: 'prepend', count: startIdx - newStart }]]));
  }

  loadNewer(w: ListWindow, count: number): void {
    if (!w.ready || w.destroyed || w.to === null) return;
    const endIdx = upperBound(this.items, w.to);
    const newEnd = Math.min(this.items.length, endIdx + count);
    w.to = newEnd >= this.items.length ? null : keyOf(this.items[newEnd - 1]);
    this.notify(new Map([[w, { kind: 'append-page', count: newEnd - endIdx }]]));
  }

  trim(w: ListWindow, options: { keep: number; from: 'start' | 'end' }): void {
    if (!w.ready || w.destroyed) return;
    const startIdx = w.from ? lowerBound(this.items, w.from) : 0;
    const endIdx = Math.max(startIdx, w.to ? upperBound(this.items, w.to) : this.items.length);
    const keep = Math.max(1, Math.floor(options.keep));
    const visible = endIdx - startIdx;
    if (visible <= keep) return;
    const count = visible - keep;
    if (options.from === 'start') w.from = keyOf(this.items[startIdx + count]);
    else w.to = keyOf(this.items[startIdx + keep - 1]);
    this.notify(new Map([[w, { kind: 'trim', from: options.from, count }]]));
  }

  // ----- marking read --------------------------------------------------------

  async markAsRead(notificationId: string): Promise<void> {
    const i = this.items.findIndex(n => n.id === notificationId);
    const known = i >= 0 ? this.items[i] : undefined;
    if ((known ? known.read : this.readIds.has(notificationId)) || this.inFlightRead.has(notificationId)) return;
    this.inFlightRead.add(notificationId);
    if (known) {
      this.items[i] = { ...known, read: true };
      this.notify();
    }
    const generation = this.generation;
    try {
      await this.deps.api.markAsRead({ notificationId });
      if (generation === this.generation) {
        if (!known) this.readIds.add(notificationId);
        this.fetchCount().catch(noop);
      }
    } catch {
      if (generation === this.generation) {
        const j = this.items.findIndex(n => n.id === notificationId);
        if (j >= 0 && this.items[j].read && known && !known.read) {
          this.items[j] = { ...this.items[j], read: false };
          this.notify();
        }
      }
    } finally {
      this.inFlightRead.delete(notificationId);
    }
  }

  async markAllAsRead(): Promise<void> {
    const changed = new Set(this.items.filter(n => !n.read).map(n => n.id));
    if (changed.size > 0) {
      this.items = this.items.map(n => (changed.has(n.id) ? { ...n, read: true } : n));
      this.notify();
    }
    const generation = this.generation;
    try {
      await this.deps.api.markAllAsRead(undefined);
      if (generation === this.generation) this.fetchCount().catch(noop);
    } catch {
      if (generation === this.generation && changed.size > 0) {
        this.items = this.items.map(n => (changed.has(n.id) && n.read ? { ...n, read: false } : n));
        this.notify();
      }
    }
  }

  // ----- lifecycle -----------------------------------------------------------

  clear(): void {
    this.generation++;
    this.items = [];
    this.loaded = false;
    this.loading = null;
    this.olderLoading = null;
    this.startsAtBeginning = false;
    this.inFlightRead.clear();
    this.readIds.clear();
    this.refetchTimer.clear();
    this.countAt = null;
    if (this.count !== 0) {
      this.count = 0;
      for (const l of [...this.countListeners]) l(0);
    }
    for (const w of this.windows) {
      w.gen++;
      w.ready = false;
      w.from = null;
      w.to = null;
    }
    this.notify(new Map([...this.windows].map(w => [w, { kind: 'reset', cause: 'resync' } as WindowChange])));
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.refetchTimer.clear();
    this.resyncTimer.clear();
    this.countListeners.clear();
  }
}

/** NotificationStore factory (contract: CreateNotificationStore) */
export function createNotificationStore(deps: NotificationStoreDeps): NotificationStore {
  return new NotificationStoreImpl(deps);
}
