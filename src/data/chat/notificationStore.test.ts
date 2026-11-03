// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
// aliased: called from a plain setup helper, not a React hook
import { useDataLayerFakeTimers as installFakeTimers } from 'test/timers';
import { flushMicrotasks } from 'test/deferred';
import { COUNT_REFETCH_DEBOUNCE_MS, createNotificationStore, NOTIFICATION_RESYNC_DEBOUNCE_MS } from './notificationStore';
import { FakeChatServer } from './testing/fakeServer';
import { systemClock } from './util';
import type { WindowChange } from './types';

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await flushMicrotasks(50);
}

function setup(options: { oldServer?: boolean } = {}) {
  installFakeTimers({ now: new Date('2026-11-02T12:00:00Z') });
  const server = new FakeChatServer();
  server.oldServer = !!options.oldServer;
  const store = createNotificationStore({ api: server, events: server, clock: systemClock });
  const counts: number[] = [];
  store.subscribeUnreadCount(c => counts.push(c));
  return { server, store, counts };
}

async function openList(store: ReturnType<typeof setup>['store']) {
  const w = store.openList();
  const changes: WindowChange[] = [];
  w.subscribe((_s, c) => changes.push(c));
  const p = w.init({ type: 'recent' });
  await settle();
  await p;
  return { w, changes };
}

describe('NotificationStore: count from the server only', () => {
  it('takes the login value as a number (numeric strings too)', () => {
    const { store, counts } = setup();
    store.setupAfterLogin('3');
    expect(store.unreadCount).toBe(3);
    store.setupAfterLogin(0);
    expect(counts).toEqual([3, 0]);
  });

  it('a mention increments once even when the event is delivered twice', () => {
    const { server, store } = setup();
    store.setupAfterLogin(0);
    const ev = server.addNotification({}, { deliver: false });
    server.deliverNotification(ev);
    server.deliverNotification(ev);
    expect(store.unreadCount).toBe(1);
  });

  it('newest unreadCountAt wins; an older count arriving late is ignored', () => {
    const { server, store } = setup();
    const first = server.addNotification({}, { deliver: false });
    const second = server.addNotification({}, { deliver: false });
    server.deliverNotification(second);
    server.deliverNotification(first);
    expect(store.unreadCount).toBe(2);
  });

  it('duplicate update/delete/allread events never drift the count', async () => {
    const { server, store } = setup();
    const a = server.addNotification();
    const b = server.addNotification();
    const c = server.addNotification();
    expect(store.unreadCount).toBe(3);
    const read = server.readNotificationElsewhere((a as { data: { id: string } }).data.id, { deliver: false })!;
    server.deliverNotification(read);
    server.deliverNotification(read);
    expect(store.unreadCount).toBe(2);
    const del = server.deleteNotifications([(b as { data: { id: string } }).data.id], { deliver: false });
    server.deliverNotification(del);
    server.deliverNotification(del);
    expect(store.unreadCount).toBe(1);
    await store.markAllAsRead();
    await settle();
    expect(store.unreadCount).toBe(0);
    void c;
  });

  it('an event without unreadCount (old server) refetches the count, debounced', async () => {
    const { server, store } = setup({ oldServer: true });
    store.setupAfterLogin('0');
    server.addNotification();
    server.addNotification();
    expect(store.unreadCount).toBe(0);
    await vi.advanceTimersByTimeAsync(COUNT_REFETCH_DEBOUNCE_MS);
    await settle();
    expect(server.callsOf('getUnreadCount')).toEqual([{ withTime: true }]);
    expect(store.unreadCount).toBe(2);
  });

  it('resync on live asks getUnreadCount withTime', async () => {
    const { server, store } = setup();
    store.setupAfterLogin(5);
    server.addNotification({}, { deliver: false });
    server.goLive();
    await vi.advanceTimersByTimeAsync(NOTIFICATION_RESYNC_DEBOUNCE_MS);
    await settle();
    expect(store.unreadCount).toBe(1);
  });

  it('a count without time is taken and makes any timed count win next', () => {
    const { server, store } = setup();
    server.addNotification();
    expect(store.unreadCount).toBe(1);
    store.setupAfterLogin(7);
    expect(store.unreadCount).toBe(7);
    const old = server.addNotification({}, { deliver: false }) as Events.Notification.Notification;
    server.deliverNotification({ ...old, unreadCountAt: '2000-01-01T00:00:00.000Z' });
    expect(store.unreadCount).toBe(2);
  });
});

