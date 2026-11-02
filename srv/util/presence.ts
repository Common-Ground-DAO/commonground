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
 * Safety net, unchanged: the process touches `onlineStatusUpdatedAt` of every
 * user it tracks every 60 s (`onlineUserIds()` includes users in their grace
 * period), and the `onlineStatusCheck` job sets users offline whose status has
 * not been touched for 90 s (a crashed or killed process, a timer lost on
 * shutdown).
 *
 * The module has no socket.io or database dependency of its own; wsapi passes
 * the lookups and writes in, which keeps the decision logic unit-testable.
 */

/** how long a user without any socket keeps their online status */
export const PRESENCE_OFFLINE_GRACE_MS = 30_000;

export type PresenceDeps = {
  /** the user has a logged-in socket on this process (synchronous, local adapter state) */
  hasLocalSocket: (userId: string) => boolean;
  /**
   * the user has a logged-in socket on any wsapi process (cluster-wide; may
   * include this process). May reject, e.g. when another process does not
   * answer in time.
   */
  hasClusterSocket: (userId: string) => Promise<boolean>;
  /** write `online` (only from `offline`) and refresh the touch timestamp; emits on a real change only */
  markOnline: (userId: string) => Promise<void>;
  /** write `offline`; emits on a real change only */
  markOffline: (userId: string) => Promise<void>;
  /** while true, no offline is scheduled or written (shutdown leaves it to the stale job) */
  isShuttingDown?: () => boolean;
  graceMs?: number;
  logError?: (message: string, error: unknown) => void;
};

export class PresenceTracker {
  readonly #deps: PresenceDeps;
  readonly #graceMs: number;
  /** users this process keeps online and touches: logged-in sockets here, or in their grace period */
  readonly #tracked = new Set<string>();
  /** pending offline decisions */
  readonly #pending = new Map<string, ReturnType<typeof setTimeout>>();
  /**
   * sequence number of the latest local login per user, to notice a login that
   * happens while an offline decision is waiting for the cluster lookup or the
   * write
   */
  readonly #loginSeq = new Map<string, number>();
  #seq = 0;

  constructor(deps: PresenceDeps) {
    this.#deps = deps;
    this.#graceMs = deps.graceMs ?? PRESENCE_OFFLINE_GRACE_MS;
  }

  /**
   * A socket of the user has been authenticated on this process (call before
   * it joins its rooms). Cancels a pending offline.
   */
  public socketAuthenticated(userId: string): void {
    this.#cancelPending(userId);
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
    if (this.#deps.hasLocalSocket(userId) || this.#pending.has(userId)) {
      return;
    }
    const seq = this.#loginSeq.get(userId) ?? 0;
    const timer = setTimeout(() => {
      this.#pending.delete(userId);
      this.#decide(userId, seq).catch(error => {
        this.#logError("Error while deciding a user's offline status", error);
      });
    }, this.#graceMs);
    this.#pending.set(userId, timer);
  }

  /** users whose online status this process keeps fresh (for the periodic touch) */
  public onlineUserIds(): string[] {
    return Array.from(this.#tracked);
  }

  public isPending(userId: string): boolean {
    return this.#pending.has(userId);
  }

  /** Cancel every pending decision (shutdown: the stale job takes over). */
  public dispose(): void {
    for (const timer of this.#pending.values()) {
      clearTimeout(timer);
    }
    this.#pending.clear();
  }

  async #decide(userId: string, seq: number): Promise<void> {
    const loggedInAgain = () => (this.#loginSeq.get(userId) ?? 0) !== seq;
    const keep = () => loggedInAgain() || this.#deps.hasLocalSocket(userId) || !!this.#deps.isShuttingDown?.();
    if (keep()) {
      return;
    }

    let elsewhere = false;
    try {
      elsewhere = await this.#deps.hasClusterSocket(userId);
    }
    catch (error) {
      // An unanswered lookup is treated as "no socket elsewhere": if another
      // process does hold one, its periodic touch flips the user back online.
      this.#logError("Cluster-wide socket lookup failed, deciding on local state", error);
    }
    if (keep()) {
      return;
    }

    // From here on another process (if any) owns the user's presence.
    this.#tracked.delete(userId);
    if (!elsewhere) {
      await this.#deps.markOffline(userId);
      if (loggedInAgain()) {
        // a login on this process raced the offline write: restore
        await this.#deps.markOnline(userId);
      }
    }
    if (!loggedInAgain()) {
      this.#loginSeq.delete(userId);
    }
  }

  #cancelPending(userId: string): void {
    const timer = this.#pending.get(userId);
    if (timer !== undefined) {
      clearTimeout(timer);
      this.#pending.delete(userId);
    }
  }

  #logError(message: string, error: unknown): void {
    (this.#deps.logError ?? ((m, e) => console.error(m, e)))(message, error);
  }
}
