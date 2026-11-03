// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Read state of the channels and DMs of one tab, plus level-triggered read
 * marking (contract: ReadStateStore in ./types.ts). Every input goes through
 * mergeReadState, in memory and (optionally) through the shared persistence.
 */

import {
  COUNTED_SEQS_MAX,
  MARK_READ_THROTTLE_MS,
  type ChannelReadState,
  type ReadMarker,
  type ReadMarkingInput,
  type ReadStateInput,
  type ReadStateStore,
  type ReadStateStoreDeps,
  type Unsubscribe,
} from './types';
import { isoTime, mergeReadState, sameReadState, UNREAD_CAP } from './mergeReadState';
import { isHttpNotFound, isValidationError, Timer } from './util';

/** coalesces onLive/onResume bursts into one getSyncState */
export const SYNC_STATE_DEBOUNCE_MS = 50;
/** backoff of a failed setChannelLastRead (the last value repeats); reset on success or a new trigger */
export const MARK_READ_RETRY_MS = [2_000, 5_000, 15_000, 60_000] as const;

type Target = { id: string; createdAt: Date };

type MarkState = {
  /** what the level asked for and is not confirmed yet */
  want: Target | null;
  /** highest value the server accepted from this tab (ms) */
  sentMs: number;
  inFlight: boolean;
  lastCallAt: number | null;
  /** trailing throttle */
  timer: Timer;
  /** consecutive failures of the call */
  failures: number;
  retryTimer: Timer;
  /** a permanent error refused marks up to this (ms): not sent again until a newer mark */
  refusedMs: number;
};

/** errors a retry cannot fix (no access, unknown channel, request rejected even without messageId) */
function isPermanentMarkError(e: unknown): boolean {
  return e instanceof Error && (e.message === 'NOT_ALLOWED' || e.message === 'NOT_FOUND' || e.message === 'VALIDATION');
}

class MarkerImpl implements ReadMarker {
  input: ReadMarkingInput | null = null;
  disposed = false;

  constructor(private readonly store: ReadStateStoreImpl, readonly channelId: string) {}

  update(input: ReadMarkingInput): void {
    if (this.disposed) return;
    this.input = input;
    this.store.evaluate(this.channelId);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.store.removeMarker(this);
  }
}

const noop = () => undefined;

/** community channels and DMs have read state; call chats and article comments do not */
export function hasReadState(access: API.Messages.MessageAccess | undefined): boolean {
  return !!access && ('communityId' in access || 'chatId' in access) && !('callId' in access) && !('articleId' in access);
}

class ReadStateStoreImpl implements ReadStateStore {
  private readonly states = new Map<string, ChannelReadState>();
  /**
   * Server-acknowledged lastRead (ms): getSyncState snapshots, cliChannelLastRead
   * events, setChannelLastRead responses, own posts. Decides whether a mark is
   * sent; the merged state (incl. own marks and persisted local values) is for
   * display only, so a mark whose call never landed is sent again.
   */
  private readonly serverLastRead = new Map<string, number>();
  private readonly listeners = new Set<(state: ChannelReadState) => void>();
  private readonly markers = new Map<string, Set<MarkerImpl>>();
  private readonly marks = new Map<string, MarkState>();
  /** the server answered getSyncState in this page load */
  private serverSupportsSync = false;
  /** getSyncState answered 404 (old server) */
  private noSyncState = false;
  /** the server rejected `messageId` once: never send it again in this page load */
  private messageIdRejected = false;
  private syncing = false;
  private syncAgain = false;
  private readonly syncTimer: Timer;
  private readonly unsubs: Unsubscribe[] = [];
  private disposed = false;
  private generation = 0;

  constructor(private readonly deps: ReadStateStoreDeps) {
    this.syncTimer = new Timer(deps.clock);
    const { events } = deps;
    this.unsubs.push(
      events.onLastReadEvent(e => this.onLastReadEvent(e)),
      events.onMessageEvent(e => this.onMessageEvent(e)),
      events.onLive(() => this.scheduleSync()),
      events.onResume(() => this.scheduleSync()),
      events.onVisibilityChange(() => this.evaluateAll()),
      events.onUserChange(userId => {
        this.evaluateAll();
        // logged in on a live socket: catch up (debounced together with the
        // source's onLive('user')); while not live, the next onLive does it
        if (userId && this.deps.events.live) this.scheduleSync();
      }),
    );
  }