describe('NotificationStore: list', () => {
  it('init(recent) fetches the first page once even if called twice', async () => {
    const { server, store } = setup();
    for (let i = 0; i < 3; i++) server.addNotification({ text: `n${i}` }, { deliver: false });
    const w = store.openList();
    const p1 = w.init({ type: 'recent' });
    const p2 = w.init({ type: 'recent' });
    const superseded = expect(p1).rejects.toThrow('WINDOW_INIT_SUPERSEDED');
    await settle();
    await superseded;
    await p2;
    expect(server.callsOf('loadNotifications')).toHaveLength(1);
    expect(w.state.items.map(n => n.text)).toEqual(['n0', 'n1', 'n2']);
    expect(w.state).toMatchObject({ withStartOfList: true, withEndOfList: true });
  });

  it('applies live new/update/delete/allread idempotently', async () => {
    const { server, store } = setup();
    server.addNotification({ text: 'old' }, { deliver: false });
    const { w, changes } = await openList(store);
    const ev = server.addNotification({ text: 'new' }, { deliver: false });
    server.deliverNotification(ev);
    server.deliverNotification(ev);
    expect(w.state.items.map(n => n.text)).toEqual(['old', 'new']);
    expect(changes.filter(c => c.kind === 'append-live')).toHaveLength(1);
    const id = (ev as { data: { id: string } }).data.id;
    server.readNotificationElsewhere(id);
    expect(w.state.items[1].read).toBe(true);
    server.deliverNotification({ type: 'cliNotificationEvent', action: 'allread', data: { updatedAt: new Date().toISOString() } });
    expect(w.state.items.every(n => n.read)).toBe(true);
    server.deleteNotifications([id]);
    server.deleteNotifications([id]);
    expect(w.state.items.map(n => n.text)).toEqual(['old']);
  });

  it('markAsRead is a no-op for read items and while in flight; optimistic; reverted on failure', async () => {
    const { server, store } = setup();
    const ev = server.addNotification();
    const id = (ev as { data: { id: string } }).data.id;
    const { w } = await openList(store);
    server.hold('markAsRead');
    const first = store.markAsRead(id);
    expect(w.state.items[0].read).toBe(true);
    const second = store.markAsRead(id);
    await settle();
    server.release('markAsRead');
    await first;
    await second;
    await store.markAsRead(id);
    expect(server.callsOf('markAsRead')).toHaveLength(1);
    await settle();
    expect(store.unreadCount).toBe(0);

    const ev2 = server.addNotification();
    const id2 = (ev2 as { data: { id: string } }).data.id;
    server.fail('markAsRead', new Error('Network down'), 1);
    await store.markAsRead(id2);
    expect(w.state.items.find(n => n.id === id2)!.read).toBe(false);
    expect(store.unreadCount).toBe(1);
  });

  it('E5: a mention increments the badge once, opening it decrements once', async () => {
    const { server, store, counts } = setup();
    store.setupAfterLogin(0);
    const ev = server.addNotification();
    const id = (ev as { data: { id: string } }).data.id;
    // the selection effect and the click handler both mark it
    await Promise.all([store.markAsRead(id), store.markAsRead(id)]);
    await settle();
    expect(server.callsOf('markAsRead')).toHaveLength(1);
    expect(counts).toEqual([1, 0]);
  });

  it('loadOlder pages back; trim and loadNewer work locally', async () => {
    const { server, store } = setup();
    for (let i = 0; i < 45; i++) server.addNotification({ text: `n${i}` }, { deliver: false });
    const { w } = await openList(store);
    expect(w.state.items).toHaveLength(30);
    const p = w.loadOlder();
    await settle();
    await p;
    expect(w.state.items).toHaveLength(45);
    expect(w.state.withStartOfList).toBe(true);
    w.trim({ keep: 10, from: 'end' });
    expect(w.state).toMatchObject({ withEndOfList: false, hasNextItemsLocally: true });
    await w.loadNewer(100);
    expect(w.state.withEndOfList).toBe(true);
  });

  it('resync while open fetches the newest page again', async () => {
    const { server, store } = setup();
    server.addNotification({ text: 'a' }, { deliver: false });
    const { w } = await openList(store);
    server.addNotification({ text: 'missed' }, { deliver: false });
    server.goLive();
    await vi.advanceTimersByTimeAsync(NOTIFICATION_RESYNC_DEBOUNCE_MS);
    await settle();
    expect(w.state.items.map(n => n.text)).toEqual(['a', 'missed']);
  });

  it('clear() resets count and list', async () => {
    const { server, store } = setup();
    server.addNotification();
    const { w } = await openList(store);
    store.clear();
    expect(store.unreadCount).toBe(0);
    expect(w.state.items).toEqual([]);
  });

  it('a load from before clear() answering late does not let the next init load a second time', async () => {
    const { server, store } = setup();
    server.addNotification({ text: 'a' }, { deliver: false });
    server.hold('loadNotifications', 2);
    const stale = store.openList();
    const staleInit = stale.init({ type: 'recent' }).catch(() => undefined);
    await settle();
    store.clear(); // logout (and the next login) while the first page is in flight
    const w1 = store.openList();
    const p1 = w1.init({ type: 'recent' });
    await settle();
    expect(server.callsOf('loadNotifications')).toHaveLength(2);
    server.release('loadNotifications', 1); // the stale answer
    await settle();
    const w2 = store.openList();
    const p2 = w2.init({ type: 'recent' });
    await settle();
    // w2 joins the running load
    expect(server.callsOf('loadNotifications')).toHaveLength(2);
    server.release('loadNotifications');
    await settle();
    await Promise.all([p1, p2, staleInit]);
    expect(w2.state.items.map(n => n.text)).toEqual(['a']);
    stale.destroy();
    w1.destroy();
    w2.destroy();
  });

  it('a failed markAsRead does not revert a read confirmed by the server meanwhile', async () => {
    const { server, store } = setup();
    const ev = server.addNotification({}, { deliver: false });
    const id = (ev as { data: { id: string } }).data.id;
    const { w } = await openList(store);
    server.hold('markAsRead');
    server.fail('markAsRead', new Error('Network down'), 1);
    const p = store.markAsRead(id);
    await settle();
    server.readNotificationElsewhere(id);
    server.release('markAsRead');
    await p;
    await settle();
    expect(w.state.items.find(n => n.id === id)!.read).toBe(true);
  });

  it('markAllAsRead: one call while in flight; a failure reverts only the optimistic copies', async () => {
    const { server, store } = setup();
    const a = (server.addNotification({}, { deliver: false }) as { data: { id: string } }).data.id;
    server.addNotification({}, { deliver: false });
    const { w } = await openList(store);
    server.hold('markAllAsRead');
    server.fail('markAllAsRead', new Error('Network down'), 1);
    const p1 = store.markAllAsRead();
    const p2 = store.markAllAsRead();
    expect(w.state.items.every(n => n.read)).toBe(true);
    await settle();
    expect(server.callsOf('markAllAsRead')).toHaveLength(1);
    server.readNotificationElsewhere(a);
    server.release('markAllAsRead');
    await Promise.all([p1, p2]);
    await settle();
    expect(w.state.items.map(n => n.read)).toEqual([true, false]);
  });

  it('a stream of count-less events cannot postpone the count refetch forever', async () => {
    const { server, store } = setup({ oldServer: true });
    store.setupAfterLogin(0);
    for (let i = 0; i < 10; i++) {
      server.addNotification();
      await vi.advanceTimersByTimeAsync(COUNT_REFETCH_DEBOUNCE_MS / 2);
    }
    await settle();
    expect(server.callsOf('getUnreadCount').length).toBeGreaterThanOrEqual(2);
    await vi.advanceTimersByTimeAsync(COUNT_REFETCH_DEBOUNCE_MS);
    await settle();
    expect(store.unreadCount).toBe(10);
  });
});

