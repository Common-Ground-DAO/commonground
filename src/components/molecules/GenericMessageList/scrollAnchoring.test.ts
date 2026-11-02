// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
// aliased: called from a plain setup helper, not a React hook
import { useDataLayerFakeTimers as installFakeTimers } from 'test/timers';
import { flushMicrotasks } from 'test/deferred';
import { createChannelStore } from 'data/chat/channelStore';
import { FakeChatServer, textBody } from 'data/chat/testing/fakeServer';
import { systemClock } from 'data/chat/util';
import type { ChannelWindow, WindowChange } from 'data/chat/types';
import {
  MESSAGE_TIMESTAMP_CLASS,
  consumesIntent,
  sameItemSequence,
  scrollActionForChange,
  type ResetIntent,
  type ScrollAction,
  type ScrollActionInput,
} from './scrollAnchoring';

const item = (id: string) => ({ id, createdAt: new Date(0), updatedAt: new Date(0) });
const A = [item('a'), item('b')];
const B = [item('a'), item('b'), item('c')];
const BY_DATE: ScrollAction = {
  type: 'lock',
  lock: { type: 'lockByVisibleItemDate', elementClassWithTimestamp: MESSAGE_TIMESTAMP_CLASS, dateOrder: 'ASC' },
};
const TO_BOTTOM: ScrollAction = { type: 'lock', lock: { type: 'scrollToBottom' } };

function action(change: WindowChange, over: Partial<ScrollActionInput> = {}): ScrollAction {
  return scrollActionForChange({
    change,
    prevItems: A,
    nextItems: B,
    intent: null,
    atBottom: false,
    wasAtLatest: true,
    ...over,
  });
}

describe('scrollActionForChange', () => {
  it('initial load and jump back to latest scroll to the bottom', () => {
    expect(action({ kind: 'reset', cause: 'init' }, { prevItems: [] })).toEqual(TO_BOTTOM);
    expect(action({ kind: 'reset', cause: 'latest' })).toEqual(TO_BOTTOM);
  });

  it('a jump scrolls to the target element of the intent', () => {
    const intent: ResetIntent = { type: 'element', elementId: 'c' };
    expect(action({ kind: 'reset', cause: 'jump' }, { intent })).toEqual({
      type: 'lock',
      lock: { type: 'scrollToElementId', elementId: 'c' },
    });
    // a first init at an item reports `jump` too
    expect(action({ kind: 'reset', cause: 'init' }, { intent, prevItems: [] })).toEqual({
      type: 'lock',
      lock: { type: 'scrollToElementId', elementId: 'c' },
    });
  });

  it('a resync keeps the reading position, or the bottom when reading the newest', () => {
    expect(action({ kind: 'reset', cause: 'resync' }, { atBottom: false })).toEqual(BY_DATE);
    expect(action({ kind: 'reset', cause: 'resync' }, { atBottom: true, wasAtLatest: false })).toEqual(BY_DATE);
    expect(action({ kind: 'reset', cause: 'resync' }, { atBottom: true, wasAtLatest: true })).toEqual(TO_BOTTOM);
  });

  it('a resync never consumes the intent of an init in flight', () => {
    const intent: ResetIntent = { type: 'element', elementId: 'c' };
    expect(consumesIntent({ kind: 'reset', cause: 'resync' })).toBe(false);
    expect(action({ kind: 'reset', cause: 'resync' }, { intent, atBottom: false })).toEqual(BY_DATE);
    expect(consumesIntent({ kind: 'reset', cause: 'jump' })).toBe(true);
    expect(consumesIntent({ kind: 'prepend', count: 1 })).toBe(false);
  });

  it('paging up does not jump: lock by the visible item', () => {
    expect(action({ kind: 'prepend', count: 1 }, { prevItems: A, nextItems: [item('z'), ...A] })).toEqual(BY_DATE);
    expect(action({ kind: 'append-page', count: 1 })).toEqual(BY_DATE);
    expect(action({ kind: 'trim', from: 'start', count: 1 }, { prevItems: B, nextItems: A.slice(1) })).toEqual(BY_DATE);
    expect(action({ kind: 'trim', from: 'end', count: 1 }, { prevItems: B, nextItems: A })).toEqual({ type: 'none' });
  });

  it('a live message sticks to the bottom only when there; an own send always shows', () => {
    expect(action({ kind: 'append-live', count: 1, own: false }, { atBottom: true })).toEqual(TO_BOTTOM);
    expect(action({ kind: 'append-live', count: 1, own: false }, { atBottom: false })).toEqual({ type: 'none' });
    expect(action({ kind: 'append-live', count: 1, own: true }, { atBottom: false })).toEqual(TO_BOTTOM);
  });

  it('in-place updates need no lock; a removal while scrolled up keeps the position', () => {
    expect(action({ kind: 'update' }, { prevItems: A, nextItems: [item('a'), item('b')] })).toEqual({ type: 'none' });
    expect(action({ kind: 'update' }, { prevItems: B, nextItems: A, atBottom: false })).toEqual(BY_DATE);
    expect(action({ kind: 'update' }, { prevItems: B, nextItems: A, atBottom: true })).toEqual({ type: 'none' });
  });

  it('never locks when the rendered sequence stays the same (no mutation would release it)', () => {
    expect(action({ kind: 'prepend', count: 0 }, { prevItems: A, nextItems: A })).toEqual({ type: 'none' });
    expect(action({ kind: 'reset', cause: 'resync' }, { prevItems: A, nextItems: [...A] })).toEqual({ type: 'none' });
    // an intent then acts at once
    expect(action({ kind: 'reset', cause: 'latest' }, { prevItems: A, nextItems: A, intent: { type: 'bottom' } }))
      .toEqual({ type: 'scrollToBottom' });
    expect(action({ kind: 'reset', cause: 'jump' }, { prevItems: A, nextItems: A, intent: { type: 'element', elementId: 'b' } }))
      .toEqual({ type: 'scrollToElement', elementId: 'b' });
  });

  it('sameItemSequence compares ids in order', () => {
    expect(sameItemSequence(A, [item('a'), item('b')])).toBe(true);
    expect(sameItemSequence(A, [item('b'), item('a')])).toBe(false);
    expect(sameItemSequence(A, B)).toBe(false);
  });
});

