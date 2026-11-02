// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * A scripted fake chat-sync server for the store-core unit tests. It
 * implements ChatApi, NotificationApi and ChatEventSource in memory:
 *
 * - per-channel commit sequence (`syncSeq` on every write, deletes included),
 *   soft deletes, idempotent create on the client UUID, getChanges with
 *   reset / hasMore / too-old cursors, getSyncState, read state, notifications
 *   with `unreadCount`/`unreadCountAt`;
 * - writes by "other users" (`post`, `edit`, `react`, `remove`) return the
 *   event they would emit; it is delivered at once unless `{ deliver: false }`
 *   — then the test delivers it later (`deliver`), in any order, duplicated;
 * - `hold(method)` keeps the next responses of a method back (computed at
 *   call time, like a real server) until `release`; `fail(method, error)`
 *   makes calls reject; `latency` delays every response by fake-timer ms;
 * - `oldServer` mode: no getChanges/getSyncState (HTTP 404), no syncSeq, no
 *   unreadCount in events, `messageId` rejected by validation, void
 *   setChannelLastRead, string counts.
 *
 * Time: `Date.now()` (use `useDataLayerFakeTimers()`), strictly increasing
 * per server so `UNIQUE(channelId, createdAt)` holds.
 */

import type { ChatApi, ChatEventSource, NotificationApi, Unsubscribe } from '../types';
import type { LiveKind, ResumeReason } from 'data/appstate/transport';

type ApiMessage = Models.Message.ApiMessage & { syncSeq: number };

type ServerRow = { msg: ApiMessage; deleted: boolean };

type ServerChannel = {
  channelId: string;
  communityId?: string;
  chatId?: string;
  seq: number;
  rows: Map<string, ServerRow>;
  lastRead: Map<string, string>;
};

type Method = keyof ChatApi | keyof NotificationApi;

type Hold = { release: () => void; promise: Promise<void> };

export type Call = { method: Method; data: unknown };

export const OTHER_USER = 'user-other';
export const ME = 'user-me';
export const RESET_TOO_OLD = 500;
const PAGE = 30;

function body(text: string): Models.Message.Body {
  return { version: '1', content: [{ type: 'text', value: text }] } as Models.Message.Body;
}

/** text of a message body (tests) */
export function textOf(m: { body: Models.Message.Body }): string {
  return m.body.content.map(c => ('value' in c ? String((c as { value: unknown }).value) : '')).join('');
}

export { body as textBody };

export class FakeChatServer implements ChatApi, NotificationApi, ChatEventSource {
  readonly channels = new Map<string, ServerChannel>();
  readonly notifications = new Map<string, Models.Notification.ApiNotification>();
  readonly calls: Call[] = [];
  /** answer like a server before chat-sync */
  oldServer = false;
  /** fake-timer delay of every response, ms */
  latency = 0;
  /** deliver the server events of own writes (create/edit) to this tab too (default: excluded like the sending socket) */
  echoOwn = false;
  private lastTime = 0;
  private idCounter = 0;
  private holds = new Map<Method, Hold[]>();
  private holdNext = new Map<Method, number>();
  private failures = new Map<Method, { error: unknown; times: number }>();

  // ----- event source state -------------------------------------------------
  live = true;
  visible = true;
  userId: string | undefined = ME;
  private messageListeners = new Set<(e: Events.Message.Message) => void>();
  private lastReadListeners = new Set<(e: Events.Channel.LastRead) => void>();
  private notificationListeners = new Set<(e: Events.Notification.Notification) => void>();
  private liveListeners = new Set<(k: LiveKind) => void>();
  private resumeListeners = new Set<(r: ResumeReason) => void>();
  private visibilityListeners = new Set<(v: boolean) => void>();
  private userListeners = new Set<(u: string | undefined) => void>();

  // ----- time / ids -----------------------------------------------------------

  now(): string {
    const t = Math.max(Date.now(), this.lastTime + 1);
    this.lastTime = t;
    return new Date(t).toISOString();
  }

  newId(prefix = 'm'): string {
    this.idCounter++;
    return `${prefix}-${String(this.idCounter).padStart(4, '0')}`;
  }

