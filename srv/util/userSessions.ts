// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type express from 'express';
import type session from 'express-session';
import { sessionStoreTtlSeconds } from './sessionSetup';
import errors from '../common/errors';
import type { SessionGenerations } from './sessionGenerations';
import { instanceKeyPrefix } from './gateway';

/**
 * Which logged-in sessions a user has (docs/auth-identity §2, "Signing out
 * other devices"), so that all of them except the current one can be ended
 * right away and counted.
 *
 * The index lives next to the sessions: a sorted set `sess-user:<userId>` on
 * the same Valkey instance, member = session id, score = when the session
 * runs out in the store (ms). Writes and touches of a logged-in session
 * record it with its new expiry (withUserSessionIndex; a touch only when the
 * expiry moved by more than INDEX_REFRESH_MS), so the entry expires about
 * with the session; logout and a login that replaces a session drop the old
 * id. Recording also removes the entries that ran out, and the key itself
 * expires with its last entry. Ids whose session is gone before its time
 * (deleted elsewhere) are dropped when the index is read (endOtherSessions).
 * Bots never have sessions, so they never appear here. Whether a session is
 * still valid is decided by the session generations
 * (srv/util/sessionGenerations.ts), not by the index.
 */
export type UserSessionIndex = {
  /** records (or refreshes) a logged-in session of the user */
  record(userId: string, sid: string, expiresAt: number): Promise<void>;
  forget(userId: string, sid: string): Promise<void>;
  /** the user's session ids that have not run out yet */
  list(userId: string): Promise<string[]>;
};

/** a touch re-records a session only when its expiry moved by more than this */
export const INDEX_REFRESH_MS = 5 * 60 * 1000;


type IndexClient = {
  zAdd(key: string, members: { score: number; value: string }): Promise<unknown>;
  zRemRangeByScore(key: string, min: number | string, max: number | string): Promise<unknown>;
  zRem(key: string, member: string): Promise<unknown>;
  zRangeByScore(key: string, min: number | string, max: number | string): Promise<string[]>;
  pExpireAt(key: string, msTimestamp: number): Promise<unknown>;
};

/**
 * the index on the sessions' Valkey instance: `sess-user:<userId>`, with the
 * instance's key prefix (`gateway:` on a gateway)
 */
export function redisUserSessionIndex(client: IndexClient, prefix: string = instanceKeyPrefix()): UserSessionIndex {
  const userKey = (userId: string) => `${prefix}sess-user:${userId}`;
  return {
    record: async (userId, sid, expiresAt) => {
      const key = userKey(userId);
      // issued together, sent in one pipeline; every logged-in session gets
      // the same lifetime from its last request, so the newest record has
      // the latest expiry and the key lives as long as its longest entry
      await Promise.all([
        client.zAdd(key, { score: expiresAt, value: sid }),
        client.zRemRangeByScore(key, '-inf', Date.now()),
        client.pExpireAt(key, expiresAt),
      ]);
    },
    forget: async (userId, sid) => {
      await client.zRem(userKey(userId), sid);
    },
    list: async (userId) => client.zRangeByScore(userKey(userId), `(${Date.now()}`, '+inf'),
  };
}

/** what a session store keeps about its users' sessions (withUserSessionIndex) */
export type UserSessions = {
  index: UserSessionIndex;
  /** the Valkey copies of the users' generations (srv/util/sessionGenerations.ts) */
  generations?: SessionGenerations;
  /** false until the copies were reconciled with PostgreSQL once (GenerationReconciler) */
  generationsReady?: () => boolean;
  /** the user's generation in PostgreSQL (the authority) */
  currentGeneration?: (userId: string) => Promise<number>;
  /** deletes a device key that a login created while a sign-out ran */
  discardDevice?: (deviceId: string) => Promise<void>;
};

const registry = new WeakMap<session.Store, UserSessions>();

/** what the store keeps about the users' sessions, if anything */
export function userSessionsOf(store: session.Store | undefined): UserSessions | undefined {
  return store ? registry.get(store) : undefined;
}

/** the index the store records into (withUserSessionIndex), if any */
export function userSessionIndexOf(store: session.Store | undefined): UserSessionIndex | undefined {
  return userSessionsOf(store)?.index;
}

/** the session generations the request's store keeps, if any */
export function generationsOf(request: express.Request): SessionGenerations | undefined {
  return userSessionsOf(request.sessionStore)?.generations;
}

/** bounded memory of the last recorded expiry per session id (this process) */
const RECORDED_LIMIT = 10_000;

/**
 * Wraps the store: a session with a logged-in user that it writes, or touches
 * with an expiry that moved by more than INDEX_REFRESH_MS, is recorded in the
 * index with the expiry the store gives it (sessionStoreTtlSeconds).
 * Recording is best effort: a failure (e.g. the Valkey instance refusing
 * writes at its memory limit) is logged, and the session write or touch
 * still succeeds. `extras` registers the session generations (and how to
 * discard a device) with the store. Combine with withSessionRevocation
 * (either order: both wrap the same store object).
 */
