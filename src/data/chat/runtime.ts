// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * The chat-sync runtime of one tab: the three stores (contract: ./types.ts)
 * built once, lazily, with the real connectors, the ChatEventSource below and
 * the shared entity-db persistence. Nobody else creates stores:
 *
 *   import { chat } from 'data/chat/runtime';
 *   chat.channels.openWindow(channelId)       // also data.channelManager (façade)
 *   chat.readState.createMarker(channelId)
 *   chat.notifications.subscribeUnreadCount(fn)
 *
 * Login hook-up (login.ts): `setupChatAfterLogin(count)` with the login
 * response's notification count, `clearChat()` on every logout (this tab's or
 * another tab's), and the account user via the façade's `userId` setter
 * (`setChatAccountUser`).
 *
 * The builders (`createChatEventSource`, `createChatRuntime`) take their
 * inputs injected so the unit tests run without the app modules.
 */

import messageApi from 'data/api/messages';
import notificationsApi from 'data/api/notifications';
import connectionManager from 'data/appstate/connection';
import webSocketManager from 'data/appstate/webSocket';
import type { LiveKind, ResumeReason, Transport } from 'data/appstate/transport';
import { createChannelStore } from './channelStore';
import { createReadStateStore } from './readStateStore';
import { createNotificationStore } from './notificationStore';
import { systemClock } from './util';
import type {
  ChannelReadState,
  ChannelStore,
  ChannelWindow,
  ChatApi,
  ChatClock,
  ChatEventSource,
  NotificationApi,
  NotificationStore,
  ReadStateInput,
  ReadStatePersistence,
  ReadStateStore,
  Unsubscribe,
} from './types';

export type ChatRuntime = {
  /** also exposed as `data.channelManager` (façade, data/databases/channel.ts) */
  readonly channels: ChannelStore;
  readonly readState: ReadStateStore;
  readonly notifications: NotificationStore;
  readonly events: ChatEventSource;
};

// ---------------------------------------------------------------------------
// Event source
// ---------------------------------------------------------------------------

type ClientEventType = 'cliMessageEvent' | 'cliChannelLastRead' | 'cliNotificationEvent';
type ClientEventOf<T extends ClientEventType> = Events.ClientEvent & { type: T };

/** what the event source is built from (connectionManager, webSocketManager, document, login) */
export type ChatEventInputs = {
  /** connectionManager.registerClientEventHandler / unregisterClientEventHandler */
  clientEvents: {
    register<T extends ClientEventType>(type: T, fn: (event: ClientEventOf<T>) => void): void;
    unregister<T extends ClientEventType>(type: T, fn: (event: ClientEventOf<T>) => void): void;
  };
  transport: Pick<Transport, 'live' | 'onLive' | 'onResume'>;
  visibility: {
    readonly visible: boolean;
    onChange(listener: (visible: boolean) => void): Unsubscribe;
  };
  user: {
    readonly userId: string | undefined;
    onChange(listener: (userId: string | undefined) => void): Unsubscribe;
  };
};

export interface DisposableChatEventSource extends ChatEventSource {
  /** unregister from every input */
  dispose(): void;
}

class Fanout<A extends unknown[]> {
  private readonly listeners = new Set<(...args: A) => void>();

  add(listener: (...args: A) => void): Unsubscribe {
    // a wrapper per subscription: the same function may subscribe twice
    const entry = (...args: A) => listener(...args);
    this.listeners.add(entry);
    return () => {
      this.listeners.delete(entry);
    };
  }

  emit(...args: A): void {
    for (const l of [...this.listeners]) {
      // one failing store must not keep the others from the event
      try {
        l(...args);
      } catch (e) {
        console.error('chat event listener failed', e);
      }
    }
  }

  clear(): void {
    this.listeners.clear();
  }
}

/**
 * One handler per socket event type and input, fanned out to the stores. The
 * stores are idempotent against duplicated, late and reordered events.
 */