  // ----- scripting: channels and messages -----------------------------------

  addChannel(channelId: string, owner: { communityId: string } | { chatId: string } | Record<string, never> = { communityId: 'community-1' }): API.Messages.MessageAccess {
    if (!this.channels.has(channelId)) {
      this.channels.set(channelId, { channelId, ...owner, seq: 0, rows: new Map(), lastRead: new Map() });
    }
    if ('chatId' in owner) return { channelId, chatId: owner.chatId };
    return { channelId, communityId: 'communityId' in owner ? owner.communityId : 'community-1' };
  }

  private channel(channelId: string): ServerChannel {
    const ch = this.channels.get(channelId);
    if (!ch) throw new Error('NOT_FOUND');
    return ch;
  }

  private bumpSeq(ch: ServerChannel): number {
    ch.seq += 1;
    return ch.seq;
  }

  /** a seq bump without an event (another kind of write to the channel) */
  bump(channelId: string): number {
    return this.bumpSeq(this.channel(channelId));
  }

  private toWire(msg: ApiMessage): Models.Message.ApiMessage {
    const copy: Models.Message.ApiMessage = structuredClone(msg);
    if (this.oldServer) delete copy.syncSeq;
    return copy;
  }

  rows(channelId: string): ApiMessage[] {
    return [...this.channel(channelId).rows.values()].filter(r => !r.deleted).map(r => r.msg).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }

  row(channelId: string, id: string): ApiMessage | undefined {
    return this.channel(channelId).rows.get(id)?.msg;
  }

  private insert(ch: ServerChannel, data: { id?: string; creatorId: string; text?: string; body?: Models.Message.Body; parentMessageId?: string | null; attachments?: Models.Message.Attachment[]; createdAt?: string }): ApiMessage {
    const createdAt = data.createdAt ?? this.now();
    const msg: ApiMessage = {
      id: data.id ?? this.newId(),
      creatorId: data.creatorId,
      channelId: ch.channelId,
      body: data.body ?? body(data.text ?? 'hello'),
      attachments: data.attachments ?? [],
      editedAt: null,
      createdAt,
      updatedAt: createdAt,
      reactions: {},
      ownReaction: null,
      parentMessageId: data.parentMessageId ?? null,
      syncSeq: this.bumpSeq(ch),
    };
    ch.rows.set(msg.id, { msg, deleted: false });
    return msg;
  }

  /** seed history without events (createdAt from the server clock) */
  seed(channelId: string, count: number, creatorId = OTHER_USER): ApiMessage[] {
    const ch = this.channel(channelId);
    const out: ApiMessage[] = [];
    for (let i = 0; i < count; i++) out.push(this.insert(ch, { creatorId, text: `seed ${i}` }));
    return out;
  }

  private newEvent(msg: ApiMessage): Events.Message.Message {
    const data = { ...this.toWire(msg), creatorIsBot: false } as Extract<Events.Message.Message, { action: 'new' }>['data'];
    const ch = this.channels.get(msg.channelId);
    if (ch?.communityId) data.communityId = ch.communityId;
    return { type: 'cliMessageEvent', action: 'new', data };
  }

  /** another user posts; returns the `new` event */
  post(channelId: string, data: { id?: string; creatorId?: string; text?: string; createdAt?: string } = {}, opts: { deliver?: boolean } = {}): Events.Message.Message {
    const msg = this.insert(this.channel(channelId), { creatorId: OTHER_USER, ...data });
    const event = this.newEvent(msg);
    if (opts.deliver !== false) this.deliver(event);
    return event;
  }

