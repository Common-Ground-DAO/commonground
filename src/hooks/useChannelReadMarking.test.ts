// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
// aliased: called from a plain setup helper, not a React hook
import { useDataLayerFakeTimers as installFakeTimers } from 'test/timers';
import { flushMicrotasks } from 'test/deferred';
import { createChannelStore } from 'data/chat/channelStore';
import { createReadStateStore } from 'data/chat/readStateStore';
import { FakeChatServer, textBody } from 'data/chat/testing/fakeServer';
import { systemClock } from 'data/chat/util';
import type { ReadMarker, ReadMarkingInput } from 'data/chat/types';
import {
  ReadMarkingController,
  isReadTrackedAccess,
  newestServerItem,
  readMarkingInput,
  sameReadMarkingInput,
} from './useChannelReadMarking';

// the hook's module reads the app runtime; these tests inject the stores
vi.mock('data/chat/runtime', () => ({ chat: {} }));

type Message = Models.Message.Message;
type State = Models.ItemList.ItemListState<Message>;

const C = 'ch-1';

function msg(id: string, iso: string, sendStatus?: Message['sendStatus']): Message {
  return {
    id,
    creatorId: 'u',
    channelId: C,
    body: textBody(id),
    attachments: [],
    editedAt: null,
    createdAt: new Date(iso),
    updatedAt: new Date(iso),
    reactions: {},
    ownReaction: null,
    parentMessageId: null,
    ...(sendStatus ? { sendStatus } : {}),
  };
}

function state(items: Message[], rangeEnd: string | null, over: Partial<State> = {}): State {
  return {
    items,
    isDestroyed: false,
    ready: true,
    rangeStart: items.length ? items[0].createdAt : null,
    rangeEnd: rangeEnd ? new Date(rangeEnd) : null,
    hasNextItemsLocally: false,
    hasNextItemsOnRemote: false,
    hasPreviousItemsLocally: false,
    hasPreviousItemsOnRemote: true,
    withStartOfList: false,
    withEndOfList: true,
    isEmpty: false,
    ...over,
  };
}

describe('readMarkingInput', () => {
  const a = msg('a', '2026-11-02T10:00:00Z');
  const b = msg('b', '2026-11-02T10:01:00Z');

  it('newest is the last server item, never a pending send', () => {
    const pending = msg('p', '2026-11-02T10:05:00Z', 'sending');
    const failed = msg('f', '2026-11-02T10:06:00Z', 'error-send');
    expect(newestServerItem(state([a, b, pending, failed], b.createdAt.toISOString()))).toEqual({ id: 'b', createdAt: b.createdAt });
  });

  it('a pending send behind a skewed local clock is skipped too', () => {
    const early = msg('p', '2026-11-02T09:00:00Z', 'sending');
    expect(newestServerItem(state([a, b, early], b.createdAt.toISOString()))).toEqual({ id: 'b', createdAt: b.createdAt });
  });

  it('an edit overlay on the newest server item still counts as the newest', () => {
    const edited = { ...b, sendStatus: 'error-update' as const };
    expect(newestServerItem(state([a, edited], b.createdAt.toISOString()))?.id).toBe('b');
  });

  it('only pending items (empty channel, own send) give no newest', () => {
    const pending = msg('p', '2026-11-02T10:05:00Z', 'sending');
    expect(newestServerItem(state([pending], null))).toBeNull();
  });

  it('maps the window flags', () => {
    expect(readMarkingInput(state([a], a.createdAt.toISOString(), { withEndOfList: false }), true))
      .toEqual({ atLatest: false, atBottom: true, newest: { id: 'a', createdAt: a.createdAt } });
  });

  it('compares inputs by value', () => {
    const x: ReadMarkingInput = { atLatest: true, atBottom: true, newest: { id: 'a', createdAt: new Date(1) } };
    expect(sameReadMarkingInput(x, { ...x, newest: { id: 'a', createdAt: new Date(1) } })).toBe(true);
    expect(sameReadMarkingInput(x, { ...x, atBottom: false })).toBe(false);
    expect(sameReadMarkingInput(x, { ...x, newest: null })).toBe(false);
  });

  it('call chats and article comments have no read state', () => {
    expect(isReadTrackedAccess({ channelId: C, communityId: 'c' })).toBe(true);
    expect(isReadTrackedAccess({ channelId: C, chatId: 'c' })).toBe(true);
    expect(isReadTrackedAccess(undefined)).toBe(true);
    expect(isReadTrackedAccess({ channelId: C, callId: 'x' })).toBe(false);
    expect(isReadTrackedAccess({ channelId: C, communityId: 'c', callId: 'x' } as API.Messages.MessageAccess)).toBe(false);
    expect(isReadTrackedAccess({ channelId: C, articleId: 'a', articleCommunityId: 'c' } as API.Messages.MessageAccess)).toBe(false);
  });
});