export function createChatEventSource(inputs: ChatEventInputs): DisposableChatEventSource {
  const message = new Fanout<[Events.Message.Message]>();
  const lastRead = new Fanout<[Events.Channel.LastRead]>();
  const notification = new Fanout<[Events.Notification.Notification]>();
  const live = new Fanout<[LiveKind]>();
  const resume = new Fanout<[ResumeReason]>();
  const visibility = new Fanout<[boolean]>();
  const user = new Fanout<[string | undefined]>();

  const onMessage = (event: ClientEventOf<'cliMessageEvent'>) => message.emit(event);
  const onLastRead = (event: ClientEventOf<'cliChannelLastRead'>) => lastRead.emit(event);
  const onNotification = (event: ClientEventOf<'cliNotificationEvent'>) => notification.emit(event);
  inputs.clientEvents.register('cliMessageEvent', onMessage);
  inputs.clientEvents.register('cliChannelLastRead', onLastRead);
  inputs.clientEvents.register('cliNotificationEvent', onNotification);

  let visible = inputs.visibility.visible;
  let userId = inputs.user.userId;
  const unsubs: Unsubscribe[] = [
    inputs.transport.onLive(kind => live.emit(kind)),
    inputs.transport.onResume(reason => resume.emit(reason)),
    inputs.visibility.onChange(v => {
      if (v === visible) return;
      visible = v;
      visibility.emit(v);
    }),
    inputs.user.onChange(u => {
      if (u === userId) return;
      userId = u;
      user.emit(u);
    }),
  ];
  let disposed = false;

  return {
    onMessageEvent: l => message.add(l),
    onLastReadEvent: l => lastRead.add(l),
    onNotificationEvent: l => notification.add(l),
    onLive: l => live.add(l),
    onResume: l => resume.add(l),
    get live() {
      return inputs.transport.live;
    },
    get visible() {
      return visible;
    },
    onVisibilityChange: l => visibility.add(l),
    get userId() {
      return userId;
    },
    onUserChange: l => user.add(l),
    dispose() {
      if (disposed) return;
      disposed = true;
      inputs.clientEvents.unregister('cliMessageEvent', onMessage);
      inputs.clientEvents.unregister('cliChannelLastRead', onLastRead);
      inputs.clientEvents.unregister('cliNotificationEvent', onNotification);
      for (const u of unsubs) u();
      for (const f of [message, lastRead, notification, live, resume, visibility, user]) f.clear();
    },
  };
}

/**
 * The tab's user for the stores: the account login.ts set (façade `userId`
 * setter), but only while the login state is `loggedin` (undefined while
 * anonymous, logging in or out).
 */
export function createLoginUser(login: {
  readonly loginState: Common.LoginState;
  onLoginStateChange(listener: (state: Common.LoginState) => void): Unsubscribe;
}) {
  let account: string | undefined;
  const listeners = new Fanout<[string | undefined]>();
  const current = () => (login.loginState === 'loggedin' ? account : undefined);
  let last = current();
  const update = () => {
    const next = current();
    if (next === last) return;
    last = next;
    listeners.emit(next);
  };
  const unsub = login.onLoginStateChange(update);
  return {
    get userId() {
      return current();
    },
    onChange: (l: (userId: string | undefined) => void) => listeners.add(l),
    /** the account of this tab (login.ts); `undefined` after logout */
    setAccount(userId: string | undefined) {
      account = userId;
      update();
    },
    get account() {
      return account;
    },
    dispose() {
      unsub();
      listeners.clear();
    },
  };
}

// ---------------------------------------------------------------------------
// Runtime
// ---------------------------------------------------------------------------

export type ChatRuntimeDeps = {
  chatApi: ChatApi;
  notificationApi: NotificationApi;
  events: ChatEventSource;
  clock?: ChatClock;
  newId?: () => string;
  /** shared read-state persistence (entityReadStatePersistence in the app) */
  persistence?: ReadStatePersistence;
  /**
   * DMs: a received or own message also becomes the chat row's
   * `lastMessage`; this writer applies the message's read-state input with
   * it (chatDatabase.newMessageReceived), so `persistence` skips message
   * inputs of DMs (one write per input).
   */
  dmMessage?(channelId: string, message: Models.Message.Message, own: boolean): Promise<void>;
};

export type ChatRuntimeImpl = ChatRuntime & {
  /**
   * Read state already written to the shared persistence by its owner (the
   * merged community/chat rows after a snapshot): merged into memory only,
   * as a snapshot without syncSeq, so a snapshot is applied to the rows once.
   */
  applyStoredReadState(states: ChannelReadState[]): void;
  /** login: the login response's notification count */
  setupAfterLogin(unreadNotificationCount: number | string): void;
  /** logout: clear all three stores, then re-init the channel windows that were initialised */
  clear(): void;
  dispose(): void;
};