  private update(channelId: string, id: string, change: (msg: ApiMessage) => Partial<ApiMessage>, opts: { deliver?: boolean } = {}): Extract<Events.Message.Message, { action: 'update' }> {
    const ch = this.channel(channelId);
    const row = ch.rows.get(id);
    if (!row || row.deleted) throw new Error('NOT_FOUND');
    const fields = change(row.msg);
    const updatedAt = this.now();
    row.msg = { ...row.msg, ...fields, updatedAt, syncSeq: this.bumpSeq(ch) };
    const data: Extract<Events.Message.Message, { action: 'update' }>['data'] = {
      id,
      channelId,
      updatedAt,
      ...(structuredClone(fields) as object),
    };
    if (!this.oldServer) data.syncSeq = row.msg.syncSeq;
    if (ch.communityId) data.communityId = ch.communityId;
    const event = { type: 'cliMessageEvent', action: 'update', data } as Extract<Events.Message.Message, { action: 'update' }>;
    if (opts.deliver !== false) this.deliver(event);
    return event;
  }

  /** another user edits; returns the `update` event */
  edit(channelId: string, id: string, text: string, opts: { deliver?: boolean } = {}) {
    return this.update(channelId, id, () => ({ body: body(text), editedAt: this.now() }), opts);
  }

  /** another user reacts; returns the `update` event (reactions only) */
  react(channelId: string, id: string, emoji: string, opts: { deliver?: boolean } = {}) {
    return this.update(channelId, id, msg => ({ reactions: { ...msg.reactions, [emoji]: (msg.reactions[emoji] ?? 0) + 1 } }), opts);
  }

  /** delete rows; returns the `delete` event */
  remove(channelId: string, ids: string[], opts: { deliver?: boolean } = {}): Events.Message.Message {
    const ch = this.channel(channelId);
    const seqs: number[] = [];
    for (const id of ids) {
      const row = ch.rows.get(id);
      if (!row || row.deleted) continue;
      row.deleted = true;
      row.msg = { ...row.msg, updatedAt: this.now(), syncSeq: this.bumpSeq(ch) };
      seqs.push(row.msg.syncSeq);
    }
    const data: Extract<Events.Message.Message, { action: 'delete' }>['data'] = { channelId, deletedIds: ids };
    if (!this.oldServer && seqs.length) {
      data.syncSeq = Math.max(...seqs);
      data.syncSeqs = seqs;
    }
    const event: Events.Message.Message = { type: 'cliMessageEvent', action: 'delete', data };
    if (opts.deliver !== false) this.deliver(event);
    return event;
  }

  // ----- scripting: calls ------------------------------------------------------

  /** hold the responses of the next `count` calls of `method` (computed at call time) */
  hold(method: Method, count = 1): void {
    this.holdNext.set(method, (this.holdNext.get(method) ?? 0) + count);
  }

  /** release held responses of `method` (all, or the oldest `count`) */
  release(method: Method, count = Infinity): void {
    const list = this.holds.get(method) ?? [];
    const now = list.splice(0, Math.min(count, list.length));
    for (const h of now) h.release();
  }

  heldCount(method: Method): number {
    return this.holds.get(method)?.length ?? 0;
  }

  /** the next `times` calls of `method` reject with `error` */
  fail(method: Method, error: unknown = new Error('Network down'), times = Infinity): void {
    this.failures.set(method, { error, times });
  }

  unfail(method: Method): void {
    this.failures.delete(method);
  }

  callsOf(method: Method): unknown[] {
    return this.calls.filter(c => c.method === method).map(c => c.data);
  }

  private async respond<T>(method: Method, data: unknown, compute: () => T): Promise<T> {
    this.calls.push({ method, data: structuredClone(data) });
    const failure = this.failures.get(method);
    let result: { ok: true; value: T } | { ok: false; error: unknown };
    if (failure && failure.times > 0) {
      failure.times--;
      if (failure.times <= 0) this.failures.delete(method);
      result = { ok: false, error: failure.error };
    } else {
      try {
        result = { ok: true, value: compute() };
      } catch (error) {
        result = { ok: false, error };
      }
    }
    const holdCount = this.holdNext.get(method) ?? 0;
    if (holdCount > 0) {
      this.holdNext.set(method, holdCount - 1);
      let release!: () => void;
      const promise = new Promise<void>(r => {
        release = r;
      });
      const list = this.holds.get(method) ?? [];
      list.push({ release, promise });
      this.holds.set(method, list);
      await promise;
    }
    if (this.latency > 0) await new Promise<void>(r => setTimeout(r, this.latency));
    else await Promise.resolve();
    if (!result.ok) throw result.error;
    return result.value;
  }

