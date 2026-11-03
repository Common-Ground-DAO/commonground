// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Online presence of human users, as decided by one wsapi process.
 *
 * The status is one column per user (`users.onlineStatus`). A wsapi process
 * marks a user online when one of their sockets logs in, and offline only when
 * the user has had no logged-in socket anywhere in the cluster for
 * PRESENCE_OFFLINE_GRACE_MS after their last local socket went away
 * (disconnect or socket logout). A reconnect within the grace period cancels
 * the pending offline, so short disconnect/reconnect cycles (hidden tabs,
 * network blips, reloads) do not make the status flap.
 *
 * Decisions that come due within PRESENCE_DECISION_BATCH_MS of each other
 * share one cluster lookup and one offline write (a proxy reload drops many
 * sockets at once). A lookup that not every process answered is retried once
 * after PRESENCE_RETRY_DELAY_MS for the users it could not place; after that
 * they go offline.
 *
 * Safety net: the process refreshes `onlineStatusUpdatedAt` of every user it
 * tracks every 60 s (`touchSets()`: connected users get the full touch, users
 * in their grace period only the timestamp, never a flip back to online), and
 * the `onlineStatusCheck` job sets users offline whose status has not been
 * refreshed for 90 s (a crashed or killed process, a decision lost on
 * shutdown).
 *
 * The module has no socket.io or database dependency of its own; wsapi passes
 * the lookups and writes in, which keeps the decision logic unit-testable.
 */

/** how long a user without any socket keeps their online status */
export const PRESENCE_OFFLINE_GRACE_MS = 30_000;
/** decisions coming due within this window share one cluster lookup and write */
export const PRESENCE_DECISION_BATCH_MS = 500;
/** delay before the one retry of a decision whose cluster lookup was incomplete */
export const PRESENCE_RETRY_DELAY_MS = 10_000;

export type ClusterProbe = {
  /** users of the request with a logged-in socket on another process */
  present: string[];
  /** false if not every other process answered (timeout, error) */
  complete: boolean;
  error?: unknown;
};

export type PresenceDeps = {
  /** the user has a logged-in socket on this process (synchronous, local adapter state) */
  hasLocalSocket: (userId: string) => boolean;
  /** which of these users have a logged-in socket on another wsapi process; should not reject */
  probeCluster: (userIds: string[]) => Promise<ClusterProbe>;
  /** write `online` (only from `offline`) and refresh the touch timestamp; emits on a real change only */
  markOnline: (userId: string) => Promise<void>;
  /** write `offline` for these users in one go; emits on a real change only */
  markOffline: (userIds: string[]) => Promise<void>;
  /** while true, no offline is scheduled or written (shutdown leaves it to the stale job) */
  isShuttingDown?: () => boolean;
  graceMs?: number;
  batchMs?: number;
  retryMs?: number;
  logError?: (message: string, error: unknown) => void;
};

type Decision = {
  userId: string;
  /** login sequence of the user when the grace period started */
  seq: number;
  /** 0 = first decision, 1 = the retry after an incomplete lookup */
  attempt: number;
};

export class PresenceTracker {
  readonly #deps: PresenceDeps;
  readonly #graceMs: number;
  readonly #batchMs: number;
  readonly #retryMs: number;
  /** users this process keeps online and touches: logged-in sockets here, or in their grace period */
  readonly #tracked = new Set<string>();
  /** decisions waiting for their timer (grace period or retry) */
  readonly #pending = new Map<string, { timer: ReturnType<typeof setTimeout>; decision: Decision }>();
  /** decisions that came due and wait for the next batch */
  readonly #due = new Map<string, Decision>();
  #batchTimer: ReturnType<typeof setTimeout> | undefined;
  /**
   * sequence number of the latest local login per user, to notice a login that
   * happens while a decision waits for the cluster lookup or the write
   */
  readonly #loginSeq = new Map<string, number>();
  #seq = 0;

  constructor(deps: PresenceDeps) {
    this.#deps = deps;
    this.#graceMs = deps.graceMs ?? PRESENCE_OFFLINE_GRACE_MS;
    this.#batchMs = deps.batchMs ?? PRESENCE_DECISION_BATCH_MS;
    this.#retryMs = deps.retryMs ?? PRESENCE_RETRY_DELAY_MS;
  }

  /**
   * A socket of the user has been authenticated on this process (call before
   * it joins its rooms). Cancels a pending offline.
   */
  public socketAuthenticated(userId: string): void {
    const pending = this.#pending.get(userId);
    if (pending) {
      clearTimeout(pending.timer);
      this.#pending.delete(userId);
    }
    this.#due.delete(userId);
    this.#loginSeq.set(userId, ++this.#seq);
    this.#tracked.add(userId);
  }