/** community channel or DM: the channels that have read state (no article comments, no call chats) */
export function hasReadState(access: API.Messages.MessageAccess | undefined): boolean {
  return !!access && ('communityId' in access || 'chatId' in access) && !('callId' in access) && !('articleId' in access);
}

function isDm(access: API.Messages.MessageAccess | undefined): boolean {
  return !!access && 'chatId' in access;
}

function messageFromApi(m: Models.Message.ApiMessage): Models.Message.Message {
  return { ...m, createdAt: new Date(m.createdAt), updatedAt: new Date(m.updatedAt) };
}

const noop = () => undefined;

/**
 * Tracks the windows the UI opened, so a logout can re-init them (the
 * store's `clear` leaves them with an empty reset and supersedes their init).
 */
function trackWindows(store: ChannelStore) {
  const initialised = new Set<ChannelWindow>();
  const tracked: ChannelStore = {
    registerAccessForChannel: access => store.registerAccessForChannel(access),
    getAccessForChannel: channelId => store.getAccessForChannel(channelId),
    openWindow: channelId => {
      const w = store.openWindow(channelId);
      const init = w.init.bind(w);
      const destroy = w.destroy.bind(w);
      w.init = options => {
        initialised.add(w);
        return init(options);
      };
      w.destroy = () => {
        initialised.delete(w);
        destroy();
      };
      return w;
    },
    watchMessage: (channelId, messageId, onChange) => store.watchMessage(channelId, messageId, onChange),
    createMessage: (message, options) => store.createMessage(message, options),
    retrySend: (channelId, messageId) => store.retrySend(channelId, messageId),
    discardPending: (channelId, messageId) => store.discardPending(channelId, messageId),
    editMessage: (message, update) => store.editMessage(message, update),
    deleteMessage: (channelId, messageId, creatorId) => store.deleteMessage(channelId, messageId, creatorId),
    setReaction: (channelId, messageId, reaction) => store.setReaction(channelId, messageId, reaction),
    unsetReaction: (channelId, messageId) => store.unsetReaction(channelId, messageId),
    forgetChannel: channelId => store.forgetChannel(channelId),
    clear: () => store.clear(),
    dispose: () => store.dispose(),
  };
  return {
    store: tracked,
    reinit() {
      for (const w of [...initialised]) {
        if (w.state.isDestroyed) {
          initialised.delete(w);
          continue;
        }
        w.init({ type: 'recent' }).catch(noop);
      }
    },
  };
}

export function createChatRuntime(deps: ChatRuntimeDeps): ChatRuntimeImpl {
  const clock = deps.clock ?? systemClock;
  const { events } = deps;
  // the closures below run only after construction (events, sends)
  const accessOf = (channelId: string) => rawChannels.getAccessForChannel(channelId);

  /** inputs whose persistence write is done by someone else */
  const persisted = new WeakSet<ReadStateInput>();
  const persistence: ReadStatePersistence | undefined = deps.persistence && {
    apply: input => {
      if (persisted.has(input)) return Promise.resolve();
      if (deps.dmMessage && input.kind === 'message' && isDm(accessOf(input.channelId))) return Promise.resolve();
      return deps.persistence!.apply(input);
    },
  };

  const writeDm = (channelId: string, message: Models.Message.Message, own: boolean) => {
    deps.dmMessage?.(channelId, message, own).catch(e => console.error('Error applying a message to the chat row', e));
  };

  const rawChannels = createChannelStore({
    api: deps.chatApi,
    events,
    clock,
    newId: deps.newId ?? (() => crypto.randomUUID()),
    onOwnMessage: m => {
      const access = accessOf(m.channelId);
      if (!hasReadState(access)) return;
      const input: ReadStateInput = {
        kind: 'message',
        channelId: m.channelId,
        messageId: m.id,
        createdAt: m.createdAt.toISOString(),
        own: true,
      };
      if (typeof m.syncSeq === 'number') input.syncSeq = m.syncSeq;
      readState.apply(input);
      if (isDm(access)) writeDm(m.channelId, m, true);
    },
  });
  const windows = trackWindows(rawChannels);

  const readState: ReadStateStore = createReadStateStore({
    api: deps.chatApi,
    events,
    clock,
    getAccess: accessOf,
    persistence,
  });
  const notifications = createNotificationStore({ api: deps.notificationApi, events, clock });

  // DM rows: lastMessage (+ the read-state input) of messages of others and of own other tabs/devices
  const unsubDm = deps.dmMessage
    ? events.onMessageEvent(event => {
      if (event.action !== 'new') return;
      const access = accessOf(event.data.channelId);
      if (!isDm(access)) return;
      writeDm(event.data.channelId, messageFromApi(event.data), event.data.creatorId === events.userId);
    })
    : noop;

  const runtime: ChatRuntimeImpl = {
    channels: windows.store,
    readState,
    notifications,
    events,
    applyStoredReadState(states) {
      for (const s of states) {
        const input: ReadStateInput = {
          kind: 'snapshot',
          channelId: s.channelId,
          lastRead: s.lastRead,
          unread: s.unread,
          lastMessageDate: s.lastMessageDate,
        };
        persisted.add(input);
        readState.apply(input);
      }
    },
    setupAfterLogin(count) {
      notifications.setupAfterLogin(count);
    },
    clear() {
      rawChannels.clear();
      readState.clear();
      notifications.clear();
      windows.reinit();
    },
    dispose() {
      unsubDm();
      rawChannels.dispose();
      readState.dispose();
      notifications.dispose();
    },
  };
  return runtime;
}