  private notFound404(): never {
    throw new Error('Unexpected status: 404');
  }

  // ----- ChatApi ---------------------------------------------------------------

  loadMessages(data: API.Messages.loadMessages.Request) {
    return this.respond('loadMessages', data, () => {
      const order = data.order ?? 'DESC';
      let rows = this.rows(data.access.channelId);
      if (data.createdAfter) rows = rows.filter(m => Date.parse(m.createdAt) > Date.parse(data.createdAfter!));
      if (data.createdBefore) rows = rows.filter(m => Date.parse(m.createdAt) < Date.parse(data.createdBefore!));
      if (order === 'DESC') rows = rows.reverse();
      return rows.slice(0, PAGE).map(m => this.toWire(m));
    });
  }

  messagesById(data: API.Messages.messagesById.Request) {
    return this.respond('messagesById', data, () => {
      const ch = this.channel(data.access.channelId);
      return data.messageIds.map(id => ch.rows.get(id)).filter((r): r is ServerRow => !!r && !r.deleted).map(r => this.toWire(r.msg));
    });
  }

  getChanges(data: API.Messages.getChanges.Request): Promise<API.Messages.getChanges.Response> {
    return this.respond('getChanges', data, () => {
      if (this.oldServer) this.notFound404();
      const ch = this.channel(data.access.channelId);
      const limit = Math.min(200, Math.max(1, data.limit ?? 200));
      const match = data.cursor ? /^1:(\d{1,18})$/.exec(data.cursor) : null;
      const cursorSeq = match ? Number(match[1]) : null;
      const serverTime = this.now();
      if (cursorSeq === null || cursorSeq > ch.seq || ch.seq - cursorSeq > RESET_TOO_OLD) {
        const page = this.rows(ch.channelId).reverse().slice(0, PAGE);
        return {
          cursor: `1:${ch.seq}` as API.Messages.SyncCursor,
          syncSeq: ch.seq,
          reset: true,
          hasMore: false,
          serverTime,
          messages: page.map(m => structuredClone(m)),
          deletedIds: [],
        };
      }
      const changed = [...ch.rows.values()].filter(r => r.msg.syncSeq > cursorSeq).sort((a, b) => a.msg.syncSeq - b.msg.syncSeq);
      const slice = changed.slice(0, limit);
      const hasMore = changed.length > limit;
      const syncSeq = hasMore ? slice[slice.length - 1].msg.syncSeq : ch.seq;
      return {
        cursor: `1:${syncSeq}` as API.Messages.SyncCursor,
        syncSeq,
        reset: false,
        hasMore,
        serverTime,
        messages: slice.filter(r => !r.deleted).map(r => structuredClone(r.msg)),
        deletedIds: slice.filter(r => r.deleted).map(r => r.msg.id),
      };
    });
  }

  private unreadFor(ch: ServerChannel, userId: string): number {
    const lastRead = ch.lastRead.get(userId);
    if (!lastRead && ch.communityId) return 0;
    const t = lastRead ? Date.parse(lastRead) : -Infinity;
    return Math.min(999, this.rows(ch.channelId).filter(m => m.creatorId !== userId && Date.parse(m.createdAt) > t).length);
  }

  getSyncState(data: API.Messages.getSyncState.Request): Promise<API.Messages.getSyncState.Response> {
    return this.respond('getSyncState', data, () => {
      if (this.oldServer) this.notFound404();
      const user = this.userId ?? '';
      const channels = [...this.channels.values()]
        .filter(ch => (ch.communityId || ch.chatId) && (!data.channelIds || data.channelIds.includes(ch.channelId)))
        .map(ch => {
          const rows = this.rows(ch.channelId);
          const state: API.Messages.getSyncState.ChannelState = {
            channelId: ch.channelId,
            syncSeq: ch.seq,
            lastMessageDate: rows.length ? rows[rows.length - 1].createdAt : null,
            lastRead: ch.lastRead.get(user) ?? null,
            unread: this.unreadFor(ch, user),
          };
          if (ch.communityId) state.communityId = ch.communityId;
          if (ch.chatId) state.chatId = ch.chatId;
          return state;
        });
      return { serverTime: this.now(), notificationUnreadCount: this.unreadNotificationCount(), channels };
    });
  }

