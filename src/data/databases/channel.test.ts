// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
// aliased: called from a plain setup helper, not a React hook
import { useDataLayerFakeTimers as installFakeTimers } from 'test/timers';
import { flushMicrotasks } from 'test/deferred';
import { importAsNewTab } from 'test/modules';
import { FakeChatServer, textBody, textOf } from 'data/chat/testing/fakeServer';
import { systemClock } from 'data/chat/util';
import type { ChatRuntimeImpl } from 'data/chat/runtime';

/*
 * data.channelManager over a real runtime (stores + fake server); the app
 * runtime module is replaced by one built with createChatRuntime.
 */

const t = vi.hoisted(() => ({
  rt: undefined as unknown as ChatRuntimeImpl,
  server: undefined as unknown as FakeChatServer,
  account: undefined as string | undefined,
  started: 0,
}));

// app modules the real runtime module imports (unused by createChatRuntime)
vi.mock('data/appstate/connection', () => ({ default: {} }));
vi.mock('data/appstate/webSocket', () => ({ default: {} }));
vi.mock('data/api/messages', () => ({ default: {} }));
vi.mock('data/api/notifications', () => ({ default: {} }));

vi.mock('data/chat/runtime', () => ({
  chat: {
    get channels() { return t.rt.channels; },
    get readState() { return t.rt.readState; },
    get notifications() { return t.rt.notifications; },
    get events() { return t.rt.events; },
  },
  applyStoredReadState: (states: Parameters<ChatRuntimeImpl['applyStoredReadState']>[0]) => t.rt.applyStoredReadState(states),
  clearChat: () => t.rt.clear(),
  startChatRuntime: () => { t.started++; },
  getChatAccountUser: () => t.account,
  setChatAccountUser: (userId: string | undefined) => { t.account = userId; },
}));

const C = 'ch-1';

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await flushMicrotasks(50);
}

async function setup() {
  installFakeTimers({ now: new Date('2026-11-02T12:00:00Z') });
  // the real builder, outside the mock
  const { createChatRuntime } = await vi.importActual<typeof import('data/chat/runtime')>('data/chat/runtime');
  const server = new FakeChatServer();
  let n = 0;
  t.server = server;
  t.rt = createChatRuntime({
    chatApi: server,
    notificationApi: server,
    events: server,
    clock: systemClock,
    newId: () => `local-${++n}`,
  });
  t.account = undefined;
  const { default: manager } = await importAsNewTab(() => import('./channel'));
  const access = server.addChannel(C);
  manager.registerAccessForChannel(access, { lastRead: '2026-11-02T10:00:00.000Z' });
  return { manager, server, rt: t.rt, access };
}

describe('channelManager façade', () => {
  it('starts the runtime on load; keeps access and the account user', async () => {
    t.started = 0;
    const { manager, access } = await setup();
    expect(t.started).toBe(1);
    expect(manager.getAccessForChannel(C)).toEqual(access);
    manager.userId = 'u1';
    expect(manager.userId).toBe('u1');
    expect(t.account).toBe('u1');
    manager.userId = undefined;
    expect(t.account).toBeUndefined();
  });

  it('passes sends, edits, reactions and deletes to the store', async () => {
    const { manager, server } = await setup();
    const seed = server.seed(C, 1);
    const w = manager.openWindow(C);
    await w.init({ type: 'recent' });
    await manager.createMessage({ channelId: C, body: textBody('hi'), attachments: [], parentMessageId: null, creatorId: 'ignored' });
    expect(w.state.items.at(-1)?.sendStatus).toBe('sending');
    await settle();
    expect(server.rows(C)).toHaveLength(2);
    expect(w.state.items.at(-1)?.sendStatus).toBeUndefined();

    const first = w.state.items[0];
    await manager.editMessage(first, { body: textBody('edited'), attachments: [] });
    expect(textOf(w.state.items[0])).toBe('edited');
    await settle();
    expect(textOf(server.row(C, seed[0].id)!)).toBe('edited');

    await manager.setReaction(C, first, '👍');
    await manager.unsetReaction(C, first);
    expect(server.callsOf('setReaction')).toHaveLength(1);
    expect(server.callsOf('unsetReaction')).toHaveLength(1);

    await manager.deleteMessage(C, first.id, first.creatorId);
    expect(w.state.items.some(i => i.id === first.id)).toBe(false);
    w.destroy();
  });

  it('a moderation message uses the moderation endpoint', async () => {
    const { manager, server } = await setup();
    const w = manager.openWindow(C);
    await w.init({ type: 'recent' });
    await manager.createMessage({ channelId: C, body: textBody('mod'), attachments: [], parentMessageId: null }, true);
    await settle();
    expect(server.callsOf('createModerationMessage')).toHaveLength(1);
    w.destroy();
  });

  it('deleteChannelDatabase forgets the channel; clear() clears the stores and re-inits windows', async () => {
    const { manager, server, rt } = await setup();
    server.seed(C, 2);
    const w = manager.openWindow(C);
    await w.init({ type: 'recent' });
    rt.readState.apply({ kind: 'snapshot', channelId: C, lastRead: null, unread: 2, lastMessageDate: '2026-11-02T11:00:00.000Z' });
    rt.setupAfterLogin(4);
    await manager.clear();
    expect(rt.readState.get(C)).toBeUndefined();
    expect(rt.notifications.unreadCount).toBe(0);
    await settle();
    expect(w.state.items).toHaveLength(2);
    const loads = server.callsOf('loadMessages').length;
    expect(manager.deleteChannelDatabase({ channelId: C })).toBeUndefined();
    expect(w.state.items).toHaveLength(0);
    expect(server.callsOf('loadMessages').length).toBe(loads);
    w.destroy();
  });

  it('applyStoredReadState mirrors stored rows into the read-state store', async () => {
    const { manager, rt } = await setup();
    manager.applyStoredReadState([{ channelId: C, lastRead: '2026-11-02T10:00:00.000Z', unread: 3, seq: 0, counted: [], lastMessageDate: '2026-11-02T11:00:00.000Z' }]);
    expect(rt.readState.get(C)).toMatchObject({ unread: 3 });
  });

  it('createMarker marks through the read-state store: the only setChannelLastRead sender', async () => {
    const { manager, server } = await setup();
    server.userId = 'user-me';
    server.seed(C, 2);
    const w = manager.openWindow(C);
    await w.init({ type: 'recent' });
    const newest = w.state.items.at(-1)!;
    const marker = manager.createMarker(C);
    marker.update({ atLatest: true, atBottom: true, newest: { id: newest.id, createdAt: newest.createdAt } });
    await settle();
    const calls = server.callsOf('setChannelLastRead') as API.Messages.setChannelLastRead.Request[];
    expect(calls).toHaveLength(1);
    expect(calls[0].lastRead).toBe(newest.createdAt.toISOString());
    marker.dispose();
    w.destroy();
  });
});