export function withUserSessionIndex<S extends session.Store>(
  store: S,
  index: UserSessionIndex,
  extras: Omit<UserSessions, 'index'> = {},
): S {
  const set = store.set.bind(store);
  // stores pass an error to the callback, although the type says they don't
  const touch = store.touch?.bind(store) as ((sid: string, data: session.SessionData, callback: (e?: unknown) => void) => void) | undefined;
  const recorded = new Map<string, number>();
  const record = async (sid: string, data: session.SessionData, onlyIfMoved: boolean) => {
    const userId = data.user?.id;
    if (!userId) {
      return;
    }
    const expiresAt = Date.now() + sessionStoreTtlSeconds(data) * 1000;
    const last = recorded.get(sid);
    if (onlyIfMoved && last !== undefined && Math.abs(expiresAt - last) <= INDEX_REFRESH_MS) {
      return;
    }
    try {
      await index.record(userId, sid, expiresAt);
      recorded.delete(sid);
      recorded.set(sid, expiresAt);
      if (recorded.size > RECORDED_LIMIT) {
        recorded.delete(recorded.keys().next().value!);
      }
    }
    catch (e) {
      console.error("Error recording a session in the user's session index", e instanceof Error ? e.message : e);
    }
  };
  store.set = (sid, data, callback) => {
    set(sid, data, (e?: unknown) => {
      if (e) {
        callback?.(e);
        return;
      }
      record(sid, data, false).then(() => callback?.());
    });
  };
  if (touch) {
    store.touch = (sid, data, callback) => {
      const touched = new Promise<void>((resolve, reject) => touch(sid, data, (e?: unknown) => (e ? reject(e) : resolve())));
      const done = callback as ((e?: unknown) => void) | undefined;
      Promise.all([touched, record(sid, data, true)]).then(() => done?.(), (e) => done?.(e));
    };
  }
  registry.set(store, { index, ...extras });
  return store;
}

const loginStarts = new WeakMap<express.Request, number>();

/**
 * Records the session generation a login took when it started — before it
 * checked any credential (User/login, createUser, redeemTransferLink: the
 * first thing they do, srv/api/user.ts beginLogin). The session the login
 * establishes and the device key it creates carry it.
 */
export function setLoginGeneration(request: express.Request, gen: number): void {
  loginStarts.set(request, gen);
}

/** the generation the request's login started with (setLoginGeneration) */
export function loginGeneration(request: express.Request): number {
  const start = loginStarts.get(request);
  if (start === undefined) {
    throw new Error("A login has to take its session generation before it checks a credential");
  }
  return start;
}

/**
 * For a loaded session with a user: reads the user's generation and the
 * session that signed the others out (one round). A session with a lower
 * generation (one without any predates generations and counts as 0) ends
 * here — destroyed and revoked in the store, its data cleared for this
 * request, which then runs anonymously; the revocation guard keeps it from
 * being saved or its cookie being sent again. The session that signed the
 * others out is stamped with the new generation instead. Fails closed: if
 * the generation cannot be read — or the copies were not reconciled with
 * PostgreSQL yet since the api started — the request fails
 * (SERVICE_UNAVAILABLE) instead of trusting the session.
 */
export function sessionGenerationGuard(): express.RequestHandler {
  return (request, _response, next) => {
    const generations = generationsOf(request);
    const current = request.session as (session.Session & Partial<session.SessionData>) | undefined;
    const userId = current?.user?.id;
    if (!generations || !current || !userId) {
      next();
      return;
    }
    const sid = request.sessionID;
    if (userSessionsOf(request.sessionStore)?.generationsReady?.() === false) {
      next(new Error(errors.server.SERVICE_UNAVAILABLE));
      return;
    }
    generations.read(userId).then(async ({ gen, keepSid }) => {
      if ((current.gen ?? 0) < gen) {
        if (sid === keepSid) {
          current.gen = gen;
        }
        else {
          await destroySession(request.sessionStore, sid);
          await userSessionIndexOf(request.sessionStore)?.forget(userId, sid).catch(() => undefined);
          for (const key of Object.keys(current)) {
            if (key !== 'cookie') {
              delete (current as unknown as Record<string, unknown>)[key];
            }
          }
        }
      }
      next();
    }, (e) => next(e));
  };
}

function loadSession(store: session.Store, sid: string): Promise<session.SessionData | null | undefined> {
  return new Promise((resolve, reject) => store.get(sid, (e, data) => (e ? reject(e) : resolve(data))));
}

function destroySession(store: session.Store, sid: string): Promise<void> {
  return new Promise((resolve, reject) => store.destroy(sid, (e) => (e ? reject(e) : resolve())));
}

/**
 * Ends every logged-in session of `userId` except `keepSid` whose generation
 * is below `belowGen` (a login that started after the sign-out stays), through
 * the store's destroy — with withSessionRevocation that revokes each id first, so
 * a request that loaded one of them and is still running neither writes it
 * back nor sends its cookie again. Returns the ended sessions and the device
 * each was signed in with.
 */
export async function endOtherSessions(
  store: session.Store,
  index: UserSessionIndex,
  userId: string,
  keepSid: string,
  belowGen: number,
): Promise<{ sid: string; deviceId: string | null }[]> {
  const ended: { sid: string; deviceId: string | null }[] = [];
  for (const sid of await index.list(userId)) {
    if (sid === keepSid) {
      continue;
    }
    const data = await loadSession(store, sid);
    if (!data || data.user?.id !== userId) {
      // gone already (expired, logged out, deleted): drop the entry
      await index.forget(userId, sid);
      continue;
    }
    if ((data.gen ?? 0) >= belowGen) {
      continue;
    }
    await destroySession(store, sid);
    await index.forget(userId, sid);
    ended.push({ sid, deviceId: data.user.deviceId ?? null });
  }
  return ended;
}

/** what the request's session store keeps about the users' sessions; throws if it keeps no generations */
export function requestUserSessions(request: express.Request): UserSessions & { generations: SessionGenerations } {
  const sessions = userSessionsOf(request.sessionStore);
  if (!sessions?.generations) {
    throw new Error("The session store keeps no session generations");
  }
  return { ...sessions, generations: sessions.generations };
}