  private create(data: API.Messages.createMessage.Request, method: 'createMessage' | 'createModerationMessage') {
    return this.respond(method, data, () => {
      const ch = this.channel(data.access.channelId);
      const user = this.userId ?? '';
      const existing = ch.rows.get(data.id);
      if (existing) {
        if (this.oldServer) throw new Error('DUPLICATE_KEY');
        if (existing.msg.creatorId !== user || existing.msg.channelId !== ch.channelId) throw new Error('NOT_ALLOWED');
        return this.toWire(existing.msg);
      }
      const msg = this.insert(ch, { id: data.id, creatorId: user, body: data.body, attachments: data.attachments, parentMessageId: data.parentMessageId });
      ch.lastRead.set(user, msg.createdAt);
      if (this.echoOwn) this.deliver(this.newEvent(msg));
      return this.toWire(msg);
    });
  }

  createMessage(data: API.Messages.createMessage.Request) {
    return this.create(data, 'createMessage');
  }

  createModerationMessage(data: API.Messages.createMessage.Request) {
    return this.create(data, 'createModerationMessage');
  }

  editMessage(data: API.Messages.editMessage.Request): Promise<API.Messages.editMessage.Response> {
    return this.respond('editMessage', data, () => {
      const editedAt = this.now();
      const event = this.update(data.access.channelId, data.id, () => {
        const fields: Partial<ApiMessage> = { editedAt };
        if (data.body) fields.body = data.body;
        if (data.attachments) fields.attachments = data.attachments;
        if (data.parentMessageId !== undefined) fields.parentMessageId = data.parentMessageId;
        return fields;
      }, { deliver: this.echoOwn });
      const row = this.row(data.access.channelId, data.id)!;
      const resp: API.Messages.editMessage.Response = { editedAt, attachments: row.attachments };
      if (!this.oldServer) {
        resp.updatedAt = event.data.updatedAt;
        resp.syncSeq = row.syncSeq;
      }
      return resp;
    });
  }

  deleteMessage(data: API.Messages.deleteMessage.Request): Promise<void> {
    return this.respond('deleteMessage', data, () => {
      this.remove(data.access.channelId, [data.messageId]);
    });
  }

  setReaction(data: API.Messages.setReaction.Request): Promise<void> {
    return this.respond('setReaction', data, () => {
      this.update(data.access.channelId, data.messageId, msg => ({ reactions: { ...msg.reactions, [data.reaction]: (msg.reactions[data.reaction] ?? 0) + 1 }, ownReaction: data.reaction }));
    });
  }

  unsetReaction(data: API.Messages.unsetReaction.Request): Promise<void> {
    return this.respond('unsetReaction', data, () => {
      this.update(data.access.channelId, data.messageId, msg => {
        const reactions = { ...msg.reactions };
        if (msg.ownReaction && reactions[msg.ownReaction]) reactions[msg.ownReaction]--;
        return { reactions, ownReaction: null };
      });
    });
  }

  setChannelLastRead(data: API.Messages.setChannelLastRead.Request): Promise<API.Messages.setChannelLastRead.Response> {
    return this.respond('setChannelLastRead', data, () => {
      if (this.oldServer && data.messageId !== undefined) throw new Error('VALIDATION');
      const user = this.userId;
      if (!user) throw new Error('LOGIN_REQUIRED');
      const ch = this.channel(data.access.channelId);
      let value = data.lastRead;
      const target = data.messageId ? ch.rows.get(data.messageId) : undefined;
      if (target) value = target.msg.createdAt;
      const now = this.now();
      if (Date.parse(value) > Date.parse(now)) value = now;
      const stored = ch.lastRead.get(user);
      if (!stored || Date.parse(value) > Date.parse(stored)) ch.lastRead.set(user, value);
      const lastRead = ch.lastRead.get(user)!;
      const unread = this.unreadFor(ch, user);
      const event: Events.Channel.LastRead = { type: 'cliChannelLastRead', channelId: ch.channelId, lastRead };
      if (!this.oldServer) {
        event.unread = unread;
        event.syncSeq = ch.seq;
        if (ch.communityId) event.communityId = ch.communityId;
        if (ch.chatId) event.chatId = ch.chatId;
      }
      this.deliverLastRead(event);
      if (this.oldServer) return undefined;
      return { lastRead, unread, syncSeq: ch.seq };
    });
  }

