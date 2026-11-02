// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Interleavings found in review: requests in flight across resets, trims,
 * the first sync, disposal.
 */

import { describe, expect, it, vi } from 'vitest';
// aliased: called from a plain setup helper, not a React hook
import { useDataLayerFakeTimers as installFakeTimers } from 'test/timers';
import { flushMicrotasks } from 'test/deferred';
import { createChannelStore, RESYNC_DEBOUNCE_MS } from './channelStore';
import { FakeChatServer, ME, textBody, textOf } from './testing/fakeServer';
import { systemClock } from './util';
import { GAP_RESYNC_DEBOUNCE_MS, type ChannelWindow } from './types';

type Message = Models.Message.Message;

const C = 'ch-1';

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await flushMicrotasks(50);
}

function setup(seed = 0) {
  installFakeTimers({ now: new Date('2026-11-02T12:00:00Z') });
  const server = new FakeChatServer();
  const access = server.addChannel(C);
  if (seed) server.seed(C, seed);
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
  return { server, store, own, access };
}

const texts = (w: ChannelWindow) => w.state.items.map(m => textOf(m));

/** the shown seed numbers have no hole */
function assertContiguousSeeds(w: ChannelWindow) {
  const nums = texts(w).filter(t => t.startsWith('seed ')).map(t => Number(t.slice(5)));
  for (let i = 1; i < nums.length; i++) expect(nums[i]).toBe(nums[i - 1] + 1);
}

async function openRecent(store: ReturnType<typeof setup>['store'], options: Partial<Models.ItemList.ItemListInitOptions> = {}) {
  const w = store.openWindow(C);
  const p = w.init({ type: 'recent', ...options } as Models.ItemList.ItemListInitOptions);
  await settle();
  await p;
  return w;
}

async function liveSignal(server: FakeChatServer) {
  server.goLive();
  await vi.advanceTimersByTimeAsync(RESYNC_DEBOUNCE_MS);
  await settle();
}

