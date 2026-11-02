// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
// aliased: called from a plain setup helper, not a React hook
import { useDataLayerFakeTimers as installFakeTimers } from 'test/timers';
import { flushMicrotasks } from 'test/deferred';
import { createReadStateStore, MARK_READ_RETRY_MS, SYNC_STATE_DEBOUNCE_MS } from './readStateStore';
import { FakeChatServer, ME } from './testing/fakeServer';
import { systemClock } from './util';
import { MARK_READ_THROTTLE_MS, type ReadStateInput, type ReadStatePersistence } from './types';

const C = 'ch-1';

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await flushMicrotasks(50);
}

function setup(options: { oldServer?: boolean; userId?: string | undefined } = {}) {
  installFakeTimers({ now: new Date('2026-11-02T12:00:00Z') });
  const server = new FakeChatServer();
  server.oldServer = !!options.oldServer;
  if ('userId' in options) server.userId = options.userId;
  const access = server.addChannel(C);
  const persisted: ReadStateInput[] = [];
  const persistence: ReadStatePersistence = { apply: async input => { persisted.push(input); } };
  const store = createReadStateStore({
    api: server,
    events: server,
    clock: systemClock,
    getAccess: id => (id === C ? access : undefined),
    persistence,
  });
  return { server, store, access, persisted };
}

const newestOf = (m: { id: string; createdAt: string }) => ({ id: m.id, createdAt: new Date(m.createdAt) });

async function live(server: FakeChatServer) {
  server.goLive();
  await vi.advanceTimersByTimeAsync(SYNC_STATE_DEBOUNCE_MS);
  await settle();
}

describe('ReadStateStore: merges', () => {
  it('apply merges in memory, notifies changes only, and forwards to persistence', () => {
    const { store, persisted } = setup();
    const seen: number[] = [];
    store.subscribe(s => seen.push(s.unread));
    const input: ReadStateInput = { kind: 'snapshot', channelId: C, lastRead: null, unread: 2, syncSeq: 5, lastMessageDate: '2026-11-02T11:00:00.000Z' };
    expect(store.apply(input)).toMatchObject({ unread: 2, seq: 5 });
    store.apply(input);
    expect(seen).toEqual([2]);
    expect(persisted).toHaveLength(2);
  });

  it('counts live messages of others, not own ones from other devices, once per seq', async () => {
    const { server, store } = setup();
    server.post(C, { text: 'a' });
    server.post(C, { text: 'b' });
    const again = server.post(C, { text: 'c' }, { deliver: false });
    server.deliver(again);
    server.deliver(again);
    expect(store.get(C)).toMatchObject({ unread: 3, counted: [1, 2, 3] });
    server.post(C, { creatorId: ME, text: 'mine' });
    expect(store.get(C)).toMatchObject({ unread: 0 });
  });

  it('ignores channels without read state (calls, articles)', () => {
    const { server, store } = setup();
    server.addChannel('call-ch', {});
    server.post('call-ch', { text: 'x' });
    expect(store.get('call-ch')).toBeUndefined();
  });

  it('catch-up on live: getSyncState snapshots survive live messages counted during the round trip', async () => {
    const { server, store } = setup();
    server.seed(C, 3);
    server.hold('getSyncState');
    server.goLive();
    await vi.advanceTimersByTimeAsync(SYNC_STATE_DEBOUNCE_MS);
    await settle();
    // snapshot taken at seq 3 (unread 0: community channel never read); a message arrives meanwhile
    server.post(C, { text: 'during' });
    expect(store.get(C)).toMatchObject({ unread: 1, counted: [4] });
    server.release('getSyncState');
    await settle();
    expect(store.get(C)).toMatchObject({ unread: 1, seq: 3, counted: [4] });
  });

  it('a lastRead event from another tab clears the count', async () => {
    const { server, store } = setup();
    const msg = server.post(C, { text: 'a' });
    expect(store.get(C)!.unread).toBe(1);
    server.readElsewhere(C, (msg.data as { createdAt: string }).createdAt);
    expect(store.get(C)).toMatchObject({ unread: 0 });
  });

  it('old server: no getSyncState again after a 404', async () => {
    const { server } = setup({ oldServer: true });
    await live(server);
    await live(server);
    expect(server.callsOf('getSyncState')).toHaveLength(1);
  });
});

