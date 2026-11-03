// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Level-triggered read marking of one mounted message list (chat-sync, roadmap
 * docs/todo/ROADMAP_chat-sync.md "Read state" [5]).
 *
 * The list reports its level inputs — the window is at the latest segment,
 * the list is scrolled to the bottom, the newest server item — on every
 * change, and the ReadStateStore marks the channel read while any marker of
 * the channel has all three (plus document visible and logged in). No
 * IntersectionObserver and no DOM timestamps are involved.
 */

import { useEffect, useRef } from 'react';
import { chat } from 'data/chat/runtime';
import type { ReadMarker, ReadMarkingInput, ReadStateStore } from 'data/chat/types';

type State = Models.ItemList.ItemListState<Models.Message.Message>;

/**
 * Newest server item of a window state. `items` holds the server items
 * (ascending) followed by the pending own sends; `rangeEnd` is the createdAt
 * of the last server item, so the newest server item is the last item with
 * that createdAt. A failed send is never a server item.
 */
export function newestServerItem(state: State): ReadMarkingInput['newest'] {
  const { items, rangeEnd } = state;
  if (!rangeEnd) return null;
  const end = rangeEnd.getTime();
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i];
    const time = item.createdAt.getTime();
    if (time === end && item.sendStatus !== 'error-send') {
      return { id: item.id, createdAt: item.createdAt };
    }
    // ascending server items: nothing older can be the newest one
    if (time < end && item.sendStatus === undefined) break;
  }
  return null;
}

export function readMarkingInput(state: State, atBottom: boolean): ReadMarkingInput {
  return {
    atLatest: state.withEndOfList,
    atBottom,
    newest: newestServerItem(state),
  };
}

export function sameReadMarkingInput(a: ReadMarkingInput, b: ReadMarkingInput): boolean {
  return a.atLatest === b.atLatest
    && a.atBottom === b.atBottom
    && a.newest?.id === b.newest?.id
    && a.newest?.createdAt.getTime() === b.newest?.createdAt.getTime();
}

/** Article comment channels and call chats have no read state. */
export function isReadTrackedAccess(access: API.Messages.MessageAccess | undefined): boolean {
  if (!access) return true;
  return !('callId' in access) && !('articleId' in access);
}

/**
 * React-free part of the hook: one marker for the channel currently shown,
 * created lazily, replaced when the channel changes, updated only when an
 * input changed.
 */
export class ReadMarkingController {
  private marker: ReadMarker | null = null;
  private markerChannelId: string | null = null;
  private last: ReadMarkingInput | null = null;

  constructor(
    private readonly readState: Pick<ReadStateStore, 'createMarker'>,
    private readonly getAccess: (channelId: string) => API.Messages.MessageAccess | undefined,
  ) {}

  report(channelId: string, state: State, atBottom: boolean): void {
    if (this.markerChannelId !== channelId) this.dispose();
    if (!isReadTrackedAccess(this.getAccess(channelId))) {
      this.dispose();
      return;
    }
    const input = readMarkingInput(state, atBottom);
    if (this.marker && this.last && sameReadMarkingInput(this.last, input)) return;
    if (!this.marker) {
      this.marker = this.readState.createMarker(channelId);
      this.markerChannelId = channelId;
    }
    this.last = input;
    this.marker.update(input);
  }

  dispose(): void {
    this.marker?.dispose();
    this.marker = null;
    this.markerChannelId = null;
    this.last = null;
  }
}

/**
 * Report the read-marking level of a mounted message window. `state` must be
 * the state of the window on `channelId` (pass both from the same source, so
 * a channel switch never reports one channel's items for another).
 */
export function useChannelReadMarking(
  channelId: string | undefined,
  state: State | null,
  atBottom: boolean,
  enabled: boolean = true,
): void {
  const controllerRef = useRef<ReadMarkingController | null>(null);
  if (!controllerRef.current) {
    controllerRef.current = new ReadMarkingController(
      chat.readState,
      id => chat.channels.getAccessForChannel(id),
    );
  }

  useEffect(() => {
    const controller = controllerRef.current!;
    if (!enabled || !channelId || !state || state.isDestroyed) {
      controller.dispose();
      return;
    }
    controller.report(channelId, state, atBottom);
  }, [channelId, state, atBottom, enabled]);

  useEffect(() => () => controllerRef.current?.dispose(), []);
}
