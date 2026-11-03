// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
// aliased: called from plain setup helpers, not React hooks
import { useDataLayerFakeTimers as installFakeTimers } from 'test/timers';
import { flushMicrotasks } from 'test/deferred';
import { installBrowserEnv } from 'test/env';
import { importAsNewTab } from 'test/modules';
import { FakeChatServer, ME, OTHER_USER } from './testing/fakeServer';
import { systemClock } from './util';
import { SYNC_STATE_DEBOUNCE_MS } from './readStateStore';
import type { ChatEventInputs } from './runtime';
import type { ReadStateInput } from './types';
import type { LiveKind, ResumeReason } from 'data/appstate/transport';

// ---------------------------------------------------------------------------
// app modules the runtime singleton wires (mocked: no socket, no Dexie)
// ---------------------------------------------------------------------------

type Handler = (event: unknown) => void;

const app = vi.hoisted(() => {
  class Emitter<A extends unknown[]> {
    listeners = new Set<(...args: A) => void>();
    add(l: (...args: A) => void) {
      this.listeners.add(l);
      return () => {
        this.listeners.delete(l);
      };
    }
    emit(...args: A) {
      for (const l of [...this.listeners]) l(...args);
    }
  }
  const state = {
    server: undefined as unknown as FakeChatServer,
    handlers: new Map<string, Set<Handler>>(),
    loginState: 'anonymous' as Common.LoginState,
    visibilityState: 'visible' as Common.VisibilityState,
    loginListeners: new Set<(s: Common.LoginState) => void>(),
    visibilityListeners: new Set<(s: Common.VisibilityState) => void>(),
    live: true,
    onLive: new Emitter<[LiveKind]>(),
    onResume: new Emitter<[ResumeReason]>(),
    persisted: [] as ReadStateInput[],
    dmWrites: [] as { channelId: string; id: string; own: boolean }[],
  };
  return state;
});

function forward(method: string) {
  return (...args: unknown[]) => (app.server as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args);
}

vi.mock('data/api/messages', () => ({
  default: new Proxy({}, { get: (_t, p) => forward(String(p)) }),
}));
vi.mock('data/api/notifications', () => ({
  default: new Proxy({}, { get: (_t, p) => forward(String(p)) }),
}));
vi.mock('data/appstate/connection', () => ({
  default: {
    registerClientEventHandler(type: string, fn: Handler) {
      let set = app.handlers.get(type);
      if (!set) app.handlers.set(type, (set = new Set()));
      set.add(fn);
    },
    unregisterClientEventHandler(type: string, fn: Handler) {
      app.handlers.get(type)?.delete(fn);
    },
    get loginState() {
      return app.loginState;
    },
    get visibilityState() {
      return app.visibilityState;
    },
    addListener(type: string, fn: never) {
      if (type === 'loginStateChange') app.loginListeners.add(fn);
      if (type === 'visibilityStateChange') app.visibilityListeners.add(fn);
    },
    removeListener(type: string, fn: never) {
      app.loginListeners.delete(fn);
      app.visibilityListeners.delete(fn);
    },
  },
}));
vi.mock('data/appstate/webSocket', () => ({
  default: {
    get live() {
      return app.live;
    },
    onLive: (l: (k: LiveKind) => void) => app.onLive.add(l),
    onResume: (l: (r: ResumeReason) => void) => app.onResume.add(l),
  },
}));
vi.mock('data/databases/readStatePersistence', () => ({
  default: { apply: async (input: ReadStateInput) => { app.persisted.push(input); } },
}));
vi.mock('data/databases/chats', () => ({
  default: {
    newMessageReceived: async (channelId: string, message: Models.Message.Message, own: boolean) => {
      app.dmWrites.push({ channelId, id: message.id, own });
    },
  },
}));

function emitClientEvent(event: { type: string } & Record<string, unknown>) {
  for (const fn of [...(app.handlers.get(event.type) ?? [])]) fn(event);
}

function setLoginState(state: Common.LoginState) {
  app.loginState = state;
  for (const l of [...app.loginListeners]) l(state);
}

