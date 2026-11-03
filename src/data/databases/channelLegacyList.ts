// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * @deprecated Interim adapter: the old `Models.ItemList.ItemList` interface
 * over a ChannelWindow (data/chat), for the list components that still call
 * `data.channelManager.getMountedChannelDatabase(...).database.createItemList()`
 * until they use `chat.channels.openWindow` directly. Removed with them.
 *
 * Mapping: the window loads from memory or the server by itself, so the
 * adapter reports every "more items" flag as local (`has*ItemsLocally`) and
 * none as remote; the components then always take their `update({grow*})`
 * path, which becomes `loadOlder`/`loadNewer`. `shrink*` becomes `trim`.
 */

import { WINDOW_ERROR, type ChannelWindow, type ReadMarker } from 'data/chat/types';

type Message = Models.Message.Message;
type State = Models.ItemList.ItemListState<Message>;

const DESTROYED_STATE: State = {
  items: [],
  isDestroyed: true,
  ready: false,
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

function legacyState(state: State): State {
  return {
    ...state,
    hasNextItemsLocally: state.hasNextItemsLocally || state.hasNextItemsOnRemote,
    hasNextItemsOnRemote: false,
    hasPreviousItemsLocally: state.hasPreviousItemsLocally || state.hasPreviousItemsOnRemote,
    hasPreviousItemsOnRemote: false,
  };
}

export class LegacyItemList implements Models.ItemList.ItemList<Message> {
  readonly ready: Promise<void> = Promise.resolve();
  private readonly listeners = new Set<Models.ItemList.ItemListUpdateListener<Message>>();
  private readonly unsubscribe: () => void;
  private destroyed = false;
  private cached: { from: State; out: State } | null = null;
  private marker: ReadMarker | null = null;

  constructor(
    readonly window: ChannelWindow,
    private readonly onDestroy: (list: LegacyItemList) => void,
    private readonly createMarker: () => ReadMarker,
  ) {
    this.unsubscribe = window.subscribe(() => {
      const state = this.state;
      for (const l of [...this.listeners]) l(state);
    });
  }

  get state(): State {
    if (this.destroyed) return DESTROYED_STATE;
    const from = this.window.state;
    if (this.cached?.from !== from) this.cached = { from, out: legacyState(from) };
    return this.cached.out;
  }

  get items(): Message[] {
    return this.state.items;
  }

  init(options: Models.ItemList.ItemListInitOptions): Promise<number> {
    // replaced by a later init (e.g. the re-init after a logout): not an error for the old callers
    return this.window.init(options).catch((e: unknown) => {
      if (e instanceof Error && e.message === WINDOW_ERROR.SUPERSEDED) return 0;
      throw e;
    });
  }

  /**
   * Legacy read mark (setChannelLastRead): this list's marker reports the
   * newest shown server message at or before `date`. The marker stays, so a
   * mark reported while the tab is hidden is sent once it is visible.
   * Returns whether such a message is shown.
   */
  markUpTo(date: Date): boolean {
    if (this.destroyed) return false;
    const t = date.getTime();
    let newest: Message | undefined;
    for (const item of this.window.state.items) {
      if (item.sendStatus !== undefined) continue;
      const ms = item.createdAt.getTime();
      if (ms <= t && (!newest || ms > newest.createdAt.getTime())) newest = item;
    }
    if (!newest) return false;
    if (!this.marker) this.marker = this.createMarker();
    this.marker.update({ atLatest: true, atBottom: true, newest: { id: newest.id, createdAt: newest.createdAt } });
    return true;
  }

  addUpdateListener(listener: Models.ItemList.ItemListUpdateListener<Message>): void {
    this.listeners.add(listener);
  }

  removeUpdateListener(listener: Models.ItemList.ItemListUpdateListener<Message>): void {
    this.listeners.delete(listener);
  }

  async update(options: Models.ItemList.ItemListUpdateOptions): Promise<void> {
    if (this.destroyed) return;
    if (options.growStart) await this.window.loadOlder(options.growStart);
    if (options.growEnd) await this.window.loadNewer(options.growEnd);
    const count = this.window.state.items.length;
    if (options.shrinkStart) this.window.trim({ keep: Math.max(0, count - options.shrinkStart), from: 'start' });
    if (options.shrinkEnd) this.window.trim({ keep: Math.max(0, count - options.shrinkEnd), from: 'end' });
  }

  destroy(notify = true): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.marker?.dispose();
    this.marker = null;
    this.unsubscribe();
    this.window.destroy();
    this.onDestroy(this);
    if (notify) {
      for (const l of [...this.listeners]) l(DESTROYED_STATE);
    }
    this.listeners.clear();
  }

  chunksChangedListener(): void {
    // no chunks any more
  }
}