describe('scroll anchoring against real window changes', () => {
  const C = 'ch-1';

  async function settle() {
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks(50);
  }

  function setup(seed: number) {
    installFakeTimers({ now: new Date('2026-11-02T12:00:00Z') });
    const server = new FakeChatServer();
    const access = server.addChannel(C);
    server.seed(C, seed);
    let n = 0;
    const store = createChannelStore({
      api: server,
      events: server,
      clock: systemClock,
      newId: () => `local-${++n}`,
    });
    store.registerAccessForChannel(access);
    return { server, store };
  }

  /** the list's listener: decides with the state before the change, like GenericMessageList */
  function record(w: ChannelWindow, view: { atBottom: boolean; intent: ResetIntent | null }) {
    const actions: ScrollAction[] = [];
    let prev = w.state;
    w.subscribe((state, change) => {
      actions.push(scrollActionForChange({
        change,
        prevItems: prev.items,
        nextItems: state.items,
        intent: view.intent,
        atBottom: view.atBottom,
        wasAtLatest: prev.withEndOfList,
      }));
      if (consumesIntent(change)) view.intent = null;
      prev = state;
    });
    return actions;
  }

  it('init at the bottom, paging up locks by date, live message at the bottom sticks, own send shows', async () => {
    const { server, store } = setup(80);
    const w = store.openWindow(C);
    const view = { atBottom: true, intent: { type: 'bottom' } as ResetIntent | null };
    const actions = record(w, view);
    await w.init({ type: 'recent' });
    expect(actions.at(-1)).toEqual(TO_BOTTOM);

    view.atBottom = false;
    await w.loadOlder();
    await settle();
    expect(actions.at(-1)).toEqual(BY_DATE);

    // scrolled up: a live message does not move the view
    server.post(C, { text: 'live 1' });
    await settle();
    expect(actions.at(-1)).toEqual({ type: 'none' });

    view.atBottom = true;
    server.post(C, { text: 'live 2' });
    await settle();
    expect(actions.at(-1)).toEqual(TO_BOTTOM);

    view.atBottom = false;
    await store.createMessage({ channelId: C, body: textBody('mine'), attachments: [], parentMessageId: null });
    expect(actions.at(-1)).toEqual(TO_BOTTOM);
    store.dispose();
  });

  it('jump to an old message scrolls to it; jump back to latest scrolls to the bottom', async () => {
    const { server, store } = setup(120);
    const target = server.rows(C)[5];
    const w = store.openWindow(C);
    const view = { atBottom: true, intent: { type: 'bottom' } as ResetIntent | null };
    const actions = record(w, view);
    await w.init({ type: 'recent' });

    view.intent = { type: 'element', elementId: target.id };
    await w.init({ type: 'atItemId', itemId: target.id });
    expect(w.state.items.some(m => m.id === target.id)).toBe(true);
    expect(actions.at(-1)).toEqual({ type: 'lock', lock: { type: 'scrollToElementId', elementId: target.id } });
    expect(w.state.withEndOfList).toBe(false);

    view.intent = { type: 'bottom' };
    await w.jumpToLatest();
    expect(actions.at(-1)).toEqual(TO_BOTTOM);
    expect(w.state.withEndOfList).toBe(true);
    store.dispose();
  });
});