function setVisibility(state: Common.VisibilityState) {
  app.visibilityState = state;
  for (const l of [...app.visibilityListeners]) l(state);
}

function resetApp() {
  app.server = new FakeChatServer();
  app.handlers.clear();
  app.loginState = 'anonymous';
  app.visibilityState = 'visible';
  app.loginListeners.clear();
  app.visibilityListeners.clear();
  app.live = true;
  app.onLive.listeners.clear();
  app.onResume.listeners.clear();
  app.persisted = [];
  app.dmWrites = [];
}

async function settle() {
  await vi.advanceTimersByTimeAsync(0);
  await flushMicrotasks(50);
}

const C = 'ch-1';
const DM = 'dm-1';

// ---------------------------------------------------------------------------
// createChatEventSource / createLoginUser (pure)
// ---------------------------------------------------------------------------

function fakeInputs() {
  const handlers = new Map<string, Set<Handler>>();
  const live = new Set<(k: LiveKind) => void>();
  const resume = new Set<(r: ResumeReason) => void>();
  const vis = new Set<(v: boolean) => void>();
  const usr = new Set<(u: string | undefined) => void>();
  const s = { visible: true, userId: undefined as string | undefined, live: false };
  const inputs: ChatEventInputs = {
    clientEvents: {
      register: (type, fn) => {
        let set = handlers.get(type);
        if (!set) handlers.set(type, (set = new Set()));
        set.add(fn as Handler);
      },
      unregister: (type, fn) => {
        handlers.get(type)?.delete(fn as Handler);
      },
    },
    transport: {
      get live() {
        return s.live;
      },
      onLive: l => { live.add(l); return () => live.delete(l); },
      onResume: l => { resume.add(l); return () => resume.delete(l); },
    },
    visibility: {
      get visible() {
        return s.visible;
      },
      onChange: l => { vis.add(l); return () => vis.delete(l); },
    },
    user: {
      get userId() {
        return s.userId;
      },
      onChange: l => { usr.add(l); return () => usr.delete(l); },
    },
  };
  const emit = (type: string, event: unknown) => {
    for (const fn of [...(handlers.get(type) ?? [])]) fn(event);
  };
  return { inputs, handlers, live, resume, vis, usr, s, emit };
}