describe('NotificationStore: list reopened after a resync without an open window', () => {
  async function reopen(store: ReturnType<typeof setup>['store']) {
    const w = store.openList();
    const p = w.init({ type: 'recent' });
    await settle();
    await p;
    return w;
  }

  it('a reopened list contains a notification missed during the gap', async () => {
    const { server, store } = setup();
    server.addNotification({ text: 'a' }, { deliver: false });
    let w = await reopen(store);
    w.destroy(); // the user leaves /notifications
    server.goOffline();
    server.addNotification({ text: 'missed' }, { deliver: false });
    server.goLive();
    await vi.advanceTimersByTimeAsync(NOTIFICATION_RESYNC_DEBOUNCE_MS);
    await settle();
    expect(store.unreadCount).toBe(2);
    expect(server.callsOf('loadNotifications')).toHaveLength(1); // no fetch while closed
    w = await reopen(store);
    expect(w.state.items.map(n => n.text)).toEqual(['a', 'missed']);
    expect(server.callsOf('loadNotifications')).toHaveLength(2);
    w.destroy();
  });

  it('read flags changed elsewhere during the gap are fresh after reopening; a deleted one is gone', async () => {
    const { server, store } = setup();
    const a = server.addNotification({ text: 'a' }, { deliver: false }) as { data: { id: string } };
    const b = server.addNotification({ text: 'b' }, { deliver: false }) as { data: { id: string } };
    let w = await reopen(store);
    w.destroy();
    server.goOffline();
    server.readNotificationElsewhere(a.data.id, { deliver: false });
    server.deleteNotifications([b.data.id], { deliver: false });
    server.resume('visible');
    await vi.advanceTimersByTimeAsync(NOTIFICATION_RESYNC_DEBOUNCE_MS);
    await settle();
    w = await reopen(store);
    expect(w.state.items.map(n => [n.text, n.read])).toEqual([['a', true]]);
    w.destroy();
  });

  it('without a resync the reopened list is served from memory (no refetch)', async () => {
    const { server, store } = setup();
    server.addNotification({ text: 'a' }, { deliver: false });
    let w = await reopen(store);
    w.destroy();
    server.addNotification({ text: 'live' }); // delivered: applied while closed
    w = await reopen(store);
    expect(w.state.items.map(n => n.text)).toEqual(['a', 'live']);
    expect(server.callsOf('loadNotifications')).toHaveLength(1);
    w.destroy();
  });

  it('a live notification arriving during the reload is kept', async () => {
    const { server, store } = setup();
    server.addNotification({ text: 'a' }, { deliver: false });
    let w = await reopen(store);
    w.destroy();
    server.goLive();
    await vi.advanceTimersByTimeAsync(NOTIFICATION_RESYNC_DEBOUNCE_MS);
    await settle();
    server.hold('loadNotifications');
    w = store.openList();
    const p = w.init({ type: 'recent' });
    await settle();
    server.addNotification({ text: 'during' }); // the held page was computed without it
    server.release('loadNotifications');
    await settle();
    await p;
    expect(w.state.items.map(n => n.text)).toEqual(['a', 'during']);
    w.destroy();
  });

  async function staleAfterGap(server: FakeChatServer) {
    server.goOffline();
    server.goLive();
    await vi.advanceTimersByTimeAsync(NOTIFICATION_RESYNC_DEBOUNCE_MS);
    await settle();
  }

  it('an update of an item older than the reloaded page leaves no gap for loadOlder', async () => {
    const { server, store } = setup();
    const ids: string[] = [];
    for (let i = 0; i < 45; i++) {
      const ev = server.addNotification({ text: 'n' + i }, { deliver: false }) as { data: { id: string } };
      ids.push(ev.data.id);
      await vi.advanceTimersByTimeAsync(1000);
    }
    let w = await reopen(store);
    const p0 = w.loadOlder(30);
    await settle();
    await p0;
    expect(w.state.items).toHaveLength(45);
    w.destroy();
    await staleAfterGap(server);
    server.hold('loadNotifications');
    w = store.openList();
    const p = w.init({ type: 'recent' });
    await settle();
    server.readNotificationElsewhere(ids[0]); // delivered while the page is in flight
    server.release('loadNotifications');
    await settle();
    await p;
    for (let i = 0; i < 5; i++) {
      const q = w.loadOlder(30);
      await settle();
      await q;
    }
    expect(w.state.items.map(n => n.text)).toEqual(Array.from({ length: 45 }, (_, i) => 'n' + i));
    expect(w.state.items[0].read).toBe(true);
    w.destroy();
  });

  it('a delete during the reload stays deleted (the page computed earlier does not bring it back)', async () => {
    const { server, store } = setup();
    const a = server.addNotification({ text: 'a' }, { deliver: false }) as { data: { id: string } };
    server.addNotification({ text: 'b' }, { deliver: false });
    let w = await reopen(store);
    w.destroy();
    await staleAfterGap(server);
    server.hold('loadNotifications');
    w = store.openList();
    const p = w.init({ type: 'recent' });
    await settle();
    server.deleteNotifications([a.data.id]); // delivered while the page is in flight
    server.release('loadNotifications');
    await settle();
    await p;
    expect(w.state.items.map(n => n.text)).toEqual(['b']);
    w.destroy();
  });

  it('no duplicate when the in-flight page already contains the live item', async () => {
    const { server, store } = setup();
    server.addNotification({ text: 'a' }, { deliver: false });
    let w = await reopen(store);
    w.destroy();
    await staleAfterGap(server);
    const ev = server.addNotification({ text: 'live' }, { deliver: false });
    server.hold('loadNotifications');
    w = store.openList();
    const p = w.init({ type: 'recent' });
    await settle();
    server.deliverNotification(ev);
    server.release('loadNotifications');
    await settle();
    await p;
    expect(w.state.items.map(n => n.text)).toEqual(['a', 'live']);
    w.destroy();
  });
});