describe('ChannelStore races', () => {
  it('R1: an older page in flight across a reset is dropped, not spliced onto the new latest segment', async () => {
    const { server, store } = setup(100);
    const w = await openRecent(store);
    expect(texts(w)[0]).toBe('seed 70');
    server.hold('loadMessages');
    const older = w.loadOlder();
    await settle();
    server.goOffline();
    for (let i = 0; i < 600; i++) server.post(C, { text: `x${i}` });
    await liveSignal(server);
    server.release('loadMessages');
    await settle();
    await older;
    const shown = texts(w);
    expect(shown).not.toContain('seed 69');
    expect(shown.at(-1)).toBe('x599');
    // paging back from the reset page stays contiguous
    for (let i = 0; i < 3; i++) {
      const p = w.loadOlder();
      await settle();
      await p;
    }
    const xs = texts(w).map(t => Number(t.slice(1)));
    for (let i = 1; i < xs.length; i++) expect(xs[i]).toBe(xs[i - 1] + 1);
  });

  it('R15: an older page in flight across a trim of the latest segment start is dropped', async () => {
    const { server, store } = setup(400);
    const w = await openRecent(store, { minimumItemCount: 210 });
    expect(w.state.items.length).toBeGreaterThan(200);
    server.hold('loadMessages');
    const older = w.loadOlder();
    await settle();
    w.trim({ keep: 30, from: 'start' });
    server.release('loadMessages');
    await settle();
    await older;
    assertContiguousSeeds(w);
    for (let i = 0; i < 12; i++) {
      const p = w.loadOlder();
      await settle();
      await p;
    }
    assertContiguousSeeds(w);
  });

  it('a newer page of a detached window in flight across a reset is dropped', async () => {
    const { server, store } = setup(100);
    await openRecent(store);
    const jump = store.openWindow(C);
    const p = jump.init({ type: 'atItemId', itemId: server.rows(C)[10].id });
    await settle();
    await p;
    server.hold('loadMessages');
    const newer = jump.loadNewer();
    await settle();
    server.goOffline();
    for (let i = 0; i < 600; i++) server.post(C, { text: `x${i}` });
    await liveSignal(server);
    server.release('loadMessages');
    await settle();
    await newer;
    await settle();
    assertContiguousSeeds(jump);
  });

  it('R14: an own send confirmed during the first sync is not lost', async () => {
    const { server, store, own } = setup(3);
    const w = store.openWindow(C);
    server.hold('getChanges');
    const p = w.init({ type: 'recent' });
    await settle();
    await store.createMessage({ channelId: C, body: textBody('mine'), attachments: [], parentMessageId: null });
    await settle(); // the create response arrives before the (older) snapshot
    server.release('getChanges');
    await settle();
    await p;
    expect(texts(w)).toEqual(['seed 0', 'seed 1', 'seed 2', 'mine']);
    expect(w.state.items.at(-1)!.sendStatus).toBeUndefined();
    expect(own).toHaveLength(1);
    expect(store.getCursor(C)).toBe('1:4');
    await vi.advanceTimersByTimeAsync(GAP_RESYNC_DEBOUNCE_MS * 2);
    expect(texts(w)).toHaveLength(4);
  });

  it('R14b: an own send confirmed during the first sync that the snapshot already has appears once', async () => {
    const { server, store, own } = setup(3);
    const w = store.openWindow(C);
    server.hold('createMessage');
    await store.createMessage({ channelId: C, body: textBody('mine'), attachments: [], parentMessageId: null });
    await settle();
    server.hold('getChanges');
    const p = w.init({ type: 'recent' });
    await settle();
    server.release('createMessage');
    await settle();
    server.release('getChanges');
    await settle();
    await p;
    expect(texts(w)).toEqual(['seed 0', 'seed 1', 'seed 2', 'mine']);
    expect(own).toHaveLength(1);
  });

  it('R8: hasMore without progress stops the catch-up loop', async () => {
    const { server, store } = setup(3);
    await openRecent(store);
    const original = server.getChanges.bind(server);
    let calls = 0;
    server.getChanges = async data => {
      calls++;
      const resp = await original(data);
      return calls < 100 ? { ...resp, hasMore: true, syncSeq: 3, cursor: '1:3' as API.Messages.SyncCursor } : resp;
    };
    server.goOffline();
    server.post(C, { text: 'a' });
    await liveSignal(server);
    expect(calls).toBeLessThan(5);
  });

  it('R2: a send that failed over HTTP but reached the server is resolved by the own event', async () => {
    const { server, store, own } = setup(3);
    const w = await openRecent(store);
    server.fail('createMessage', new Error('Network down'), 1);
    await store.createMessage({ channelId: C, body: textBody('mine'), attachments: [], parentMessageId: null });
    await settle();
    expect(w.state.items.at(-1)!.sendStatus).toBe('error-send');
    server.post(C, { id: 'local-001', creatorId: ME, text: 'mine' });
    expect(w.state.items.filter(m => m.id === 'local-001')).toHaveLength(1);
    expect(w.state.items.at(-1)!.sendStatus).toBeUndefined();
    expect(own).toHaveLength(1);
  });

  it('R3: deleting a send whose create response is still held does not resurrect it', async () => {
    const { server, store } = setup(3);
    const w = await openRecent(store);
    server.hold('createMessage');
    await store.createMessage({ channelId: C, body: textBody('mine'), attachments: [], parentMessageId: null });
    await settle();
    await store.deleteMessage(C, 'local-001', ME);
    server.release('createMessage');
    await settle();
    expect(w.state.items.map(m => m.id)).not.toContain('local-001');
  });

  it('pins and reply parents of a channel without a window are refreshed on resync', async () => {
    const { server, store } = setup(3);
    const [pinned, parent] = server.rows(C);
    const seen: (string | undefined)[] = [];
    const parents: (string | undefined)[] = [];
    store.watchMessage(C, pinned.id, m => seen.push(m ? textOf(m) : undefined));
    store.watchMessage(C, parent.id, m => parents.push(m ? textOf(m) : undefined));
    await settle();
    server.goOffline();
    server.edit(C, pinned.id, 'pinned, edited');
    server.remove(C, [parent.id]);
    await liveSignal(server);
    expect(seen).toEqual(['seed 0', 'pinned, edited']);
    expect(parents).toEqual(['seed 1', undefined]);
  });

  it('R10: forgetChannel, destroy and dispose leave no armed timers; in-flight loads notify nobody', async () => {
    const { server, store } = setup(40);
    const w = await openRecent(store);
    const changes: unknown[] = [];
    w.subscribe((_s, c) => changes.push(c));
    server.hold('createMessage');
    await store.createMessage({ channelId: C, body: textBody('m'), attachments: [], parentMessageId: null });
    server.bump(C);
    server.post(C, { text: 'gap' });
    server.hold('loadMessages');
    const older = w.loadOlder();
    await settle();
    const before = changes.length;
    store.forgetChannel(C);
    store.dispose();
    server.release('loadMessages');
    server.release('createMessage');
    await settle();
    await older;
    expect(vi.getTimerCount()).toBe(0);
    expect(changes.length).toBe(before + 1); // only the empty reset of forgetChannel
    w.destroy();
  });

  it('dispose settles inits that wait for an access', async () => {
    installFakeTimers();
    const server = new FakeChatServer();
    const store = createChannelStore({ api: server, events: server, clock: systemClock, newId: () => 'x' });
    const w = store.openWindow('unregistered');
    const p = w.init({ type: 'recent' });
    const assertion = expect(p).rejects.toThrow();
    store.dispose();
    await assertion;
  });
});