describe('createChatEventSource', () => {
  it('routes the three socket events to their listeners, one handler per type', async () => {
    const { createChatEventSource } = await import('./runtime');
    const f = fakeInputs();
    const source = createChatEventSource(f.inputs);
    expect([...f.handlers.keys()].sort()).toEqual(['cliChannelLastRead', 'cliMessageEvent', 'cliNotificationEvent']);
    const seen: string[] = [];
    source.onMessageEvent(e => seen.push(`m:${e.action}`));
    source.onMessageEvent(e => seen.push(`m2:${e.action}`));
    source.onLastReadEvent(e => seen.push(`r:${e.channelId}`));
    source.onNotificationEvent(e => seen.push(`n:${e.action}`));
    f.emit('cliMessageEvent', { type: 'cliMessageEvent', action: 'delete', data: { channelId: C, deletedIds: [] } });
    f.emit('cliChannelLastRead', { type: 'cliChannelLastRead', channelId: C, lastRead: '2026-11-02T12:00:00.000Z' });
    f.emit('cliNotificationEvent', { type: 'cliNotificationEvent', action: 'allread', data: { updatedAt: 'x' } });
    expect(seen).toEqual(['m:delete', 'm2:delete', `r:${C}`, 'n:allread']);
  });

  it('a throwing listener does not keep the others from the event', async () => {
    const { createChatEventSource } = await import('./runtime');
    const f = fakeInputs();
    const source = createChatEventSource(f.inputs);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const seen: string[] = [];
    source.onMessageEvent(() => {
      throw new Error('boom');
    });
    source.onMessageEvent(e => seen.push(e.action));
    f.emit('cliMessageEvent', { type: 'cliMessageEvent', action: 'delete', data: { channelId: C, deletedIds: [] } });
    expect(seen).toEqual(['delete']);
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it('passes live/onLive/onResume through and dedupes visibility and user changes', async () => {
    const { createChatEventSource } = await import('./runtime');
    const f = fakeInputs();
    const source = createChatEventSource(f.inputs);
    const seen: unknown[] = [];
    source.onLive(k => seen.push(`live:${k}`));
    source.onResume(r => seen.push(`resume:${r}`));
    source.onVisibilityChange(v => seen.push(`vis:${v}`));
    source.onUserChange(u => seen.push(`user:${u}`));
    expect(source.live).toBe(false);
    f.s.live = true;
    expect(source.live).toBe(true);
    for (const l of f.live) l('restored');
    for (const l of f.resume) l('visible');
    for (const l of f.vis) l(true); // unchanged: no event
    for (const l of f.vis) l(false);
    for (const l of f.usr) l(ME);
    for (const l of f.usr) l(ME);
    // logged in while live: a `user` live follows, so the stores catch up
    expect(seen).toEqual(['live:restored', 'resume:visible', 'vis:false', `user:${ME}`, 'live:user']);
    expect(source.visible).toBe(false);
    expect(source.userId).toBe(ME);
  });

  it('dispose unregisters from every input', async () => {
    const { createChatEventSource } = await import('./runtime');
    const f = fakeInputs();
    const source = createChatEventSource(f.inputs);
    const seen: string[] = [];
    source.onMessageEvent(e => seen.push(e.action));
    source.dispose();
    f.emit('cliMessageEvent', { type: 'cliMessageEvent', action: 'delete', data: { channelId: C, deletedIds: [] } });
    expect(seen).toEqual([]);
    expect([...f.handlers.values()].every(s => s.size === 0)).toBe(true);
    expect(f.live.size + f.resume.size + f.vis.size + f.usr.size).toBe(0);
  });
});

describe('createLoginUser', () => {
  it('is the account only while logged in', async () => {
    const { createLoginUser } = await import('./runtime');
    let state: Common.LoginState = 'loggingin';
    const listeners = new Set<(s: Common.LoginState) => void>();
    const user = createLoginUser({
      get loginState() {
        return state;
      },
      onLoginStateChange: l => { listeners.add(l); return () => listeners.delete(l); },
    });
    const seen: (string | undefined)[] = [];
    user.onChange(u => seen.push(u));
    user.setAccount(ME);
    expect(user.userId).toBeUndefined();
    state = 'loggedin';
    for (const l of listeners) l(state);
    expect(user.userId).toBe(ME);
    state = 'loggingout';
    for (const l of listeners) l(state);
    user.setAccount(undefined);
    expect(seen).toEqual([ME, undefined]);
  });
});

// ---------------------------------------------------------------------------
// createChatRuntime against the fake server
// ---------------------------------------------------------------------------

async function runtimeSetup() {
  installFakeTimers({ now: new Date('2026-11-02T12:00:00Z') });
  const { createChatRuntime } = await import('./runtime');
  const server = new FakeChatServer();
  const persisted: ReadStateInput[] = [];
  const dmWrites: { channelId: string; id: string; own: boolean }[] = [];
  let n = 0;
  const rt = createChatRuntime({
    chatApi: server,
    notificationApi: server,
    events: server,
    clock: systemClock,
    newId: () => `local-${++n}`,
    persistence: { apply: async input => { persisted.push(input); } },
    dmMessage: async (channelId, message, own) => { dmWrites.push({ channelId, id: message.id, own }); },
  });
  const access = server.addChannel(C);
  rt.channels.registerAccessForChannel(access);
  return { rt, server, persisted, dmWrites, access };
}

describe('createChatRuntime', () => {
  it('live and resume resync the open windows (getChanges) and the read state (getSyncState)', async () => {
    const { rt, server } = await runtimeSetup();
    server.seed(C, 3);
    const w = rt.channels.openWindow(C);
    await w.init({ type: 'recent' });
    expect(w.state.items).toHaveLength(3);
    server.goOffline();
    server.post(C, { text: 'missed' }); // lost: not live
    expect(w.state.items).toHaveLength(3);
    server.goLive('restored');
    await vi.advanceTimersByTimeAsync(SYNC_STATE_DEBOUNCE_MS);
    await settle();
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(w.state.items).toHaveLength(4);
    expect(server.callsOf('getChanges').length).toBeGreaterThan(0);
    expect(server.callsOf('getSyncState').length).toBe(1);
    server.resume('visible');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(server.callsOf('getSyncState').length).toBe(2);
    w.destroy();
    rt.dispose();
  });

  it('an own confirmed message reaches the read state as an own post (community channel)', async () => {
    const { rt, server, persisted } = await runtimeSetup();
    const w = rt.channels.openWindow(C);
    await w.init({ type: 'recent' });
    await rt.channels.createMessage({ channelId: C, body: { version: '1', content: [] } as unknown as Models.Message.Body, attachments: [], parentMessageId: null });
    await settle();
    const own = persisted.filter(i => i.kind === 'message');
    expect(own).toHaveLength(1);
    expect(own[0]).toMatchObject({ kind: 'message', channelId: C, own: true });
    expect(rt.readState.get(C)?.lastRead).toBe((own[0] as { createdAt: string }).createdAt);
    expect(server.callsOf('createMessage')).toHaveLength(1);
    w.destroy();
    rt.dispose();
  });

  it('DM messages go to the chat row writer once (with lastMessage), not also to the persistence', async () => {
    const { rt, server, persisted, dmWrites } = await runtimeSetup();
    const dmAccess = server.addChannel(DM, { chatId: 'chat-1' });
    rt.channels.registerAccessForChannel(dmAccess);
    const e = server.post(DM, { text: 'hi' });
    await settle();
    const id = (e as Extract<Events.Message.Message, { action: 'new' }>).data.id;
    expect(dmWrites).toEqual([{ channelId: DM, id, own: false }]);
    expect(persisted.filter(i => i.kind === 'message' && i.channelId === DM)).toHaveLength(0);
    expect(rt.readState.get(DM)?.unread).toBe(1);
    // an own message from another device of this user
    server.post(DM, { creatorId: ME, text: 'me elsewhere' });
    await settle();
    expect(dmWrites[1]).toMatchObject({ channelId: DM, own: true });
    // community messages still go through the persistence
    server.post(C, { text: 'community' });
    await settle();
    expect(persisted.filter(i => i.kind === 'message' && i.channelId === C)).toHaveLength(1);
    expect(dmWrites).toHaveLength(2);
    rt.dispose();
  });

  it('stored seq/counted dedupe live messages already counted in the row', async () => {
    const { rt } = await runtimeSetup();
    rt.applyStoredReadState([{ channelId: C, lastRead: '2026-11-02T10:00:00.000Z', unread: 4, seq: 7, counted: [8], lastMessageDate: '2026-11-02T11:00:00.000Z' }]);
    const msg = (id: string, syncSeq: number) => ({ kind: 'message' as const, channelId: C, messageId: id, createdAt: '2026-11-02T11:05:00.000Z', syncSeq, own: false });
    rt.readState.apply(msg('m8', 8)); // counted in the row already
    expect(rt.readState.get(C)?.unread).toBe(4);
    rt.readState.apply(msg('m9', 9));
    expect(rt.readState.get(C)).toMatchObject({ unread: 5, counted: [8, 9] });
    rt.dispose();
  });

  it('stored state never counts as acknowledged: a mark above the row lastRead is still sent', async () => {
    const { rt, server } = await runtimeSetup();
    server.seed(C, 1);
    const w = rt.channels.openWindow(C);
    await w.init({ type: 'recent' });
    const newest = w.state.items[0];
    // the row holds a local mark at the newest message that never reached the server
    rt.applyStoredReadState([{ channelId: C, lastRead: newest.createdAt.toISOString(), unread: 0, seq: 3, counted: [], lastMessageDate: newest.createdAt.toISOString() }]);
    const marker = rt.readState.createMarker(C);
    marker.update({ atLatest: true, atBottom: true, newest: { id: newest.id, createdAt: newest.createdAt } });
    await settle();
    expect(server.callsOf('setChannelLastRead')).toHaveLength(1);
    marker.dispose();
    w.destroy();
    rt.dispose();
  });

  it('clear tells watchers their message is gone, then refetches it', async () => {
    const { rt, server } = await runtimeSetup();
    const [m] = server.seed(C, 1);
    const seen: (string | undefined)[] = [];
    const unwatch = rt.channels.watchMessage(C, m.id, item => seen.push(item?.id));
    await settle();
    expect(seen).toEqual([m.id]);
    rt.clear();
    expect(seen).toEqual([m.id, undefined]);
    await settle();
    expect(seen).toEqual([m.id, undefined, m.id]);
    unwatch();
    rt.dispose();
  });

  it('watchMessage reports a failed fetch to onError and retries on the next live signal', async () => {
    const { rt, server } = await runtimeSetup();
    const [m] = server.seed(C, 1);
    server.fail('messagesById', new Error('Network down'), 1);
    const seen: (string | undefined)[] = [];
    const errors: unknown[] = [];
    const unwatch = rt.channels.watchMessage(C, m.id, item => seen.push(item?.id), e => errors.push(e));
    await settle();
    expect(errors).toHaveLength(1);
    expect(seen).toEqual([]);
    server.goLive('restored');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(seen).toEqual([m.id]);
    unwatch();
    rt.dispose();
  });

  it('own messages are classified by the account before the login settled', async () => {
    const { rt, server } = await runtimeSetup();
    server.userId = undefined; // logging in
    server.accountId = ME;
    const e = server.post(C, { creatorId: ME, text: 'from my other tab' });
    const createdAt = (e as Extract<Events.Message.Message, { action: 'new' }>).data.createdAt;
    expect(rt.readState.get(C)).toMatchObject({ unread: 0, lastRead: createdAt });
    rt.dispose();
  });

  it('notifications are not resynced without a user', async () => {
    const { rt, server } = await runtimeSetup();
    server.userId = undefined;
    server.goLive('established');
    server.resume('visible');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(server.callsOf('getUnreadCount')).toHaveLength(0);
    expect(server.callsOf('getSyncState')).toHaveLength(0);
    rt.dispose();
  });

  it('a call chat access with a communityId gets no read state from live messages', async () => {
    const { rt, server } = await runtimeSetup();
    server.addChannel('call-ch2', { communityId: 'community-1' });
    rt.channels.registerAccessForChannel({ channelId: 'call-ch2', callId: 'call-2', communityId: 'community-1' } as API.Messages.MessageAccess);
    server.post('call-ch2', { text: 'in the call' });
    expect(rt.readState.get('call-ch2')).toBeUndefined();
    rt.dispose();
  });

  it('article comments and call chats get no read state', async () => {
    const { rt, server } = await runtimeSetup();
    server.addChannel('article-ch', {});
    rt.channels.registerAccessForChannel({ channelId: 'article-ch', articleId: 'a1', articleCommunityId: 'c1' });
    server.addChannel('call-ch', {});
    rt.channels.registerAccessForChannel({ channelId: 'call-ch', callId: 'call-1' });
    for (const channelId of ['article-ch', 'call-ch']) {
      const w = rt.channels.openWindow(channelId);
      await w.init({ type: 'recent' });
      await rt.channels.createMessage({ channelId, body: { version: '1', content: [] } as unknown as Models.Message.Body, attachments: [], parentMessageId: null });
      await settle();
      expect(rt.readState.get(channelId)).toBeUndefined();
      w.destroy();
    }
    rt.dispose();
  });

  it('stored read state is fed to memory only: a snapshot reaches the rows once', async () => {
    const { rt, persisted } = await runtimeSetup();
    rt.applyStoredReadState([{ channelId: C, lastRead: '2026-11-02T10:00:00.000Z', unread: 4, seq: 7, counted: [8], lastMessageDate: '2026-11-02T11:00:00.000Z' }]);
    // the row's seq and counted seqs are kept in memory
    expect(rt.readState.get(C)).toMatchObject({ unread: 4, lastRead: '2026-11-02T10:00:00.000Z', seq: 7, counted: [8] });
    await settle();
    expect(persisted).toHaveLength(0);
    // an older stored value never moves lastRead back
    rt.applyStoredReadState([{ channelId: C, lastRead: '2026-11-02T09:00:00.000Z', unread: 9, seq: 0, counted: [], lastMessageDate: '2026-11-02T11:00:00.000Z' }]);
    expect(rt.readState.get(C)).toMatchObject({ unread: 4, lastRead: '2026-11-02T10:00:00.000Z' });
    // other inputs are still persisted
    rt.readState.apply({ kind: 'lastRead', channelId: C, lastRead: '2026-11-02T11:30:00.000Z' });
    await settle();
    expect(persisted).toHaveLength(1);
    rt.dispose();
  });

  it('setupAfterLogin takes the login count; clear empties all stores and re-inits initialised windows', async () => {
    const { rt, server } = await runtimeSetup();
    server.seed(C, 2);
    rt.setupAfterLogin('3');
    expect(rt.notifications.unreadCount).toBe(3);
    rt.readState.apply({ kind: 'snapshot', channelId: C, lastRead: null, unread: 2, lastMessageDate: '2026-11-02T11:00:00.000Z' });
    const w = rt.channels.openWindow(C);
    const idle = rt.channels.openWindow(C); // never initialised by its owner
    await w.init({ type: 'recent' });
    expect(w.state.items).toHaveLength(2);
    const loads = server.callsOf('loadMessages').length + server.callsOf('getChanges').length;
    const changes: string[] = [];
    w.subscribe((_s, change) => changes.push(change.kind === 'reset' ? `reset:${change.cause}` : change.kind));
    rt.clear();
    expect(rt.notifications.unreadCount).toBe(0);
    expect(rt.readState.get(C)).toBeUndefined();
    expect(w.state.items).toHaveLength(0);
    await settle();
    expect(w.state.items).toHaveLength(2);
    expect(w.state.ready).toBe(true);
    expect(changes[0]).toBe('reset:resync');
    // the re-init: a fresh slice at the latest end
    expect(changes.slice(1).some(c => c.startsWith('reset:'))).toBe(true);
    expect(server.callsOf('loadMessages').length + server.callsOf('getChanges').length).toBe(loads + 1);
    expect(idle.state.ready).toBe(false);
    // access stays registered (anonymous viewing of public channels)
    expect(rt.channels.getAccessForChannel(C)).toBeDefined();
    w.destroy();
    idle.destroy();
    rt.dispose();
  });

  it('a destroyed window is not re-initialised', async () => {
    const { rt, server } = await runtimeSetup();
    server.seed(C, 1);
    const w = rt.channels.openWindow(C);
    await w.init({ type: 'recent' });
    w.destroy();
    const loads = server.callsOf('loadMessages').length;
    rt.clear();
    await settle();
    expect(server.callsOf('loadMessages').length).toBe(loads);
    rt.dispose();
  });
});

// ---------------------------------------------------------------------------
// the app singleton: socket events, transport, visibility and login wired up
// ---------------------------------------------------------------------------

describe('chat (app runtime)', () => {
  async function appSetup() {
    installFakeTimers({ now: new Date('2026-11-02T12:00:00Z') });
    installBrowserEnv();
    resetApp();
    const mod = await importAsNewTab(() => import('./runtime'));
    return { mod, server: app.server };
  }

  it('startChatRuntime creates it once', async () => {
    const { mod } = await appSetup();
    mod.startChatRuntime();
    mod.startChatRuntime();
    expect([...app.handlers.values()].every(s => s.size === 1)).toBe(true);
    expect(app.onLive.listeners.size).toBeGreaterThan(0);
  });

  it('is created lazily and registers the three socket handlers once', async () => {
    const { mod } = await appSetup();
    expect(app.handlers.size).toBe(0);
    const { channels } = mod.chat;
    expect(mod.chat.channels).toBe(channels);
    expect([...app.handlers.keys()].sort()).toEqual(['cliChannelLastRead', 'cliMessageEvent', 'cliNotificationEvent']);
    expect([...app.handlers.values()].every(s => s.size === 1)).toBe(true);
  });

  it('routes socket events through connectionManager to the stores', async () => {
    const { mod, server } = await appSetup();
    const access = server.addChannel(C);
    mod.chat.channels.registerAccessForChannel(access);
    server.seed(C, 1);
    const w = mod.chat.channels.openWindow(C);
    await w.init({ type: 'recent' });
    // the fake server's own listeners are not wired: deliver through the connection
    const event = server.post(C, { text: 'live' }, { deliver: false });
    emitClientEvent(event);
    expect(w.state.items).toHaveLength(2);
    expect(mod.chat.readState.get(C)?.unread).toBe(1);
    emitClientEvent({ type: 'cliChannelLastRead', channelId: C, lastRead: (event as Extract<Events.Message.Message, { action: 'new' }>).data.createdAt, communityId: 'community-1' });
    expect(mod.chat.readState.get(C)?.unread).toBe(0);
    const n = server.addNotification({}, { deliver: false });
    emitClientEvent(n);
    expect(mod.chat.notifications.unreadCount).toBe(1);
    await settle();
    expect(app.persisted.some(i => i.kind === 'message')).toBe(true);
    w.destroy();
  });

  it('live/resume from the transport trigger the catch-up', async () => {
    const { mod, server } = await appSetup();
    const access = server.addChannel(C);
    mod.chat.channels.registerAccessForChannel(access);
    mod.setChatAccountUser(ME);
    setLoginState('loggedin');
    const w = mod.chat.channels.openWindow(C);
    await w.init({ type: 'recent' });
    server.post(C, { text: 'missed' }, { deliver: false });
    app.onLive.emit('restored');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(w.state.items).toHaveLength(1);
    expect(server.callsOf('getSyncState')).toHaveLength(1);
    app.onResume.emit('online');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(server.callsOf('getSyncState')).toHaveLength(2);
    w.destroy();
  });

  it('page load: the socket is live before loggedin; the login then triggers the catch-up', async () => {
    const { mod, server } = await appSetup();
    mod.startChatRuntime();
    mod.setChatAccountUser(ME); // stored user, login pending
    setLoginState('loggingin');
    app.onLive.emit('established');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(server.callsOf('getSyncState')).toHaveLength(0);
    expect(server.callsOf('getUnreadCount')).toHaveLength(0);
    setLoginState('loggedin');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(server.callsOf('getSyncState')).toHaveLength(1);
    expect(server.callsOf('getUnreadCount')).toHaveLength(1);
  });

  it('interactive login: the socket login ack (live user) comes before loggedin', async () => {
    const { mod, server } = await appSetup();
    mod.startChatRuntime();
    app.onLive.emit('established'); // anonymous
    setLoginState('loggingin');
    app.onLive.emit('user'); // socket login acked
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(server.callsOf('getSyncState')).toHaveLength(0);
    mod.setChatAccountUser(ME);
    setLoginState('loggedin');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(server.callsOf('getSyncState')).toHaveLength(1);
  });

  it('loggedin before the socket is live: the later live triggers one catch-up', async () => {
    const { mod, server } = await appSetup();
    app.live = false;
    mod.startChatRuntime();
    mod.setChatAccountUser(ME);
    setLoginState('loggedin');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    app.live = true;
    app.onLive.emit('established');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    // the user change while not live does not sync by itself: exactly one call
    expect(server.callsOf('getSyncState')).toHaveLength(1);
  });

  it('interactive login: socket login started (not live) before loggedin, ack after: one catch-up', async () => {
    const { mod, server } = await appSetup();
    mod.startChatRuntime();
    app.onLive.emit('established'); // anonymous
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    setLoginState('loggingin');
    mod.setChatAccountUser(ME);
    app.live = false; // webSocketManager.login during setupAfterLogin
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    setLoginState('loggedin');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(server.callsOf('getSyncState')).toHaveLength(0);
    app.live = true;
    app.onLive.emit('user'); // socket login acked
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(server.callsOf('getSyncState')).toHaveLength(1);
  });

  it('user switch A -> B through a logout: one catch-up per user', async () => {
    const { mod, server } = await appSetup();
    mod.startChatRuntime();
    mod.setChatAccountUser(ME);
    setLoginState('loggedin');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(server.callsOf('getSyncState')).toHaveLength(1);
    // the other tab logged out: drop this tab's login, socket logout
    setLoginState('loggingout');
    mod.setChatAccountUser(undefined);
    mod.clearChat();
    setLoginState('anonymous');
    app.live = false;
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    app.live = true;
    app.onLive.emit('user');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    // then user B takes over the session: loggedin before the socket login ack
    mod.setChatAccountUser(OTHER_USER);
    app.live = false;
    setLoginState('loggedin');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    app.live = true;
    app.onLive.emit('user');
    await vi.advanceTimersByTimeAsync(1_000);
    await settle();
    expect(server.callsOf('getSyncState')).toHaveLength(2);
  });

  it('own messages during the login are classified by the account', async () => {
    const { mod, server } = await appSetup();
    const access = server.addChannel(C);
    mod.chat.channels.registerAccessForChannel(access);
    mod.setChatAccountUser(ME);
    setLoginState('loggingin');
    const event = server.post(C, { creatorId: ME }, { deliver: false });
    emitClientEvent(event);
    expect(mod.chat.events.userId).toBeUndefined();
    expect(mod.chat.events.accountId).toBe(ME);
    expect(mod.chat.readState.get(C)?.unread).toBe(0);
  });

  it('the user is the account while logged in; visibility follows connectionManager', async () => {
    const { mod } = await appSetup();
    const { events } = mod.chat;
    const seen: unknown[] = [];
    events.onUserChange(u => seen.push(u));
    events.onVisibilityChange(v => seen.push(v));
    mod.setChatAccountUser(ME);
    expect(events.userId).toBeUndefined();
    expect(mod.getChatAccountUser()).toBe(ME);
    setLoginState('loggedin');
    expect(events.userId).toBe(ME);
    setVisibility('hidden');
    expect(events.visible).toBe(false);
    setLoginState('anonymous');
    mod.setChatAccountUser(undefined);
    expect(seen).toEqual([ME, false, undefined]);
  });

  it('DM messages update the chat row through chatDatabase', async () => {
    const { mod, server } = await appSetup();
    const access = server.addChannel(DM, { chatId: 'chat-1' });
    mod.chat.channels.registerAccessForChannel(access);
    const event = server.post(DM, { creatorId: OTHER_USER }, { deliver: false });
    emitClientEvent(event);
    await settle();
    expect(app.dmWrites).toHaveLength(1);
    expect(app.persisted.filter(i => i.kind === 'message')).toHaveLength(0);
  });

  it('an edit is sent without image metadata, the overlay keeps it', async () => {
    const { mod, server } = await appSetup();
    const access = server.addChannel(C);
    mod.chat.channels.registerAccessForChannel(access);
    server.seed(C, 1);
    const w = mod.chat.channels.openWindow(C);
    await w.init({ type: 'recent' });
    const image: Models.Message.Attachment = {
      type: 'image', imageId: 'i1', largeImageId: 'i2',
      imageData: { size: { width: 1, height: 1 } } as unknown as Common.ImageMetadata,
      largeImageData: { size: { width: 2, height: 2 } } as unknown as Common.ImageMetadata,
    };
    await mod.chat.channels.editMessage(w.state.items[0], { body: w.state.items[0].body, attachments: [image], parentMessageId: null });
    expect(w.state.items[0].attachments[0]).toEqual(image);
    const sent = server.callsOf('editMessage')[0] as API.Messages.editMessage.Request;
    expect(sent.attachments).toEqual([{ type: 'image', imageId: 'i1', largeImageId: 'i2' }]);
    w.destroy();
  });

  it('setupChatAfterLogin / clearChat drive the notification count and the logout', async () => {
    const { mod } = await appSetup();
    mod.clearChat(); // before first use: nothing happens
    expect(app.handlers.size).toBe(0);
    mod.setupChatAfterLogin(5);
    expect(mod.chat.notifications.unreadCount).toBe(5);
    mod.applyStoredReadState([{ channelId: C, lastRead: null, unread: 1, seq: 0, counted: [], lastMessageDate: '2026-11-02T11:00:00.000Z' }]);
    expect(mod.chat.readState.get(C)?.unread).toBe(1);
    mod.clearChat();
    expect(mod.chat.notifications.unreadCount).toBe(0);
    expect(mod.chat.readState.get(C)).toBeUndefined();
  });
});