  get(channelId: string): ChannelReadState | undefined {
    return this.states.get(channelId);
  }

  subscribe(listener: (state: ChannelReadState) => void): Unsubscribe {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  apply(input: ReadStateInput): ChannelReadState {
    return this.applyInput(input, 'external');
  }

  applyStored(state: ChannelReadState): ChannelReadState {
    const before = this.states.get(state.channelId);
    const storedCounted = state.counted.filter(c => c > state.seq);
    let merged: ChannelReadState;
    if (state.seq > 0) {
      // the row's count without its counted seqs is the count valid at its seq
      const base = Math.max(0, state.unread - storedCounted.length);
      merged = mergeReadState(before, {
        kind: 'snapshot',
        channelId: state.channelId,
        lastRead: state.lastRead,
        unread: base,
        syncSeq: state.seq,
        lastMessageDate: state.lastMessageDate,
      });
      const taken = state.seq >= (before?.seq ?? 0) && isoTime(state.lastRead) >= isoTime(before?.lastRead ?? null);
      if (taken && merged.counted.length + storedCounted.length > 0) {
        const counted = [...new Set([...merged.counted, ...storedCounted])].sort((a, b) => a - b).slice(-COUNTED_SEQS_MAX);
        merged = { ...merged, counted, unread: Math.min(UNREAD_CAP, base + counted.length) };
        if (isoTime(merged.lastRead) >= isoTime(merged.lastMessageDate)) merged = { ...merged, unread: 0, counted: [] };
      }
    } else {
      merged = mergeReadState(before, {
        kind: 'snapshot',
        channelId: state.channelId,
        lastRead: state.lastRead,
        unread: state.unread,
        lastMessageDate: state.lastMessageDate,
      });
    }
    // memory only, and not acknowledged: the row may hold local marks
    if (!sameReadState(before, merged)) {
      this.states.set(state.channelId, merged);
      for (const l of [...this.listeners]) l(merged);
    }
    return merged;
  }

  /**
   * `ack`: from the server in this store (events, getSyncState, responses).
   * `external`: fed in by the façade; may come from local persistence, so it
   * counts as acknowledged only when it carries a syncSeq (or is an own post).
   * `own-mark`: this tab's mark, display only.
   */
  private applyInput(input: ReadStateInput, source: 'ack' | 'external' | 'own-mark'): ChannelReadState {
    const before = this.states.get(input.channelId);
    const merged = mergeReadState(before, input);
    // own posts are marked read by the server itself
    const serverValue = input.kind === 'message' ? (input.own ? input.createdAt : null) : input.lastRead;
    const acknowledged = source === 'ack'
      || (source === 'external' && (input.kind === 'message' || typeof input.syncSeq === 'number'));
    if (acknowledged && serverValue) {
      const t = isoTime(serverValue);
      if (t > (this.serverLastRead.get(input.channelId) ?? -Infinity)) this.serverLastRead.set(input.channelId, t);
    }
    if (!sameReadState(before, merged)) {
      this.states.set(input.channelId, merged);
      for (const l of [...this.listeners]) l(merged);
    }
    this.deps.persistence?.apply(input).catch(noop);
    return merged;
  }

  /** a channel with read state (community channel or DM) */
  private tracked(channelId: string, hint?: { communityId?: string; chatId?: string }): boolean {
    const access = this.deps.getAccess(channelId);
    // call chats and article comments have no read state (a call access may carry a communityId)
    if (access) return hasReadState(access);
    if (this.states.has(channelId)) return true;
    return !!hint && !!(hint.communityId || hint.chatId);
  }

  private onLastReadEvent(event: Events.Channel.LastRead): void {
    if (this.disposed || !this.tracked(event.channelId, event)) return;
    const input: ReadStateInput = { kind: 'lastRead', channelId: event.channelId, lastRead: event.lastRead };
    if (typeof event.unread === 'number') input.unread = event.unread;
    if (typeof event.syncSeq === 'number') input.syncSeq = event.syncSeq;
    this.applyInput(input, 'ack');
    this.evaluate(event.channelId);
  }

  private onMessageEvent(event: Events.Message.Message): void {
    if (this.disposed || event.action !== 'new') return;
    const data = event.data;
    if (!this.tracked(data.channelId, data)) return;
    const input: ReadStateInput = {
      kind: 'message',
      channelId: data.channelId,
      messageId: data.id,
      createdAt: data.createdAt,
      // by account: own posts of other tabs/devices may arrive before the login settled
      own: data.creatorId === (this.deps.events.accountId ?? this.deps.events.userId),
    };
    if (typeof data.syncSeq === 'number') input.syncSeq = data.syncSeq;
    this.applyInput(input, 'ack');
  }

  // ----- catch-up ----------------------------------------------------------

  private scheduleSync(): void {
    if (this.disposed) return;
    this.syncTimer.start(SYNC_STATE_DEBOUNCE_MS, () => {
      this.runSync().catch(noop);
    });
  }

  private async runSync(): Promise<void> {
    if (this.syncing) {
      this.syncAgain = true;
      return;
    }
    this.syncing = true;
    try {
      do {
        this.syncAgain = false;
        if (!this.noSyncState && this.deps.events.userId) {
          const generation = this.generation;
          try {
            const resp = await this.deps.api.getSyncState({});
            if (this.disposed) return;
            // cleared meanwhile (logout / user switch): drop this answer, run again if asked
            if (generation !== this.generation) continue;
            this.serverSupportsSync = true;
            for (const c of resp.channels) {
              this.applyInput({
                kind: 'snapshot',
                channelId: c.channelId,
                lastRead: c.lastRead,
                unread: c.unread,
                syncSeq: c.syncSeq,
                lastMessageDate: c.lastMessageDate,
              }, 'ack');
            }
          } catch (e) {
            if (isHttpNotFound(e)) this.noSyncState = true;
          }
        }
        // a live signal is a trigger for pending marks too
        for (const [channelId, m] of [...this.marks]) {
          this.resetBackoff(m);
          this.trySend(channelId);
        }
        this.evaluateAll();
      } while (this.syncAgain && !this.disposed);
    } finally {
      this.syncing = false;
    }
  }

  // ----- marking -----------------------------------------------------------

  createMarker(channelId: string): ReadMarker {
    const marker = new MarkerImpl(this, channelId);
    let set = this.markers.get(channelId);
    if (!set) {
      set = new Set();
      this.markers.set(channelId, set);
    }
    set.add(marker);
    return marker;
  }

  removeMarker(marker: MarkerImpl): void {
    const set = this.markers.get(marker.channelId);
    if (!set) return;
    set.delete(marker);
    if (set.size === 0) {
      this.markers.delete(marker.channelId);
      const m = this.marks.get(marker.channelId);
      // no backoff for a channel nobody shows; a pending mark still goes out on the next live signal
      m?.retryTimer.clear();
      this.dropIdleMark(marker.channelId);
    }
  }

  /** forget the mark state of a channel without markers and without anything to send */
  private dropIdleMark(channelId: string): void {
    const m = this.marks.get(channelId);
    if (!m || m.inFlight || m.want || this.markers.has(channelId)) return;
    m.timer.clear();
    m.retryTimer.clear();
    this.marks.delete(channelId);
  }

  private mark(channelId: string): MarkState {
    let m = this.marks.get(channelId);
    if (!m) {
      m = {
        want: null,
        sentMs: -Infinity,
        inFlight: false,
        lastCallAt: null,
        timer: new Timer(this.deps.clock),
        failures: 0,
        retryTimer: new Timer(this.deps.clock),
        refusedMs: -Infinity,
      };
      this.marks.set(channelId, m);
    }
    return m;
  }

  private evaluateAll(): void {
    if (this.disposed) return;
    for (const channelId of [...this.markers.keys()]) this.evaluate(channelId);
    for (const channelId of [...this.marks.keys()]) this.trySend(channelId);
  }

  /** the level: latest + bottom + newest (any marker) and visible; logged in to send */
  evaluate(channelId: string): void {
    if (this.disposed) return;
    const { events } = this.deps;
    if (!events.visible) return;
    let target: Target | null = null;
    for (const marker of this.markers.get(channelId) ?? []) {
      const input = marker.input;
      if (!input || !input.atLatest || !input.atBottom || !input.newest) continue;
      if (!target || input.newest.createdAt.getTime() > target.createdAt.getTime()) target = input.newest;
    }
    if (!target) return;
    const m = this.mark(channelId);
    const threshold = Math.max(this.serverLastRead.get(channelId) ?? -Infinity, m.sentMs, m.want ? m.want.createdAt.getTime() : -Infinity);
    if (target.createdAt.getTime() > threshold) {
      m.want = { id: target.id, createdAt: target.createdAt };
      this.resetBackoff(m);
      // show it as read at once (own mark); the server answer is merged later
      if (events.userId) this.applyInput({ kind: 'lastRead', channelId, lastRead: target.createdAt.toISOString() }, 'own-mark');
    }
    this.trySend(channelId);
  }

  private trySend(channelId: string): void {
    const m = this.marks.get(channelId);
    if (!m || this.disposed || m.inFlight || !m.want) return;
    if (!this.deps.events.userId) return;
    const wantMs = m.want.createdAt.getTime();
    if (wantMs <= m.refusedMs) return;
    if (wantMs <= Math.max(this.serverLastRead.get(channelId) ?? -Infinity, m.sentMs)) {
      m.want = null;
      return;
    }
    const now = this.deps.clock.now();
    if (m.lastCallAt !== null && now - m.lastCallAt < MARK_READ_THROTTLE_MS) {
      m.timer.ensure(MARK_READ_THROTTLE_MS - (now - m.lastCallAt), () => this.trySend(channelId));
      return;
    }
    const access = this.deps.getAccess(channelId);
    if (!access) return;
    m.timer.clear();
    m.lastCallAt = now;
    m.inFlight = true;
    const value = m.want;
    this.applyInput({ kind: 'lastRead', channelId, lastRead: value.createdAt.toISOString() }, 'own-mark');
    const generation = this.generation;
    this.send(access, value).then(
      resp => {
        if (generation !== this.generation || this.disposed) return;
        m.inFlight = false;
        this.resetBackoff(m);
        m.sentMs = Math.max(m.sentMs, value.createdAt.getTime());
        if (m.want && m.want.createdAt.getTime() <= m.sentMs) m.want = null;
        const input: ReadStateInput = resp
          ? { kind: 'lastRead', channelId, lastRead: resp.lastRead, unread: resp.unread }
          : { kind: 'lastRead', channelId, lastRead: value.createdAt.toISOString() };
        if (resp && typeof resp.syncSeq === 'number' && input.kind === 'lastRead') input.syncSeq = resp.syncSeq;
        this.applyInput(input, resp ? 'ack' : 'own-mark');
        this.trySend(channelId);
        this.dropIdleMark(channelId);
      },
      (e: unknown) => {
        if (generation !== this.generation || this.disposed) return;
        m.inFlight = false;
        if (isPermanentMarkError(e)) {
          // give up on this value; a newer mark tries again
          m.refusedMs = Math.max(m.refusedMs, value.createdAt.getTime());
          this.resetBackoff(m);
          return;
        }
        // stays pending: retried with backoff while the channel is shown, and on the
        // next login, live signal or trigger
        if (!this.markers.has(channelId)) return;
        const delay = MARK_READ_RETRY_MS[Math.min(m.failures, MARK_READ_RETRY_MS.length - 1)];
        m.failures++;
        m.retryTimer.start(delay, () => {
          if (this.markers.has(channelId)) this.trySend(channelId);
        });
      },
    );
  }

  private resetBackoff(m: MarkState): void {
    m.failures = 0;
    m.retryTimer.clear();
  }

  private async send(access: API.Messages.MessageAccess, value: Target): Promise<API.Messages.setChannelLastRead.Response> {
    const request: API.Messages.setChannelLastRead.Request = { access, lastRead: value.createdAt.toISOString() };
    if (this.serverSupportsSync && !this.messageIdRejected) request.messageId = value.id;
    try {
      return await this.deps.api.setChannelLastRead(request);
    } catch (e) {
      if (request.messageId !== undefined && isValidationError(e)) {
        this.messageIdRejected = true;
        delete request.messageId;
        return await this.deps.api.setChannelLastRead(request);
      }
      throw e;
    }
  }

  clear(): void {
    this.generation++;
    this.states.clear();
    this.serverLastRead.clear();
    for (const m of this.marks.values()) {
      m.timer.clear();
      m.retryTimer.clear();
    }
    this.marks.clear();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.generation++;
    for (const u of this.unsubs) u();
    this.unsubs.length = 0;
    this.syncTimer.clear();
    for (const m of this.marks.values()) {
      m.timer.clear();
      m.retryTimer.clear();
    }
    this.marks.clear();
    this.listeners.clear();
  }
}

/** ReadStateStore factory (contract: CreateReadStateStore) */
export function createReadStateStore(deps: ReadStateStoreDeps): ReadStateStore {
  return new ReadStateStoreImpl(deps);
}
