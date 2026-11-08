// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
// aliased: called from a plain setup helper, not a React hook
import { useDataLayerFakeTimers as installFakeTimers } from 'test/timers';
import { flushMicrotasks } from 'test/deferred';
import { createChannelStore, RESYNC_DEBOUNCE_MS } from './channelStore';
import { FakeChatServer, ME, textBody, textOf } from './testing/fakeServer';
import { systemClock } from './util';
import {
  ACCESS_WAIT_MS,
  CHANNEL_LRU_SIZE,
  GAP_RESYNC_DEBOUNCE_MS,
  LATEST_SEGMENT_MAX,
  SEND_TIMEOUT_MS,
  WINDOW_ERROR,
  type ChannelWindow,
  type WindowChange,
} from './types';

type Message = Models.Message.Message;

const C = 'ch-1';

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await flushMicrotasks(50);
}

function setup(options: { oldServer?: boolean; seed?: number } = {}) {
  installFakeTimers({ now: new Date('2026-11-02T12:00:00Z') });
  const server = new FakeChatServer();
  server.oldServer = !!options.oldServer;
  const access = server.addChannel(C);
  if (options.seed) server.seed(C, options.seed);
  const own: Message[] = [];
  let n = 0;
  const store = createChannelStore({
    api: server,
    events: server,
    clock: systemClock,
    newId: () => `local-${String(++n).padStart(3, '0')}`,
    onOwnMessage: m => own.push(m),
  });
  store.registerAccessForChannel(access);
  return { server, store, access, own };
}

function watch(w: ChannelWindow) {
  const changes: WindowChange[] = [];
  w.subscribe((_s, c) => changes.push(c));
  return changes;
}

const texts = (w: ChannelWindow) => w.state.items.map(m => textOf(m));
const ids = (w: ChannelWindow) => w.state.items.map(m => m.id);

async function openRecent(store: ReturnType<typeof setup>['store'], channelId = C) {
  const w = store.openWindow(channelId);
  const changes = watch(w);
  const p = w.init({ type: 'recent' });
  await settle();
  await p;
  return { w, changes };
}

