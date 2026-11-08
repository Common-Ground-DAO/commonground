// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { instanceKeyPrefix } from './gateway';

/**
 * Session generations (docs/auth-identity §2, "Signing out other devices").
 *
 * The authority is PostgreSQL: one sequence `session_generation_seq`,
 * `users."sessionGeneration"`, and the generation every device key and
 * transfer link was created with (srv/repositories/users.ts, device.ts,
 * transferTokens.ts). A login takes the next sequence value before it checks
 * any credential; signing out the other devices raises the user's generation
 * in the same transaction as the change that caused it; keys and links below
 * the user's generation no longer sign in — checked in the same SQL statement
 * that looks them up.
 *
 * Sessions live in Valkey, so their check uses a copy of each user's
 * generation there (`sess-gen:<userId>`), read with the session at load. A
 * copy is written right after each sign-out, and the reconciler
 * (GenerationReconciler) copies every generation committed since its last
 * run, at api start (until Valkey answers) and every RECONCILE_INTERVAL_MS
 * afterwards — so a copy that failed, or one lost with a Valkey restored from
 * an older snapshot, arrives within one interval. Copies are never lowered.
 * `sess-keep:<userId>` names the session that signed the others out (written
 * together with the copy, only by a newer generation): a request of that
 * session that still carries the older generation is stamped with the new
 * one instead of being ended.
 */

export type SessionGenerations = {
  /** the user's generation as copied to Valkey, and the session that signed the others out (one round) */
  read(userId: string): Promise<{ gen: number; keepSid: string | null }>;
  /** copies a committed generation to Valkey (never lowers it; names the kept session only with a newer one) */
  publish(userId: string, gen: number, keepSid?: string): Promise<void>;
  /** up to which sequence value Valkey holds every copy (0: unknown — e.g. its data was lost) */
  copiedUpTo(): Promise<number>;
  /** records that every copy up to `upTo` is in Valkey (never lowered) */
  markCopied(upTo: number): Promise<void>;
};

/** how long the name of the session that signed the others out is kept */
export const KEEP_SESSION_TTL_MS = 13 * 60 * 60 * 1000;


// SET the generation (and the kept session) only if it is greater than the
// stored one
const SET_IF_GREATER = `
local current = tonumber(redis.call('GET', KEYS[1]) or '0')
if tonumber(ARGV[1]) > current then
  redis.call('SET', KEYS[1], ARGV[1])
  if ARGV[2] ~= '' then
    redis.call('SET', KEYS[2], ARGV[2], 'PX', ARGV[3])
  end
  return 1
end
return 0
`;

type GenerationClient = {
  mGet(keys: string[]): Promise<(string | null)[]>;
  eval(script: string, options: { keys: string[]; arguments: string[] }): Promise<unknown>;
};

/** the copies on the sessions' Valkey instance */
/**
 * The copies on the sessions' Valkey instance: `sess-gen:<userId>`,
 * `sess-keep:<userId>` and `sess-gen-copied`, with the instance's key prefix
 * (`gateway:` on a gateway, which keeps its own copies with its own
 * reconciler)
 */
export function redisSessionGenerations(client: GenerationClient, prefix: string = instanceKeyPrefix()): SessionGenerations {
  const genKey = (userId: string) => `${prefix}sess-gen:${userId}`;
  const keepKey = (userId: string) => `${prefix}sess-keep:${userId}`;
  const COPIED_KEY = `${prefix}sess-gen-copied`;
  return {
    read: async (userId) => {
      const [gen, keepSid] = await client.mGet([genKey(userId), keepKey(userId)]);
      return { gen: Number(gen ?? 0), keepSid };
    },
    publish: async (userId, gen, keepSid) => {
      await client.eval(SET_IF_GREATER, {
        keys: [genKey(userId), keepKey(userId)],
        arguments: [String(gen), keepSid ?? '', String(KEEP_SESSION_TTL_MS)],
      });
    },
    copiedUpTo: async () => {
      const [value] = await client.mGet([COPIED_KEY]);
      return Number(value ?? 0);
    },
    markCopied: async (upTo) => {
      await client.eval(SET_IF_GREATER, { keys: [COPIED_KEY, keepKey('')], arguments: [String(upTo), '', '0'] });
    },
  };
}

/**
 * Copies a committed generation to Valkey, retrying a few times. Returns
 * false if it did not arrive: the reconciler copies it within one interval.
 */
export async function publishGeneration(generations: SessionGenerations, userId: string, gen: number, keepSid?: string, attempts = 3): Promise<boolean> {
  for (let attempt = 1; ; attempt++) {
    try {
      await generations.publish(userId, gen, keepSid);
      return true;
    }
    catch (e) {
      if (attempt >= attempts) {
        console.error("Error copying a session generation to Valkey", e instanceof Error ? e.message : e);
        return false;
      }
      await new Promise(resolve => setTimeout(resolve, 100 * attempt));
    }
  }
}

/** how often the reconciler copies the generations committed since its last run */
export const RECONCILE_INTERVAL_MS = 30 * 1000;
/** the retry interval while the first run has not succeeded (Valkey still loading, PostgreSQL not up) */
export const RECONCILE_RETRY_MS = 2 * 1000;

type ChangedSince = (after: number) => Promise<{ upTo: number; rows: { userId: string; gen: number }[] }>;

/**
 * Copies to Valkey every generation committed since its last successful run
 * (users.sessionGenerationsSince: the sequence is monotonic, so it only asks
 * for values above the last complete one). Valkey records up to which value
 * it holds every copy (`sess-gen-copied`, written after the copies): if that
 * is behind — its data was lost or restored from an older snapshot — the run
 * starts from there. Until its first run succeeded,
 * `ready` is false and logged-in sessions are not trusted (the guard fails
 * their requests): after a Valkey restored from an older snapshot, no session
 * passes on a stale copy.
 */
export class GenerationReconciler {
  private upTo = 0;
  private _ready = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private stopped = false;

  constructor(
    private readonly generations: SessionGenerations,
    private readonly changedSince: ChangedSince,
  ) {}

  public get ready() {
    return this._ready;
  }

  /** one run; true if everything up to the current sequence value is copied */
  public async reconcile(): Promise<boolean> {
    try {
      const from = Math.min(this.upTo, await this.generations.copiedUpTo());
      const { upTo, rows } = await this.changedSince(from);
      for (let i = 0; i < rows.length; i += 500) {
        await Promise.all(rows.slice(i, i + 500).map(row => this.generations.publish(row.userId, row.gen)));
      }
      await this.generations.markCopied(upTo);
      this.upTo = Math.max(from, upTo);
      this._ready = true;
      return true;
    }
    catch (e) {
      console.error("Error copying the session generations to Valkey", e instanceof Error ? e.message : e);
      return false;
    }
  }

  /** runs now, then every RECONCILE_INTERVAL_MS (every RECONCILE_RETRY_MS until the first run succeeds) */
  public start(intervals = { regular: RECONCILE_INTERVAL_MS, retry: RECONCILE_RETRY_MS }) {
    const run = async () => {
      const done = await this.reconcile();
      if (!this.stopped) {
        this.timer = setTimeout(run, this._ready && done ? intervals.regular : intervals.retry);
        this.timer.unref?.();
      }
    };
    void run();
  }

  public stop() {
    this.stopped = true;
    clearTimeout(this.timer);
  }
}