  /** the user read the channel on another device; returns the event */
  readElsewhere(channelId: string, lastRead: string, opts: { deliver?: boolean } = {}): Events.Channel.LastRead {
    const ch = this.channel(channelId);
    const user = this.userId ?? ME;
    const stored = ch.lastRead.get(user);
    if (!stored || Date.parse(lastRead) > Date.parse(stored)) ch.lastRead.set(user, lastRead);
    const event: Events.Channel.LastRead = { type: 'cliChannelLastRead', channelId, lastRead: ch.lastRead.get(user)! };
    if (!this.oldServer) {
      event.unread = this.unreadFor(ch, user);
      event.syncSeq = ch.seq;
    }
    if (opts.deliver !== false) this.deliverLastRead(event);
    return event;
  }

  // ----- notifications ---------------------------------------------------------

  unreadNotificationCount(): number {
    return [...this.notifications.values()].filter(n => !n.read).length;
  }

  private countFields(): { unreadCount?: number; unreadCountAt?: string } {
    if (this.oldServer) return {};
    return { unreadCount: this.unreadNotificationCount(), unreadCountAt: this.now() };
  }

  /** a new notification; returns its event */
  addNotification(data: Partial<Models.Notification.ApiNotification> = {}, opts: { deliver?: boolean } = {}): Events.Notification.Notification {
    const createdAt = this.now();
    const n: Models.Notification.ApiNotification = {
      type: 'Mention',
      id: this.newId('n'),
      text: 'you were mentioned',
      createdAt,
      updatedAt: createdAt,
      read: false,
      subjectItemId: null,
      subjectCommunityId: null,
      subjectUserId: null,
      subjectArticleId: null,
      extraData: null,
      ...data,
    };
    this.notifications.set(n.id, n);
    const event: Events.Notification.Notification = { type: 'cliNotificationEvent', action: 'new', data: structuredClone(n), ...this.countFields() };
    if (opts.deliver !== false) this.deliverNotification(event);
    return event;
  }

  /** delete notifications; returns the event */
  deleteNotifications(ids: string[], opts: { deliver?: boolean } = {}): Events.Notification.Notification {
    for (const id of ids) this.notifications.delete(id);
    const event: Events.Notification.Notification = { type: 'cliNotificationEvent', action: 'delete', id: ids.length === 1 ? ids[0] : ids, ...this.countFields() };
    if (opts.deliver !== false) this.deliverNotification(event);
    return event;
  }

  /** mark read on another device; returns the event (or undefined when nothing changed) */
  readNotificationElsewhere(id: string, opts: { deliver?: boolean } = {}): Events.Notification.Notification | undefined {
    const n = this.notifications.get(id);
    if (!n || n.read) return undefined;
    n.read = true;
    n.updatedAt = this.now();
    const event: Events.Notification.Notification = { type: 'cliNotificationEvent', action: 'update', data: { id, updatedAt: n.updatedAt, read: true }, ...this.countFields() };
    if (opts.deliver !== false) this.deliverNotification(event);
    return event;
  }

  loadNotifications(data: API.Notification.loadNotifications.Request) {
    return this.respond('loadNotifications', data, () => {
      let rows = [...this.notifications.values()].sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
      if (data.createdAfter) rows = rows.filter(n => Date.parse(n.createdAt) > Date.parse(data.createdAfter!));
      if (data.createdBefore) rows = rows.filter(n => Date.parse(n.createdAt) < Date.parse(data.createdBefore!));
      if (data.unreadOnly) rows = rows.filter(n => !n.read);
      if ((data.order ?? 'DESC') === 'DESC') rows = rows.reverse();
      return rows.slice(0, PAGE).map(n => structuredClone(n));
    });
  }