describe('ChannelStore: init and snapshots', () => {
  it('init(recent) loads the latest page with a reset and sets the cursor', async () => {
    const { server, store } = setup({ seed: 40 });
    const { w, changes } = await openRecent(store);
    expect(server.callsOf('getChanges')).toEqual([{ access: { channelId: C, communityId: 'community-1' }, cursor: null, limit: 200 }]);
    expect(w.state.items).toHaveLength(30);
    expect(texts(w).at(-1)).toBe('seed 39');
    expect(w.state).toMatchObject({ ready: true, withEndOfList: true, withStartOfList: false, hasPreviousItemsOnRemote: true, hasNextItemsOnRemote: false });
    expect(changes).toEqual([{ kind: 'reset', cause: 'init' }]);
    expect(store.getCursor(C)).toBe('1:40');
  });

  it('an empty channel is ready and empty', async () => {
    const { store } = setup();
    const { w } = await openRecent(store);
    expect(w.state).toMatchObject({ ready: true, isEmpty: true, withStartOfList: true, withEndOfList: true, items: [] });
  });

  it('B1: a live message during the first snapshot is not lost (snapshot computed before it)', async () => {
    const { server, store } = setup({ seed: 2 });
    server.hold('getChanges');
    const w = store.openWindow(C);
    const p = w.init({ type: 'recent' });
    await settle();
    expect(server.heldCount('getChanges')).toBe(1);
    server.post(C, { text: 'live during snapshot' });
    server.release('getChanges');
    await settle();
    await p;
    expect(texts(w)).toEqual(['seed 0', 'seed 1', 'live during snapshot']);
    expect(store.getCursor(C)).toBe('1:3');
  });

  it('B1: an older range page never deletes a newer live item', async () => {
    const { server, store } = setup({ seed: 35 });
    const { w } = await openRecent(store);
    server.hold('loadMessages');
    const older = w.loadOlder();
    await settle();
    server.post(C, { text: 'live' });
    server.release('loadMessages');
    await older;
    await settle();
    expect(texts(w).at(-1)).toBe('live');
    expect(w.state.items).toHaveLength(36);
    expect(w.state.withStartOfList).toBe(true);
  });

  it('init without a registered access waits for it', async () => {
    installFakeTimers();
    const server = new FakeChatServer();
    const access = server.addChannel(C);
    server.seed(C, 3);
    const store = createChannelStore({ api: server, events: server, clock: systemClock, newId: () => 'x' });
    const w = store.openWindow(C);
    const p = w.init({ type: 'recent' });
    await settle();
    expect(server.calls).toHaveLength(0);
    store.registerAccessForChannel(access);
    await settle();
    await expect(p).resolves.toBe(3);
  });

  it('init gives up with NO_ACCESS when the access stays unknown; a later init succeeds', async () => {
    installFakeTimers();
    const server = new FakeChatServer();
    const access = server.addChannel(C, { chatId: 'chat-1' });
    server.seed(C, 2);
    const store = createChannelStore({ api: server, events: server, clock: systemClock, newId: () => 'x' });
    const w = store.openWindow(C);
    const p = w.init({ type: 'recent' });
    const outcome = p.then(() => 'resolved', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(ACCESS_WAIT_MS - 1);
    await settle();
    expect(server.calls).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(await outcome).toBe(WINDOW_ERROR.NO_ACCESS);
    store.registerAccessForChannel(access);
    await expect(w.init({ type: 'recent' })).resolves.toBe(2);
  });

  it('a window that ended in NO_ACCESS re-inits by itself once the access is registered', async () => {
    installFakeTimers();
    const server = new FakeChatServer();
    const access = server.addChannel(C, { chatId: 'chat-1' });
    server.seed(C, 2);
    const store = createChannelStore({ api: server, events: server, clock: systemClock, newId: () => 'x' });
    const w = store.openWindow(C);
    const changes = watch(w);
    const failed = w.init({ type: 'recent' }).then(() => 'resolved', (e: Error) => e.message);
    await vi.advanceTimersByTimeAsync(ACCESS_WAIT_MS);
    expect(await failed).toBe(WINDOW_ERROR.NO_ACCESS);
    expect(w.state.ready).toBe(false);
    // e.g. getSyncState registered it later
    store.registerAccessForChannel(access);
    await settle();
    expect(w.state.ready).toBe(true);
    expect(w.state.items).toHaveLength(2);
    expect(changes.at(-1)).toEqual({ kind: 'reset', cause: 'init' });
    // a destroyed window is left alone
    const gone = store.openWindow('ch-2');
    const goneInit = gone.init({ type: 'recent' }).catch(() => undefined);
    await vi.advanceTimersByTimeAsync(ACCESS_WAIT_MS);
    await goneInit;
    gone.destroy();
    const calls = server.calls.length;
    store.registerAccessForChannel(server.addChannel('ch-2'));
    await settle();
    expect(server.calls.length).toBe(calls);
  });
});

describe('ChannelStore: live events and the version rule', () => {
  it('appends live messages with append-live', async () => {
    const { server, store } = setup({ seed: 3 });
    const { w, changes } = await openRecent(store);
    server.post(C, { text: 'a' });
    expect(texts(w).at(-1)).toBe('a');
    expect(changes.at(-1)).toEqual({ kind: 'append-live', count: 1, own: false });
    expect(store.getCursor(C)).toBe('1:4');
  });

  it('duplicate events are applied once', async () => {
    const { server, store } = setup({ seed: 3 });
    const { w, changes } = await openRecent(store);
    const created = server.post(C, { text: 'a' }, { deliver: false });
    const edited = server.edit(C, server.rows(C)[3].id, 'a2', { deliver: false });
    server.deliver(created);
    server.deliver(created);
    server.deliver(edited);
    server.deliver(edited);
    server.deliver(created);
    expect(texts(w)).toEqual(['seed 0', 'seed 1', 'seed 2', 'a2']);
    expect(changes.filter(c => c.kind !== 'reset')).toHaveLength(2);
    expect(store.getCursor(C)).toBe('1:5');
  });

  it('reaction 12 before edit 11: the reaction applies, the edit is dropped, the gap catch-up fixes the body', async () => {
    const { server, store } = setup({ seed: 10 });
    const { w } = await openRecent(store);
    const target = server.rows(C)[9].id;
    const edit = server.edit(C, target, 'edited', { deliver: false });
    const reaction = server.react(C, target, '👍', { deliver: false });
    expect([edit.data.syncSeq, reaction.data.syncSeq]).toEqual([11, 12]);
    server.deliver(reaction);
    server.deliver(edit);
    const shown = () => w.state.items.find(m => m.id === target)!;
    expect(shown().reactions).toEqual({ '👍': 1 });
    expect(textOf(shown())).toBe('seed 9');
    // the dropped delta keeps the gap open
    expect(store.getCursor(C)).toBe('1:10');
    expect(server.callsOf('getChanges')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(GAP_RESYNC_DEBOUNCE_MS);
    await settle();
    expect(server.callsOf('getChanges')).toHaveLength(2);
    expect(server.callsOf('getChanges')[1]).toMatchObject({ cursor: '1:10' });
    expect(textOf(shown())).toBe('edited');
    expect(shown().reactions).toEqual({ '👍': 1 });
    expect(store.getCursor(C)).toBe('1:12');
  });

  it('a gap from a lost event triggers getChanges after the debounce', async () => {
    const { server, store } = setup({ seed: 2 });
    const { w } = await openRecent(store);
    server.post(C, { text: 'lost' }, { deliver: false });
    server.post(C, { text: 'seen' });
    expect(texts(w)).toEqual(['seed 0', 'seed 1', 'seen']);
    await vi.advanceTimersByTimeAsync(GAP_RESYNC_DEBOUNCE_MS - 1);
    expect(server.callsOf('getChanges')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(texts(w)).toEqual(['seed 0', 'seed 1', 'lost', 'seen']);
    expect(store.getCursor(C)).toBe('1:4');
  });

  it('a gap closed by a late event before the debounce needs no getChanges', async () => {
    const { server, store } = setup({ seed: 2 });
    const { w } = await openRecent(store);
    const late = server.post(C, { text: 'late' }, { deliver: false });
    server.post(C, { text: 'early' });
    server.deliver(late);
    await vi.advanceTimersByTimeAsync(GAP_RESYNC_DEBOUNCE_MS * 2);
    expect(server.callsOf('getChanges')).toHaveLength(1);
    expect(texts(w)).toEqual(['seed 0', 'seed 1', 'late', 'early']);
  });

  it('tombstones beat late versions from events, pages and getChanges', async () => {
    const { server, store } = setup({ seed: 3 });
    const { w } = await openRecent(store);
    const created = server.post(C, { text: 'doomed' }, { deliver: false });
    const id = (created.data as { id: string }).id;
    const edit = server.edit(C, id, 'doomed edit', { deliver: false });
    const removed = server.remove(C, [id], { deliver: false });
    server.deliver(removed);
    server.deliver(created);
    server.deliver(edit);
    expect(ids(w)).not.toContain(id);
    // a stale page containing the id: deliver the old `new` again and run a catch-up
    server.goLive();
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    await settle();
    server.deliver(created);
    expect(ids(w)).not.toContain(id);
    expect(store.getCursor(C)).toBe('1:6');
  });

  it('a multi-row delete records every seq (no false gap)', async () => {
    const { server, store } = setup({ seed: 5 });
    const { w } = await openRecent(store);
    const rows = server.rows(C);
    server.remove(C, [rows[1].id, rows[3].id]);
    expect(texts(w)).toEqual(['seed 0', 'seed 2', 'seed 4']);
    expect(store.getCursor(C)).toBe('1:7');
    await vi.advanceTimersByTimeAsync(GAP_RESYNC_DEBOUNCE_MS * 2);
    expect(server.callsOf('getChanges')).toHaveLength(1);
  });

  it('updates to messages outside memory count as seen (no catch-up for them)', async () => {
    const { server, store } = setup({ seed: 50 });
    await openRecent(store);
    server.react(C, server.rows(C)[0].id, '🎉');
    expect(store.getCursor(C)).toBe('1:51');
  });
});

describe('ChannelStore: reconnect and resets', () => {
  it('B2/E3: posts and an edit while offline appear in order after the live signal, and live keeps working', async () => {
    const { server, store } = setup({ seed: 5 });
    const { w, changes } = await openRecent(store);
    server.goOffline();
    const older = server.rows(C)[2].id;
    server.post(C, { text: 'off 1' });
    server.post(C, { text: 'off 2' });
    server.post(C, { text: 'off 3' });
    server.edit(C, older, 'edited offline');
    expect(texts(w)).toHaveLength(5);
    server.goLive('restored');
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    await settle();
    expect(texts(w)).toEqual(['seed 0', 'seed 1', 'edited offline', 'seed 3', 'seed 4', 'off 1', 'off 2', 'off 3']);
    expect(changes.at(-1)).toEqual({ kind: 'append-live', count: 3, own: false });
    expect(server.callsOf('getChanges').at(-1)).toMatchObject({ cursor: '1:5' });
    server.post(C, { text: 'after' });
    expect(texts(w).at(-1)).toBe('after');
    expect(store.getCursor(C)).toBe('1:10');
  });

  it('onResume runs a catch-up too, coalesced with onLive', async () => {
    const { server, store } = setup({ seed: 1 });
    await openRecent(store);
    server.goLive();
    server.resume('visible');
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    await settle();
    expect(server.callsOf('getChanges')).toHaveLength(2);
  });

  it('follows hasMore', async () => {
    const { server, store } = setup({ seed: 1 });
    const { w } = await openRecent(store);
    server.goOffline();
    for (let i = 0; i < 250; i++) server.post(C, { text: `p${i}` });
    server.goLive();
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    await settle();
    const calls = server.callsOf('getChanges') as { cursor: string }[];
    expect(calls.map(c => c.cursor)).toEqual([null, '1:1', '1:201']);
    expect(texts(w).at(-1)).toBe('p249');
    expect(store.getCursor(C)).toBe('1:251');
  });

  it('reset vs live: a too-old cursor resets the window, a live item above S survives', async () => {
    const { server, store } = setup({ seed: 5 });
    const { w, changes } = await openRecent(store);
    server.goOffline();
    for (let i = 0; i < 600; i++) server.post(C, { text: `x${i}` });
    server.hold('getChanges');
    server.goLive();
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    await settle();
    expect(server.heldCount('getChanges')).toBe(1);
    server.post(C, { text: 'live above S' });
    server.release('getChanges');
    await settle();
    expect(texts(w).at(-1)).toBe('live above S');
    expect(texts(w).at(-2)).toBe('x599');
    expect(texts(w)).not.toContain('seed 4');
    expect(changes.some(c => c.kind === 'reset' && c.cause === 'resync')).toBe(true);
    expect(store.getCursor(C)).toBe('1:606');
  });

  it('a reset re-initialises a detached window at its first visible item', async () => {
    const { server, store } = setup({ seed: 100 });
    await openRecent(store);
    const jump = store.openWindow(C);
    const jumpChanges = watch(jump);
    const target = server.rows(C)[20];
    const p = jump.init({ type: 'atItemId', itemId: target.id });
    await settle();
    await p;
    expect(jump.state.withEndOfList).toBe(false);
    server.goOffline();
    for (let i = 0; i < 600; i++) server.post(C, { text: `x${i}` });
    server.goLive();
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    await settle();
    expect(jumpChanges.at(-1)).toEqual({ kind: 'reset', cause: 'resync' });
    expect(ids(jump)).toContain(target.id);
  });
});

describe('ChannelStore: sending', () => {
  it('inserts the pending item synchronously, before the API call', async () => {
    const { server, store, own } = setup({ seed: 2 });
    const { w, changes } = await openRecent(store);
    const p = store.createMessage({ channelId: C, body: textBody('mine'), attachments: [], parentMessageId: null });
    expect(w.state.items.at(-1)).toMatchObject({ id: 'local-001', sendStatus: 'sending', creatorId: ME });
    expect(changes.at(-1)).toEqual({ kind: 'append-live', count: 1, own: true });
    expect(server.callsOf('createMessage')).toHaveLength(0);
    await p;
    await settle();
    expect(server.callsOf('createMessage')).toMatchObject([{ id: 'local-001' }]);
    const item = w.state.items.at(-1)!;
    expect(item.id).toBe('local-001');
    expect(item.sendStatus).toBeUndefined();
    expect(item.syncSeq).toBe(3);
    expect(w.state.items).toHaveLength(3);
    expect(own.map(m => m.id)).toEqual(['local-001']);
    expect(store.getCursor(C)).toBe('1:3');
  });

  it('failure -> error-send, retry reuses the id, discard removes', async () => {
    const { server, store } = setup();
    const { w } = await openRecent(store);
    server.fail('createMessage', new Error('Network down'), 1);
    await store.createMessage({ channelId: C, body: textBody('a'), attachments: [], parentMessageId: null });
    await settle();
    expect(w.state.items).toMatchObject([{ id: 'local-001', sendStatus: 'error-send' }]);
    expect(textOf(w.state.items[0])).toBe('a');
    await store.retrySend(C, 'local-001');
    expect(w.state.items[0].sendStatus).toBe('sending');
    await settle();
    expect(w.state.items).toHaveLength(1);
    expect(w.state.items[0].sendStatus).toBeUndefined();
    expect((server.callsOf('createMessage') as { id: string }[]).map(c => c.id)).toEqual(['local-001', 'local-001']);

    server.fail('createMessage', new Error('Network down'), 1);
    await store.createMessage({ channelId: C, body: textBody('b'), attachments: [], parentMessageId: null });
    await settle();
    expect(w.state.items.at(-1)!.sendStatus).toBe('error-send');
    store.discardPending(C, 'local-002');
    expect(ids(w)).toEqual(['local-001']);
  });

  it('B9: an offline send ends in error-send, never stuck in sending', async () => {
    const { server, store } = setup();
    const { w } = await openRecent(store);
    server.fail('createMessage', new Error('Unexpected status: 0'));
    await store.createMessage({ channelId: C, body: textBody('offline'), attachments: [], parentMessageId: null });
    await settle();
    expect(w.state.items[0].sendStatus).toBe('error-send');
  });

  it('a send without answer shows error-send after the timeout; a late success still resolves it', async () => {
    const { server, store, own } = setup();
    const { w } = await openRecent(store);
    server.hold('createMessage');
    await store.createMessage({ channelId: C, body: textBody('slow'), attachments: [], parentMessageId: null });
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    expect(w.state.items[0].sendStatus).toBe('error-send');
    server.release('createMessage');
    await settle();
    expect(w.state.items[0].sendStatus).toBeUndefined();
    expect(own).toHaveLength(1);
  });

  it('a retry after a lost response on an old server finds the stored message', async () => {
    const { server, store } = setup();
    const { w } = await openRecent(store);
    server.hold('createMessage');
    await store.createMessage({ channelId: C, body: textBody('lost answer'), attachments: [], parentMessageId: null });
    await vi.advanceTimersByTimeAsync(SEND_TIMEOUT_MS);
    expect(w.state.items[0].sendStatus).toBe('error-send');
    server.oldServer = true;
    await store.retrySend(C, 'local-001');
    await settle();
    expect(server.callsOf('messagesById')).toHaveLength(1);
    expect(w.state.items).toHaveLength(1);
    expect(w.state.items[0].sendStatus).toBeUndefined();
    server.release('createMessage');
    await settle();
    expect(w.state.items).toHaveLength(1);
  });

  it('own echo: HTTP response + own event + catch-up page give one item and one onOwnMessage', async () => {
    const { server, store, own } = setup();
    const { w } = await openRecent(store);
    server.echoOwn = true;
    server.hold('createMessage');
    await store.createMessage({ channelId: C, body: textBody('echo'), attachments: [], parentMessageId: null });
    await settle();
    // the own `new` event (another tab's socket path) arrives before the response
    expect(w.state.items).toHaveLength(1);
    expect(w.state.items[0].sendStatus).toBeUndefined();
    server.release('createMessage');
    await settle();
    server.goLive();
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    await settle();
    expect(ids(w)).toEqual(['local-001']);
    expect(own).toHaveLength(1);
  });

  it('pending items are shown only at the latest end', async () => {
    const { server, store } = setup({ seed: 80 });
    await openRecent(store);
    const jump = store.openWindow(C);
    const p = jump.init({ type: 'atItemId', itemId: server.rows(C)[5].id });
    await settle();
    await p;
    await store.createMessage({ channelId: C, body: textBody('x'), attachments: [], parentMessageId: null });
    expect(jump.state.items.some(m => m.sendStatus)).toBe(false);
  });
});

describe('ChannelStore: editing', () => {
  it('B8: a successful edit shows the overlay, then clears sendStatus', async () => {
    const { store } = setup({ seed: 2 });
    const { w } = await openRecent(store);
    const msg = w.state.items[1];
    await store.editMessage(msg, { body: textBody('new text'), attachments: [], parentMessageId: null });
    expect(w.state.items[1]).toMatchObject({ sendStatus: 'sending' });
    expect(textOf(w.state.items[1])).toBe('new text');
    await settle();
    expect(w.state.items[1].sendStatus).toBeUndefined();
    expect(textOf(w.state.items[1])).toBe('new text');
    expect(w.state.items[1].syncSeq).toBe(3);
    expect(store.getCursor(C)).toBe('1:3');
  });

  it('a failed edit -> error-update; retry succeeds; discard reverts', async () => {
    const { server, store } = setup({ seed: 2 });
    const { w } = await openRecent(store);
    server.fail('editMessage', new Error('Network down'), 1);
    await store.editMessage(w.state.items[0], { body: textBody('try'), attachments: [], parentMessageId: null });
    await settle();
    expect(w.state.items[0].sendStatus).toBe('error-update');
    await store.retrySend(C, w.state.items[0].id);
    await settle();
    expect(w.state.items[0].sendStatus).toBeUndefined();
    expect(textOf(w.state.items[0])).toBe('try');

    server.fail('editMessage', new Error('Network down'), 1);
    await store.editMessage(w.state.items[1], { body: textBody('nope'), attachments: [], parentMessageId: null });
    await settle();
    store.discardPending(C, w.state.items[1].id);
    expect(textOf(w.state.items[1])).toBe('seed 1');
    expect(w.state.items[1].sendStatus).toBeUndefined();
  });

  it('an edit response older than a stored reaction keeps the overlay until the full row arrives', async () => {
    const { server, store } = setup({ seed: 2 });
    const { w } = await openRecent(store);
    const target = w.state.items[1];
    server.hold('editMessage');
    await store.editMessage(target, { body: textBody('mine'), attachments: [], parentMessageId: null });
    await settle();
    server.react(C, target.id, '❤️');
    server.release('editMessage');
    await settle();
    // edit seq 3 < reaction seq 4: the body comes from the overlay, without sendStatus
    const shown = w.state.items[1];
    expect(shown.sendStatus).toBeUndefined();
    expect(textOf(shown)).toBe('mine');
    expect(shown.reactions).toEqual({ '❤️': 1 });
    await vi.advanceTimersByTimeAsync(GAP_RESYNC_DEBOUNCE_MS);
    await settle();
    expect(textOf(w.state.items[1])).toBe('mine');
    expect(w.state.items[1].syncSeq).toBe(4);
    expect(store.getCursor(C)).toBe('1:4');
  });
});

describe('ChannelStore: jumps, paging and trimming', () => {
  it('jump to a message: detached segment, live arrivals stay out, loadNewer re-attaches', async () => {
    const { server, store } = setup({ seed: 100 });
    await openRecent(store);
    const w = store.openWindow(C);
    const changes = watch(w);
    const target = server.rows(C)[10];
    const p = w.init({ type: 'atItemId', itemId: target.id });
    await settle();
    expect(await p).toBeGreaterThan(0);
    expect(changes.at(-1)).toEqual({ kind: 'reset', cause: 'jump' });
    expect(ids(w)).toContain(target.id);
    expect(w.state).toMatchObject({ withEndOfList: false, hasNextItemsOnRemote: true });
    server.post(C, { text: 'live while detached' });
    expect(texts(w)).not.toContain('live while detached');
    for (let i = 0; i < 10 && !w.state.withEndOfList; i++) {
      const more = w.loadNewer();
      await settle();
      await more;
    }
    expect(w.state.withEndOfList).toBe(true);
    expect(texts(w).at(-1)).toBe('live while detached');
    expect(changes.filter(c => c.kind === 'append-page').length).toBeGreaterThan(0);
    // contiguous: every seed from the jump target on is there once
    const shown = texts(w);
    expect(new Set(shown).size).toBe(shown.length);
    server.post(C, { text: 'live after re-attach' });
    expect(texts(w).at(-1)).toBe('live after re-attach');
  });

  it('jump to a missing or deleted message rejects with NOT_FOUND', async () => {
    const { server, store } = setup({ seed: 5 });
    const { w } = await openRecent(store);
    const p = w.init({ type: 'atItemId', itemId: 'nope' });
    const assertion = expect(p).rejects.toThrow(WINDOW_ERROR.NOT_FOUND);
    await settle();
    await assertion;
    const id = server.rows(C)[1].id;
    server.remove(C, [id]);
    await expect(w.init({ type: 'atItemId', itemId: id })).rejects.toThrow(WINDOW_ERROR.NOT_FOUND);
  });

  it('jump to a message in memory needs no request', async () => {
    const { server, store } = setup({ seed: 40 });
    const { w } = await openRecent(store);
    const before = server.calls.length;
    const target = w.state.items[15];
    await w.init({ type: 'atItemId', itemId: target.id });
    expect(server.calls.length).toBe(before);
    expect(ids(w)).toContain(target.id);
  });

  it('jump in a fresh channel loads the latest segment as well (live events have a home)', async () => {
    const { server, store } = setup({ seed: 100 });
    const w = store.openWindow(C);
    const p = w.init({ type: 'atItemId', itemId: server.rows(C)[50].id });
    await settle();
    await p;
    expect(server.callsOf('getChanges')).toHaveLength(1);
    server.post(C, { text: 'live' });
    await w.jumpToLatest();
    expect(texts(w).at(-1)).toBe('live');
  });

  it('a later init supersedes an earlier one; destroy too', async () => {
    const { server, store } = setup({ seed: 50 });
    const { w } = await openRecent(store);
    server.hold('messagesById');
    const first = w.init({ type: 'atItemId', itemId: server.rows(C)[2].id });
    const firstAssert = expect(first).rejects.toThrow(WINDOW_ERROR.SUPERSEDED);
    await settle();
    const second = w.init({ type: 'recent' });
    await firstAssert;
    await second;
    server.hold('messagesById');
    const third = w.init({ type: 'atItemId', itemId: server.rows(C)[3].id });
    const thirdAssert = expect(third).rejects.toThrow(WINDOW_ERROR.SUPERSEDED);
    await settle();
    w.destroy();
    await thirdAssert;
    expect(w.state.isDestroyed).toBe(true);
  });

  it('loadOlder uses memory first, then the server', async () => {
    const { server, store } = setup({ seed: 100 });
    const { w, changes } = await openRecent(store);
    w.trim({ keep: 10, from: 'start' });
    expect(changes.at(-1)).toEqual({ kind: 'trim', from: 'start', count: 20 });
    expect(w.state.hasPreviousItemsLocally).toBe(true);
    const before = server.calls.length;
    await w.loadOlder(20);
    expect(server.calls.length).toBe(before);
    expect(changes.at(-1)).toEqual({ kind: 'prepend', count: 20 });
    const p = w.loadOlder();
    await settle();
    await p;
    expect(server.calls.length).toBe(before + 1);
    expect(w.state.items).toHaveLength(60);
  });

  it('trimming the latest segment never drops items of a visible slice', async () => {
    const { server, store } = setup({ seed: 260 });
    const { w } = await openRecent(store);
    for (let i = 0; i < 10; i++) {
      const p = w.loadOlder();
      await settle();
      await p;
    }
    expect(w.state.items).toHaveLength(260);
    server.post(C, { text: 'live' });
    expect(w.state.items).toHaveLength(261);
    expect(w.state.withStartOfList).toBe(true);
    w.trim({ keep: 30, from: 'start' });
    expect(w.state.items).toHaveLength(30);
    expect(texts(w).at(-1)).toBe('live');
    // the store dropped what nobody shows down to LATEST_SEGMENT_MAX
    w.trim({ keep: 30, from: 'start' });
    let local = 0;
    while (w.state.hasPreviousItemsLocally) {
      await w.loadOlder(10);
      local++;
    }
    expect(w.state.items.length).toBe(LATEST_SEGMENT_MAX);
    expect(local).toBeGreaterThan(0);
    expect(w.state.hasPreviousItemsOnRemote).toBe(true);
  });

  it('loadNewer is a no-op at the latest end; trim at the end detaches from live', async () => {
    const { server, store } = setup({ seed: 40 });
    const { w, changes } = await openRecent(store);
    const n = changes.length;
    await w.loadNewer();
    expect(changes.length).toBe(n);
    w.trim({ keep: 10, from: 'end' });
    expect(w.state).toMatchObject({ withEndOfList: false, hasNextItemsLocally: true });
    server.post(C, { text: 'not appended' });
    expect(texts(w)).not.toContain('not appended');
    await w.loadNewer(100);
    expect(w.state.withEndOfList).toBe(true);
    expect(texts(w).at(-1)).toBe('not appended');
  });

  it('init atDate shows the items around the date', async () => {
    const { server, store } = setup({ seed: 100 });
    await openRecent(store);
    const w = store.openWindow(C);
    const target = server.rows(C)[30];
    const p = w.init({ type: 'atDate', date: new Date(target.createdAt) });
    await settle();
    await p;
    expect(ids(w)).toContain(target.id);
    expect(w.state.withEndOfList).toBe(false);
  });
});

describe('ChannelStore: windows, watchers, LRU', () => {
  it('several windows on one channel each get their own slice and listeners', async () => {
    const { server, store } = setup({ seed: 60 });
    const a = await openRecent(store);
    const b = await openRecent(store);
    expect(server.callsOf('getChanges').length).toBeGreaterThanOrEqual(1);
    server.post(C, { text: 'both' });
    expect(texts(a.w).at(-1)).toBe('both');
    expect(texts(b.w).at(-1)).toBe('both');
    const p = b.w.init({ type: 'atItemId', itemId: server.rows(C)[3].id });
    await settle();
    await p;
    server.post(C, { text: 'only a' });
    expect(texts(a.w).at(-1)).toBe('only a');
    expect(texts(b.w)).not.toContain('only a');
    a.w.destroy();
    expect(a.w.state.isDestroyed).toBe(true);
    await b.w.jumpToLatest();
    expect(texts(b.w).at(-1)).toBe('only a');
  });

  it('watchMessage works without a window and follows changes and deletion', async () => {
    const { server, store } = setup({ seed: 3 });
    const target = server.rows(C)[1];
    const seen: (string | undefined)[] = [];
    const unwatch = store.watchMessage(C, target.id, m => seen.push(m ? textOf(m) : undefined));
    expect(seen).toEqual([]);
    await settle();
    expect(seen).toEqual(['seed 1']);
    server.edit(C, target.id, 'edited');
    expect(seen).toEqual(['seed 1', 'edited']);
    server.remove(C, [target.id]);
    expect(seen).toEqual(['seed 1', 'edited', undefined]);
    unwatch();
  });

  it('watchMessage answers synchronously from memory, undefined for unknown ids, retries after a network error', async () => {
    const { server, store } = setup({ seed: 3 });
    const { w } = await openRecent(store);
    const seen: (string | undefined)[] = [];
    store.watchMessage(C, w.state.items[0].id, m => seen.push(m ? textOf(m) : undefined));
    expect(seen).toEqual(['seed 0']);
    const missing: unknown[] = [];
    store.watchMessage(C, 'nope', m => missing.push(m));
    await settle();
    expect(missing).toEqual([undefined]);

    server.fail('messagesById', new Error('Network down'), 1);
    const late: (string | undefined)[] = [];
    store.watchMessage(C, server.rows(C)[2].id, m => late.push(m ? textOf(m) : undefined));
    await settle();
    expect(late).toEqual(['seed 2']); // in memory already
    const other = server.addChannel('ch-2');
    store.registerAccessForChannel(other);
    server.seed('ch-2', 1);
    const retried: (string | undefined)[] = [];
    server.fail('messagesById', new Error('Network down'), 1);
    store.watchMessage('ch-2', server.rows('ch-2')[0].id, m => retried.push(m ? textOf(m) : undefined));
    await settle();
    expect(retried).toEqual([]);
    server.goLive();
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    await settle();
    expect(retried).toEqual(['seed 0']);
  });

  it('keeps at most CHANNEL_LRU_SIZE unpinned channels; windows, watchers and pending sends pin', async () => {
    const { server, store } = setup();
    const total = CHANNEL_LRU_SIZE + 5;
    for (let i = 0; i < total; i++) {
      store.registerAccessForChannel(server.addChannel(`c${i}`));
      server.seed(`c${i}`, 1);
    }
    const watched = store.watchMessage('c0', server.rows('c0')[0].id, () => undefined);
    server.hold('createMessage');
    await store.createMessage({ channelId: 'c1', body: textBody('pending'), attachments: [], parentMessageId: null });
    const open = await openRecent(store, 'c2');
    for (let i = 3; i < total; i++) {
      const { w } = await openRecent(store, `c${i}`);
      w.destroy();
    }
    const cached = Array.from({ length: total }, (_, i) => store.hasChannel(`c${i}`));
    expect(cached.slice(0, 3)).toEqual([true, true, true]);
    expect(cached.filter(Boolean)).toHaveLength(CHANNEL_LRU_SIZE + 3);
    expect(store.hasChannel('c3')).toBe(false);
    expect(store.hasChannel(`c${total - 1}`)).toBe(true);
    watched();
    open.w.destroy();
    expect(Array.from({ length: total }, (_, i) => store.hasChannel(`c${i}`)).filter(Boolean)).toHaveLength(CHANNEL_LRU_SIZE + 1);
  });

  it('a re-opened cached channel shows memory at once and catches up from its cursor', async () => {
    const { server, store } = setup({ seed: 5 });
    const first = await openRecent(store);
    first.w.destroy();
    // a cached channel keeps applying live events; this one was missed
    server.post(C, { text: 'while closed' }, { deliver: false });
    server.hold('getChanges');
    const w = store.openWindow(C);
    const p = w.init({ type: 'recent' });
    await p;
    expect(texts(w)).toHaveLength(5);
    server.release('getChanges');
    await settle();
    expect(server.callsOf('getChanges').at(-1)).toMatchObject({ cursor: '1:5' });
    expect(texts(w).at(-1)).toBe('while closed');
  });

  it('clear() gives windows an empty reset and drops pending sends', async () => {
    const { store } = setup({ seed: 5 });
    const { w, changes } = await openRecent(store);
    await store.createMessage({ channelId: C, body: textBody('x'), attachments: [], parentMessageId: null });
    store.clear();
    expect(w.state.items).toEqual([]);
    expect(changes.at(-1)).toEqual({ kind: 'reset', cause: 'resync' });
    const p = w.init({ type: 'recent' });
    await settle();
    await p;
    // the send had reached the server; nothing pending is left over
    expect(w.state.items).toHaveLength(6);
    expect(w.state.items.some(m => m.sendStatus)).toBe(false);
  });

  it('deleteMessage tombstones on success; reactions reject on failure', async () => {
    const { server, store } = setup({ seed: 3 });
    const { w } = await openRecent(store);
    const id = w.state.items[0].id;
    server.hold('deleteMessage');
    const del = store.deleteMessage(C, id, w.state.items[0].creatorId);
    await settle();
    server.release('deleteMessage');
    await del;
    expect(ids(w)).not.toContain(id);
    server.fail('setReaction', new Error('NOT_ALLOWED'), 1);
    await expect(store.setReaction(C, w.state.items[0].id, '👍')).rejects.toThrow('NOT_ALLOWED');
  });
});

describe('ChannelStore: old server fallback', () => {
  it('falls back to loadMessages for the page load when getChanges is missing', async () => {
    const { server, store } = setup({ oldServer: true, seed: 5 });
    const { w } = await openRecent(store);
    expect(texts(w)).toHaveLength(5);
    expect(server.callsOf('getChanges')).toHaveLength(1);
    server.post(C, { text: 'live old' });
    expect(texts(w).at(-1)).toBe('live old');
    server.goOffline();
    server.post(C, { text: 'missed' });
    server.goLive();
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    await settle();
    expect(texts(w).at(-1)).toBe('missed');
    expect(server.callsOf('getChanges')).toHaveLength(1);
    expect(server.callsOf('loadMessages').length).toBeGreaterThanOrEqual(2);
  });

  it('fallback: a gap of more than one page replaces the latest segment', async () => {
    const { server, store } = setup({ oldServer: true, seed: 5 });
    const { w, changes } = await openRecent(store);
    server.goOffline();
    for (let i = 0; i < 40; i++) server.post(C, { text: `x${i}` });
    server.goLive();
    await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
    await settle();
    expect(texts(w).at(-1)).toBe('x39');
    expect(texts(w)).not.toContain('seed 4');
    expect(changes.at(-1)).toEqual({ kind: 'reset', cause: 'resync' });
  });

  it('fallback: sends and edits work without syncSeq', async () => {
    const { store } = setup({ oldServer: true, seed: 1 });
    const { w } = await openRecent(store);
    await store.createMessage({ channelId: C, body: textBody('old send'), attachments: [], parentMessageId: null });
    await settle();
    expect(w.state.items.at(-1)!.sendStatus).toBeUndefined();
    await store.editMessage(w.state.items[0], { body: textBody('old edit'), attachments: [], parentMessageId: null });
    await settle();
    expect(textOf(w.state.items[0])).toBe('old edit');
    expect(w.state.items[0].sendStatus).toBeUndefined();
  });
});