// ---------------------------------------------------------------------------
// The app's runtime (lazy singleton)
// ---------------------------------------------------------------------------

let loginUser: ReturnType<typeof createLoginUser> | undefined;
let appRuntime: ChatRuntimeImpl | undefined;

function getLoginUser() {
  if (!loginUser) {
    loginUser = createLoginUser({
      get loginState() {
        return connectionManager.loginState;
      },
      onLoginStateChange(listener) {
        connectionManager.addListener('loginStateChange', listener);
        return () => connectionManager.removeListener('loginStateChange', listener);
      },
    });
  }
  return loginUser;
}

function createAppRuntime(): ChatRuntimeImpl {
  const user = getLoginUser();
  const events = createChatEventSource({
    clientEvents: {
      // the generic signature does not narrow over a union of event types
      register: (type, fn) => connectionManager.registerClientEventHandler<ClientEventType>(type, fn as never),
      unregister: (type, fn) => connectionManager.unregisterClientEventHandler<ClientEventType>(type, fn as never),
    },
    transport: webSocketManager,
    visibility: {
      get visible() {
        return connectionManager.visibilityState === 'visible';
      },
      onChange(listener) {
        const fn = (state: Common.VisibilityState) => listener(state === 'visible');
        connectionManager.addListener('visibilityStateChange', fn);
        return () => connectionManager.removeListener('visibilityStateChange', fn);
      },
    },
    user,
  });
  return createChatRuntime({
    chatApi: messageApi,
    notificationApi: notificationsApi,
    events,
    // loaded on use: the entity databases import the façade, which imports this module
    persistence: {
      apply: input => import('data/databases/readStatePersistence').then(m => m.default.apply(input)),
    },
    dmMessage: (channelId, message, own) =>
      import('data/databases/chats').then(m => m.default.newMessageReceived(channelId, message, own)),
  });
}

function runtime(): ChatRuntimeImpl {
  if (!appRuntime) appRuntime = createAppRuntime();
  return appRuntime;
}

/** The tab's chat stores (created on first use). */
export const chat: ChatRuntime = Object.freeze({
  get channels() {
    return runtime().channels;
  },
  get readState() {
    return runtime().readState;
  },
  get notifications() {
    return runtime().notifications;
  },
  get events() {
    return runtime().events;
  },
});

/** login.ts (via the façade's `userId`): the account of this tab, `undefined` after logout */
export function setChatAccountUser(userId: string | undefined): void {
  getLoginUser().setAccount(userId);
}

/** the account login.ts set last (façade `userId` getter) */
export function getChatAccountUser(): string | undefined {
  return loginUser?.account;
}

/** login.ts: after a login (also one adopted from another tab), with the server's notification count */
export function setupChatAfterLogin(unreadNotificationCount: number | string): void {
  runtime().setupAfterLogin(unreadNotificationCount);
}

/** login.ts: on every logout of this tab (own, another tab's, signed out elsewhere) */
export function clearChat(): void {
  // nothing to clear before the first use
  appRuntime?.clear();
}

/** entity databases (via the façade): merged read state of community channels / DMs, memory only */
export function applyStoredReadState(states: ChannelReadState[]): void {
  if (states.length > 0) runtime().applyStoredReadState(states);
}