describe('ReadStateStore: level-triggered marking', () => {
  it('marks read up to the newest message while at latest, at bottom, visible and logged in', async () => {
    const { server, store, access } = setup();
    const [m] = server.seed(C, 1);
    const marker = store.createMarker(C);
    marker.update({ atLatest: true, atBottom: true, newest: newestOf(m) });
    await settle();
    expect(server.callsOf('setChannelLastRead')).toEqual([{ access, lastRead: m.createdAt }]);
    expect(store.get(C)!.lastRead).toBe(m.createdAt);
  });

  it('does nothing while not at the bottom or not at latest', async () => {
    const { server, store } = setup();
    const [m] = server.seed(C, 1);
    const marker = store.createMarker(C);
    marker.update({ atLatest: true, atBottom: false, newest: newestOf(m) });
    marker.update({ atLatest: false, atBottom: true, newest: newestOf(m) });
    marker.update({ atLatest: true, atBottom: true, newest: null });
    await settle();
    expect(server.callsOf('setChannelLastRead')).toHaveLength(0);
  });

  it('login after render: deferred until login, not dropped', async () => {
    const { server, store } = setup({ userId: undefined });
    const [m] = server.seed(C, 1);
    store.createMarker(C).update({ atLatest: true, atBottom: true, newest: newestOf(m) });
    await settle();
    expect(server.callsOf('setChannelLastRead')).toHaveLength(0);
    server.setUser(ME);
    await settle();
    expect(server.callsOf('setChannelLastRead')).toHaveLength(1);
  });

  it('visibility change: nothing while hidden, marks when visible again', async () => {
    const { server, store } = setup();
    server.setVisible(false);
    const [m] = server.seed(C, 1);
    const marker = store.createMarker(C);
    marker.update({ atLatest: true, atBottom: true, newest: newestOf(m) });
    await settle();
    expect(server.callsOf('setChannelLastRead')).toHaveLength(0);
    server.setVisible(true);
    await settle();
    expect(server.callsOf('setChannelLastRead')).toHaveLength(1);
  });

  it('a new message while at the bottom is marked; first call at once, then a trailing throttle', async () => {
    const { server, store } = setup();
    const marker = store.createMarker(C);
    const [a] = server.seed(C, 1);
    marker.update({ atLatest: true, atBottom: true, newest: newestOf(a) });
    await settle();
    expect(server.callsOf('setChannelLastRead')).toHaveLength(1);
    const b = server.post(C, { text: 'b' }).data as { id: string; createdAt: string };
    marker.update({ atLatest: true, atBottom: true, newest: newestOf(b) });
    const c = server.post(C, { text: 'c' }).data as { id: string; createdAt: string };
    marker.update({ atLatest: true, atBottom: true, newest: newestOf(c) });
    await settle();
    expect(server.callsOf('setChannelLastRead')).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(MARK_READ_THROTTLE_MS);
    await settle();
    const calls = server.callsOf('setChannelLastRead') as { lastRead: string }[];
    expect(calls.map(x => x.lastRead)).toEqual([a.createdAt, c.createdAt]);
    expect(store.get(C)).toMatchObject({ unread: 0, lastRead: c.createdAt });
  });

  it('never sends a value that is not newer than lastRead or the last sent one', async () => {
    const { server, store } = setup();
    const [a, b] = server.seed(C, 2);
    const marker = store.createMarker(C);
    marker.update({ atLatest: true, atBottom: true, newest: newestOf(b) });
    await settle();
    marker.update({ atLatest: true, atBottom: true, newest: newestOf(a) });
    marker.update({ atLatest: true, atBottom: true, newest: newestOf(b) });
    await vi.advanceTimersByTimeAsync(MARK_READ_THROTTLE_MS * 3);
    expect(server.callsOf('setChannelLastRead')).toHaveLength(1);
  });

  it('any of several markers at the bottom marks the channel', async () => {
    const { server, store } = setup();
    const [m] = server.seed(C, 1);
    const off = store.createMarker(C);
    const on = store.createMarker(C);
    off.update({ atLatest: false, atBottom: false, newest: newestOf(m) });
    on.update({ atLatest: true, atBottom: true, newest: newestOf(m) });
    await settle();
    expect(server.callsOf('setChannelLastRead')).toHaveLength(1);
    on.dispose();
    off.dispose();
  });

  it('a failed mark is retried with backoff, without further triggers', async () => {
    const { server, store } = setup();
    const [m] = server.seed(C, 1);
    server.fail('setChannelLastRead', new Error('Unexpected status: 500'), 3);
    store.createMarker(C).update({ atLatest: true, atBottom: true, newest: newestOf(m) });
    await settle();
    const calls = () => server.callsOf('setChannelLastRead').length;
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(MARK_READ_RETRY_MS[0] - 1);
    expect(calls()).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    await settle();
    expect(calls()).toBe(2);
    await vi.advanceTimersByTimeAsync(MARK_READ_RETRY_MS[1]);
    await settle();
    expect(calls()).toBe(3);
    await vi.advanceTimersByTimeAsync(MARK_READ_RETRY_MS[2]);
    await settle();
    expect(calls()).toBe(4);
    expect(server.channels.get(C)!.lastRead.get(ME)).toBe(m.createdAt);
    // success: no more calls
    await vi.advanceTimersByTimeAsync(MARK_READ_RETRY_MS[3] * 2);
    expect(calls()).toBe(4);
  });

  it('a live signal retries a failed mark at once and resets the backoff', async () => {
    const { server, store } = setup();
    const [m] = server.seed(C, 1);
    server.fail('setChannelLastRead', new Error('Network down'), 1);
    store.createMarker(C).update({ atLatest: true, atBottom: true, newest: newestOf(m) });
    await settle();
    await vi.advanceTimersByTimeAsync(MARK_READ_THROTTLE_MS);
    await live(server);
    expect(server.callsOf('setChannelLastRead')).toHaveLength(2);
    expect(store.get(C)!.lastRead).toBe(m.createdAt);
    await vi.advanceTimersByTimeAsync(MARK_READ_RETRY_MS[3]);
    expect(server.callsOf('setChannelLastRead')).toHaveLength(2);
  });

  it('getSyncState in flight across clear() and a new login: the new user is still synced', async () => {
    const { server, store } = setup();
    server.seed(C, 3);
    server.hold('getSyncState');
    await live(server);
    expect(server.heldCount('getSyncState')).toBe(1);
    store.clear();
    server.setUser('user-b');
    await live(server);
    server.release('getSyncState');
    await settle();
    await vi.advanceTimersByTimeAsync(1000);
    await settle();
    expect(server.callsOf('getSyncState')).toHaveLength(2);
    expect(store.get(C)).toMatchObject({ seq: 3 });
  });

  it('adds messageId once getSyncState succeeded', async () => {
    const { server, store } = setup();
    await live(server);
    const [m] = server.seed(C, 1);
    store.createMarker(C).update({ atLatest: true, atBottom: true, newest: newestOf(m) });
    await settle();
    expect(server.callsOf('setChannelLastRead')).toMatchObject([{ messageId: m.id }]);
  });

  it('retries without messageId on a validation error and never sends it again', async () => {
    const { server, store } = setup();
    await live(server);
    server.oldServer = true; // e.g. a rollback: rejects unknown keys
    const [a, b] = server.seed(C, 2);
    const marker = store.createMarker(C);
    marker.update({ atLatest: true, atBottom: true, newest: newestOf(a) });
    await settle();
    const calls = server.callsOf('setChannelLastRead') as { messageId?: string }[];
    expect(calls).toHaveLength(2);
    expect(calls[0].messageId).toBe(a.id);
    expect(calls[1].messageId).toBeUndefined();
    await vi.advanceTimersByTimeAsync(MARK_READ_THROTTLE_MS);
    marker.update({ atLatest: true, atBottom: true, newest: newestOf(b) });
    await settle();
    await vi.advanceTimersByTimeAsync(MARK_READ_THROTTLE_MS);
    await settle();
    const all = server.callsOf('setChannelLastRead') as { messageId?: string }[];
    expect(all).toHaveLength(3);
    expect(all[2].messageId).toBeUndefined();
    expect(store.get(C)!.lastRead).toBe(b.createdAt);
  });

  it('the response count is merged (seq-guarded)', async () => {
    const { server, store } = setup();
    const [a] = server.seed(C, 2);
    store.apply({ kind: 'snapshot', channelId: C, lastRead: null, unread: 2, syncSeq: 2, lastMessageDate: server.rows(C)[1].createdAt });
    store.createMarker(C).update({ atLatest: true, atBottom: true, newest: newestOf(a) });
    await settle();
    expect(store.get(C)).toMatchObject({ unread: 1, seq: 2, lastRead: a.createdAt });
  });

  it('a local mark whose call failed is sent again after a reload (server behind, same local value)', async () => {
    const { server, store, persisted } = setup();
    const [m] = server.seed(C, 1);
    server.fail('setChannelLastRead', new Error('Network down'));
    store.createMarker(C).update({ atLatest: true, atBottom: true, newest: newestOf(m) });
    await settle();
    // displayed as read locally, and persisted that way
    expect(store.get(C)!.lastRead).toBe(m.createdAt);
    expect(persisted.some(i => i.kind === 'lastRead' && i.lastRead === m.createdAt)).toBe(true);
    store.dispose();
    server.unfail('setChannelLastRead');
    expect(server.channels.get(C)!.lastRead.get(ME)).toBeUndefined();

    // "reload": a new store fed the persisted local value as a seq-less snapshot
    const access = server.addChannel(C);
    const reloaded = createReadStateStore({ api: server, events: server, clock: systemClock, getAccess: () => access });
    reloaded.apply({ kind: 'snapshot', channelId: C, lastRead: m.createdAt, unread: 0, lastMessageDate: m.createdAt });
    expect(reloaded.get(C)!.lastRead).toBe(m.createdAt);
    const before = server.callsOf('setChannelLastRead').length;
    reloaded.createMarker(C).update({ atLatest: true, atBottom: true, newest: newestOf(m) });
    await settle();
    expect(server.callsOf('setChannelLastRead')).toHaveLength(before + 1);
    expect(server.channels.get(C)!.lastRead.get(ME)).toBe(m.createdAt);
    reloaded.dispose();
  });

  it('a snapshot with syncSeq counts as acknowledged: no redundant call', async () => {
    const { server, store } = setup();
    const [m] = server.seed(C, 1);
    store.apply({ kind: 'snapshot', channelId: C, lastRead: m.createdAt, unread: 0, syncSeq: 1, lastMessageDate: m.createdAt });
    store.createMarker(C).update({ atLatest: true, atBottom: true, newest: newestOf(m) });
    await settle();
    expect(server.callsOf('setChannelLastRead')).toHaveLength(0);
  });

  it('a getSyncState showing the server behind lets the mark be sent again', async () => {
    const { server, store } = setup();
    const [m] = server.seed(C, 1);
    store.apply({ kind: 'lastRead', channelId: C, lastRead: m.createdAt });
    await live(server);
    expect(store.get(C)!.lastRead).toBe(m.createdAt);
    store.createMarker(C).update({ atLatest: true, atBottom: true, newest: newestOf(m) });
    await settle();
    expect(server.callsOf('setChannelLastRead')).toHaveLength(1);
  });
});