describe('ReadMarkingController', () => {
  function fakeReadState() {
    const markers: { channelId: string; updates: ReadMarkingInput[]; disposed: boolean }[] = [];
    return {
      markers,
      createMarker(channelId: string): ReadMarker {
        const m = { channelId, updates: [] as ReadMarkingInput[], disposed: false };
        markers.push(m);
        return { update: input => m.updates.push(input), dispose: () => { m.disposed = true; } };
      },
    };
  }
  const a = msg('a', '2026-11-02T10:00:00Z');

  it('one marker per channel, updated only on changed inputs, replaced on a channel switch', () => {
    const rs = fakeReadState();
    const c = new ReadMarkingController(rs, () => undefined);
    const s = state([a], a.createdAt.toISOString());
    c.report(C, s, true);
    c.report(C, { ...s }, true);
    expect(rs.markers).toHaveLength(1);
    expect(rs.markers[0].updates).toHaveLength(1);
    c.report(C, s, false);
    expect(rs.markers[0].updates.map(u => u.atBottom)).toEqual([true, false]);
    c.report('ch-2', s, false);
    expect(rs.markers[0].disposed).toBe(true);
    expect(rs.markers[1]).toMatchObject({ channelId: 'ch-2', disposed: false });
    c.dispose();
    expect(rs.markers[1].disposed).toBe(true);
    // reusable after dispose (React StrictMode re-runs effects)
    c.report(C, s, true);
    expect(rs.markers).toHaveLength(3);
  });

  it('no marker for a call chat', () => {
    const rs = fakeReadState();
    const c = new ReadMarkingController(rs, () => ({ channelId: C, callId: 'call' }));
    c.report(C, state([a], a.createdAt.toISOString()), true);
    expect(rs.markers).toHaveLength(0);
  });
});

describe('read marking against the real stores', () => {
  async function settle() {
    await vi.advanceTimersByTimeAsync(0);
    await flushMicrotasks(50);
  }

  function setup() {
    installFakeTimers({ now: new Date('2026-11-02T12:00:00Z') });
    const server = new FakeChatServer();
    const access = server.addChannel(C);
    server.seed(C, 5);
    let n = 0;
    const channels = createChannelStore({ api: server, events: server, clock: systemClock, newId: () => `local-${++n}` });
    channels.registerAccessForChannel(access);
    const readState = createReadStateStore({
      api: server,
      events: server,
      clock: systemClock,
      getAccess: id => channels.getAccessForChannel(id),
    });
    const controller = new ReadMarkingController(readState, id => channels.getAccessForChannel(id));
    return { server, channels, readState, controller };
  }

  it('marks up to the newest server item while at the bottom of the latest messages', async () => {
    const { server, channels, readState, controller } = setup();
    const w = channels.openWindow(C);
    w.subscribe(s => controller.report(C, s, true));
    await w.init({ type: 'recent' });
    await settle();
    const newest = server.rows(C).at(-1)!;
    expect(server.callsOf('setChannelLastRead')).toHaveLength(1);
    expect(readState.get(C)?.lastRead).toBe(newest.createdAt);
    channels.dispose();
    readState.dispose();
  });

  it('scrolled up: a live message is not marked until the list is at the bottom again', async () => {
    const { server, channels, readState, controller } = setup();
    const w = channels.openWindow(C);
    let atBottom = true;
    w.subscribe(s => controller.report(C, s, atBottom));
    await w.init({ type: 'recent' });
    await settle();
    atBottom = false;
    controller.report(C, w.state, atBottom);
    const live = server.post(C, { text: 'later' }).data as { createdAt: string };
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(server.callsOf('setChannelLastRead')).toHaveLength(1);
    atBottom = true;
    controller.report(C, w.state, atBottom);
    await settle();
    const calls = server.callsOf('setChannelLastRead') as { lastRead: string }[];
    expect(calls.at(-1)?.lastRead).toBe(live.createdAt);
    channels.dispose();
    readState.dispose();
  });

  it('an own pending send does not move the mark beyond the server items', async () => {
    const { server, channels, readState, controller } = setup();
    server.hold('createMessage');
    const w = channels.openWindow(C);
    w.subscribe(s => controller.report(C, s, true));
    await w.init({ type: 'recent' });
    await settle();
    const before = server.callsOf('setChannelLastRead').length;
    await channels.createMessage({ channelId: C, body: textBody('mine'), attachments: [], parentMessageId: null });
    await settle();
    await vi.advanceTimersByTimeAsync(5_000);
    expect(w.state.items.at(-1)?.sendStatus).toBe('sending');
    expect(server.callsOf('setChannelLastRead')).toHaveLength(before);
    channels.dispose();
    readState.dispose();
  });
});