  getUnreadCount(data: API.Notification.getUnreadCount.Request): Promise<API.Notification.getUnreadCount.Response> {
    return this.respond('getUnreadCount', data, () => {
      const count = this.unreadNotificationCount();
      if (this.oldServer) return String(count) as unknown as number;
      if (data && data.withTime) return { unreadCount: count, unreadCountAt: this.now() };
      return count;
    });
  }

  markAsRead(data: API.Notification.markAsRead.Request): Promise<void> {
    return this.respond('markAsRead', data, () => {
      const n = this.notifications.get(data.notificationId);
      if (!n) throw new Error('NOT_FOUND');
      if (n.read && !this.oldServer) return;
      n.read = true;
      n.updatedAt = this.now();
      this.deliverNotification({ type: 'cliNotificationEvent', action: 'update', data: { id: n.id, updatedAt: n.updatedAt, read: true }, ...this.countFields() });
    });
  }

  markAllAsRead(data: API.Notification.markAllAsRead.Request): Promise<void> {
    return this.respond('markAllAsRead', data, () => {
      const unread = [...this.notifications.values()].filter(n => !n.read);
      if (unread.length === 0 && !this.oldServer) return;
      const updatedAt = this.now();
      for (const n of unread) {
        n.read = true;
        n.updatedAt = updatedAt;
      }
      this.deliverNotification({ type: 'cliNotificationEvent', action: 'allread', data: { updatedAt }, ...this.countFields() });
    });
  }

  // ----- ChatEventSource ----------------------------------------------------------

  onMessageEvent(listener: (event: Events.Message.Message) => void): Unsubscribe {
    this.messageListeners.add(listener);
    return () => this.messageListeners.delete(listener);
  }

  onLastReadEvent(listener: (event: Events.Channel.LastRead) => void): Unsubscribe {
    this.lastReadListeners.add(listener);
    return () => this.lastReadListeners.delete(listener);
  }

  onNotificationEvent(listener: (event: Events.Notification.Notification) => void): Unsubscribe {
    this.notificationListeners.add(listener);
    return () => this.notificationListeners.delete(listener);
  }

  onLive(listener: (kind: LiveKind) => void): Unsubscribe {
    this.liveListeners.add(listener);
    return () => this.liveListeners.delete(listener);
  }

  onResume(listener: (reason: ResumeReason) => void): Unsubscribe {
    this.resumeListeners.add(listener);
    return () => this.resumeListeners.delete(listener);
  }

  onVisibilityChange(listener: (visible: boolean) => void): Unsubscribe {
    this.visibilityListeners.add(listener);
    return () => this.visibilityListeners.delete(listener);
  }

  onUserChange(listener: (userId: string | undefined) => void): Unsubscribe {
    this.userListeners.add(listener);
    return () => this.userListeners.delete(listener);
  }

  /** deliver an event to the tab (again, late, out of order — whatever the test needs) */
  deliver(event: Events.Message.Message): void {
    if (!this.live) return;
    for (const l of [...this.messageListeners]) l(structuredClone(event));
  }

  deliverLastRead(event: Events.Channel.LastRead): void {
    if (!this.live) return;
    for (const l of [...this.lastReadListeners]) l(structuredClone(event));
  }

  deliverNotification(event: Events.Notification.Notification): void {
    if (!this.live) return;
    for (const l of [...this.notificationListeners]) l(structuredClone(event));
  }

  /** the socket dropped: events are lost until goLive */
  goOffline(): void {
    this.live = false;
  }

  goLive(kind: LiveKind = 'restored'): void {
    this.live = true;
    for (const l of [...this.liveListeners]) l(kind);
  }

  resume(reason: ResumeReason = 'visible'): void {
    for (const l of [...this.resumeListeners]) l(reason);
  }

  setVisible(visible: boolean): void {
    this.visible = visible;
    for (const l of [...this.visibilityListeners]) l(visible);
  }

  setUser(userId: string | undefined): void {
    this.userId = userId;
    for (const l of [...this.userListeners]) l(userId);
  }
}
