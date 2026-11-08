// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
// aliased: called from a plain setup helper, not a React hook
import { useDataLayerFakeTimers as installFakeTimers } from 'test/timers';
import { flushMicrotasks } from 'test/deferred';
import { createNotificationStore } from 'data/chat/notificationStore';
import { FakeChatServer } from 'data/chat/testing/fakeServer';
import { systemClock } from 'data/chat/util';
import type { NotificationStore } from 'data/chat/types';
import { createNotificationReadMarking } from 'views/NotificationsBrowser/NotificationsBrowser.helper';

// the real runtime would build the app's stores; the façade only needs `chat.notifications`
const runtime = vi.hoisted(() => ({ store: undefined as NotificationStore | undefined }));
vi.mock('data/chat/runtime', () => ({
  chat: {
    get notifications() {
      return runtime.store!;
    },
  },
}));

const { default: facade } = await import('./notification');

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await flushMicrotasks(50);
}

function setup() {
  installFakeTimers({ now: new Date('2026-11-02T12:00:00Z') });
  const server = new FakeChatServer();
  runtime.store?.dispose();
  runtime.store = createNotificationStore({ api: server, events: server, clock: systemClock });
  const counts: unknown[] = [];
  const unsubscribe = facade.subscribeUnreadCount(c => counts.push(c));
  return { server, counts, unsubscribe };
}

async function openList() {
  const w = facade.openList();
  const p = w.init({ type: 'recent' });
  await settle();
  await p;
  return w;
}

describe('data.notification façade: count', () => {
  it('setupAfterLogin is synchronous and numeric (numeric strings too, "0" is 0)', () => {
    const { counts } = setup();
    expect(facade.setupAfterLogin('3')).toBeUndefined();
    expect(facade.unreadCount).toBe(3);
    facade.setupAfterLogin('0');
    expect(facade.unreadCount).toBe(0);
    expect(typeof facade.unreadCount).toBe('number');
    expect(counts).toEqual([3, 0]);
  });

  it('takes the count from the server only: a duplicated event does not count twice', () => {
    const { server } = setup();
    facade.setupAfterLogin(0);
    const ev = server.addNotification({}, { deliver: false });
    server.deliverNotification(ev);
    server.deliverNotification(ev);
    expect(facade.unreadCount).toBe(1);
  });

  it('subscribers are independent (multi-subscriber)', () => {
    const { server, counts, unsubscribe } = setup();
    const other: number[] = [];
    const unsubscribeOther = facade.subscribeUnreadCount(c => other.push(c));
    server.addNotification();
    unsubscribe();
    server.addNotification();
    unsubscribeOther();
    expect(counts).toEqual([1]);
    expect(other).toEqual([1, 2]);
  });

  it('markAllAsRead resets the count via the server and marks the loaded items read', async () => {
    const { server } = setup();
    server.addNotification();
    server.addNotification();
    const w = await openList();
    expect(facade.unreadCount).toBe(2);
    await facade.markAllAsRead();
    await settle();
    expect(server.callsOf('markAllAsRead')).toHaveLength(1);
    expect(facade.unreadCount).toBe(0);
    expect(w.state.items.every(n => n.read)).toBe(true);
    w.destroy();
  });

  it('clear() (logout) resets the count to 0 and leaves open windows not ready', async () => {
    const { server } = setup();
    server.addNotification();
    const w = await openList();
    facade.clear();
    expect(facade.unreadCount).toBe(0);
    expect(w.state.ready).toBe(false);
    expect(w.state.items).toEqual([]);
    w.destroy();
  });
});

describe('data.notification façade: list', () => {
  it('one window: init fetches the newest page once, loadOlder fetches the next', async () => {
    const { server } = setup();
    for (let i = 0; i < 45; i++) server.addNotification({}, { deliver: false });
    const w = await openList();
    expect(server.callsOf('loadNotifications')).toHaveLength(1);
    expect(w.state.items).toHaveLength(30);
    expect(w.state.hasPreviousItemsOnRemote).toBe(true);
    const p = w.loadOlder(30);
    await settle();
    await p;
    expect(server.callsOf('loadNotifications')).toHaveLength(2);
    expect(w.state.items).toHaveLength(45);
    expect(w.state.withStartOfList).toBe(true);
    w.destroy();
  });
});

describe('NotificationsBrowser read marking: one markAsRead per interaction', () => {
  it('click plus the selection effect that follows it send one markAsRead', async () => {
    const { server } = setup();
    server.addNotification();
    const w = await openList();
    const marking = createNotificationReadMarking(id => facade.markAsRead(id));
    // the click and the effect both see the render's snapshot (read: false)
    const snapshot = w.state.items[0];
    marking.onClick(snapshot);
    marking.onSelected(snapshot); // selection effect after the navigation
    marking.onSelected(snapshot); // effect re-run on the next list change
    await settle();
    expect(server.callsOf('markAsRead')).toEqual([{ notificationId: snapshot.id }]);
    expect(w.state.items[0].read).toBe(true);
    expect(facade.unreadCount).toBe(0);
    w.destroy();
  });

  it('a deep link (selection without click) marks once', async () => {
    const { server } = setup();
    server.addNotification();
    const w = await openList();
    const marking = createNotificationReadMarking(id => facade.markAsRead(id));
    const snapshot = w.state.items[0];
    marking.onSelected(snapshot);
    marking.onSelected(snapshot);
    await settle();
    expect(server.callsOf('markAsRead')).toHaveLength(1);
    w.destroy();
  });

  it('two direct façade calls in a row are one request (store dedupe)', async () => {
    const { server } = setup();
    server.addNotification();
    const w = await openList();
    const id = w.state.items[0].id;
    void facade.markAsRead(id);
    void facade.markAsRead(id);
    await settle();
    expect(server.callsOf('markAsRead')).toHaveLength(1);
    w.destroy();
  });

  it('after a failure the effect re-run does not retry (no request loop), a click does', async () => {
    const { server } = setup();
    server.addNotification();
    const w = await openList();
    const marking = createNotificationReadMarking(id => facade.markAsRead(id));
    server.fail('markAsRead', new Error('Network down'), 1);
    marking.onSelected(w.state.items[0]);
    await settle();
    expect(w.state.items[0].read).toBe(false);
    marking.onSelected(w.state.items[0]);
    await settle();
    expect(server.callsOf('markAsRead')).toHaveLength(1);
    marking.onClick(w.state.items[0]);
    await settle();
    expect(server.callsOf('markAsRead')).toHaveLength(2);
    expect(w.state.items[0].read).toBe(true);
    w.destroy();
  });

  it('a click after a failed click retries', async () => {
    const { server } = setup();
    server.addNotification();
    const w = await openList();
    const marking = createNotificationReadMarking(id => facade.markAsRead(id));
    server.fail('markAsRead', new Error('Network down'), 1);
    marking.onClick(w.state.items[0]);
    await settle();
    expect(w.state.items[0].read).toBe(false);
    marking.onClick(w.state.items[0]);
    await settle();
    expect(server.callsOf('markAsRead')).toHaveLength(2);
    expect(w.state.items[0].read).toBe(true);
    w.destroy();
  });

  it('already read notifications send nothing', () => {
    const calls: string[] = [];
    const marking = createNotificationReadMarking(id => calls.push(id));
    marking.onClick({ id: 'n1', read: true });
    marking.onSelected({ id: 'n1', read: true });
    marking.onClick({ id: 'n2', read: false });
    marking.onSelected({ id: 'n3', read: false });
    expect(calls).toEqual(['n2', 'n3']);
  });
});