  /** The login of a socket has completed: make sure the user is online. */
  public async userLoggedIn(userId: string): Promise<void> {
    await this.#deps.markOnline(userId);
  }

  /**
   * A logged-in socket of the user is gone from this process (disconnected,
   * or logged out and left its rooms). If it was the user's last local
   * socket, the grace period starts.
   */
  public socketGone(userId: string): void {
    if (this.#deps.isShuttingDown?.()) {
      return;
    }
    if (this.#deps.hasLocalSocket(userId) || this.#pending.has(userId) || this.#due.has(userId)) {
      return;
    }
    this.#schedule({ userId, seq: this.#loginSeq.get(userId) ?? 0, attempt: 0 }, this.#graceMs);
  }

  /**
   * Users whose online status this process keeps fresh (periodic touch):
   * `connected` have a logged-in socket here and get the full touch (which
   * may flip them back online); `grace` are tracked without a local socket
   * (grace period, retry, or a login in progress) and only get their
   * timestamp refreshed, so a decision by another process is not undone.
   */
  public touchSets(): { connected: string[]; grace: string[] } {
    const connected: string[] = [];
    const grace: string[] = [];
    for (const userId of this.#tracked) {
      (this.#deps.hasLocalSocket(userId) ? connected : grace).push(userId);
    }
    return { connected, grace };
  }

  /** a decision for the user is scheduled or due */
  public isPending(userId: string): boolean {
    return this.#pending.has(userId) || this.#due.has(userId);
  }

  /** Cancel every pending decision (shutdown: the stale job takes over). */
  public dispose(): void {
    for (const { timer } of this.#pending.values()) {
      clearTimeout(timer);
    }
    this.#pending.clear();
    this.#due.clear();
    if (this.#batchTimer !== undefined) {
      clearTimeout(this.#batchTimer);
      this.#batchTimer = undefined;
    }
  }

  #schedule(decision: Decision, delayMs: number): void {
    const timer = setTimeout(() => {
      this.#pending.delete(decision.userId);
      this.#due.set(decision.userId, decision);
      this.#batchTimer ??= setTimeout(() => {
        this.#batchTimer = undefined;
        const batch = Array.from(this.#due.values());
        this.#due.clear();
        this.#decide(batch).catch(error => {
          this.#logError("Error while deciding users' offline status", error);
        });
      }, this.#batchMs);
    }, delayMs);
    this.#pending.set(decision.userId, { timer, decision });
  }

  #loggedInAgain(decision: Decision): boolean {
    // every login sets a new number; a missing entry means no login since a
    // finished decision cleared it
    const current = this.#loginSeq.get(decision.userId);
    return current !== undefined && current !== decision.seq;
  }

  #keep(decision: Decision): boolean {
    return this.#loggedInAgain(decision)
      || this.#deps.hasLocalSocket(decision.userId)
      || !!this.#deps.isShuttingDown?.();
  }

  async #decide(batch: Decision[]): Promise<void> {
    const candidates = batch.filter(decision => !this.#keep(decision));
    if (candidates.length === 0) {
      return;
    }

    let probe: ClusterProbe;
    try {
      probe = await this.#deps.probeCluster(candidates.map(decision => decision.userId));
    }
    catch (error) {
      probe = { present: [], complete: false, error };
    }
    if (!probe.complete) {
      this.#logError("Cluster-wide presence lookup incomplete", probe.error);
    }

    const present = new Set(probe.present);
    const offline: Decision[] = [];
    for (const decision of candidates) {
      if (this.#keep(decision)) {
        continue;
      }
      if (present.has(decision.userId)) {
        // another process holds a socket and owns the user's presence now
        this.#tracked.delete(decision.userId);
        this.#loginSeq.delete(decision.userId);
        continue;
      }
      if (!probe.complete && decision.attempt === 0) {
        // stays tracked (and touched) until the retry
        if (!this.#pending.has(decision.userId) && !this.#due.has(decision.userId)) {
          this.#schedule({ ...decision, attempt: 1 }, this.#retryMs);
        }
        continue;
      }
      offline.push(decision);
    }
    if (offline.length === 0) {
      return;
    }

    for (const decision of offline) {
      this.#tracked.delete(decision.userId);
    }
    await this.#deps.markOffline(offline.map(decision => decision.userId));
    for (const decision of offline) {
      if (this.#loggedInAgain(decision)) {
        // a login on this process raced the offline write: restore
        await this.#deps.markOnline(decision.userId);
      }
      else {
        this.#loginSeq.delete(decision.userId);
      }
    }
  }

  #logError(message: string, error: unknown): void {
    (this.#deps.logError ?? ((m, e) => console.error(m, e)))(message, error);
  }
}
