// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// Small, hot-path cache for typing-presence authorization and delivery scoping.
//
// Typing events fire far more often than messages, so the per-emit DB lookups
// the message path performs (channel role permissions, chat membership) would
// be a load problem. The mapping we need — which roles can read/write a
// channel, and who is in a chat — is identical for every user typing in the
// same context and changes only when an admin edits channel/role permissions
// or chat membership. So we cache it with a short TTL plus event-driven busting
// off the same Postgres LISTEN/NOTIFY signals the member-list service uses.
//
// The sender's *own* role set is NOT cached here: it is read live from the
// socket's room membership (kept current by the role-change machinery), so
// authorization is only ever as stale as the channel→roles mapping (<= TTL).

import type { Notification, PoolClient } from 'pg';
import pool from '../util/postgres';
import { describeErrorForLog } from '../util/errorLog';
import communityHelper from './communities';
import chatHelper from './chats';
import messageHelper from './messages';

const TTL_MS = 30_000;
/** Entries per cache before expired ones are swept (and, if still full, all). */
const MAX_ENTRIES = 10_000;

export type ChannelTypingPerms = {
  readerRoleIds: string[];
  writerRoleIds: string[];
  // A public reader role means the channel is readable by the whole community,
  // so typing is delivered to the community room rather than per-role rooms —
  // mirroring how message events are scoped.
  isPublic: boolean;
};

type CacheEntry<T> = { value: Promise<T>; expiresAt: number };

// Keyed by `${communityId}:${channelId}`.
const channelPermsCache = new Map<string, CacheEntry<ChannelTypingPerms>>();
const chatUsersCache = new Map<string, CacheEntry<string[]>>();
// Whether an access object's channel belongs to its community/chat/article.
// A channel never moves to another scope, so only the TTL bounds staleness.
const accessScopeCache = new Map<string, CacheEntry<boolean>>();

const PUBLIC_ROLE_TITLE = 'Public';
const PREDEFINED_ROLE_TYPE = 'PREDEFINED';

async function loadChannelPerms(communityId: string, channelId: string): Promise<ChannelTypingPerms> {
  const rows = await communityHelper.getCommunityChannelRolePermissions(communityId, channelId);
  const readerRoleIds: string[] = [];
  const writerRoleIds: string[] = [];
  let isPublic = false;
  for (const row of rows) {
    const canRead = row.permissions.includes('CHANNEL_EXISTS') && row.permissions.includes('CHANNEL_READ');
    const canWrite = row.permissions.includes('CHANNEL_EXISTS') && row.permissions.includes('CHANNEL_WRITE');
    if (canRead) {
      readerRoleIds.push(row.roleId);
      if (row.roleType === PREDEFINED_ROLE_TYPE && row.roleTitle === PUBLIC_ROLE_TITLE) {
        isPublic = true;
      }
    }
    if (canWrite) {
      writerRoleIds.push(row.roleId);
    }
  }
  return { readerRoleIds, writerRoleIds, isPublic };
}

function sweep<T>(store: Map<string, CacheEntry<T>>, now: number): void {
  for (const [key, entry] of store) {
    if (entry.expiresAt <= now) {
      store.delete(key);
    }
  }
  if (store.size >= MAX_ENTRIES) {
    store.clear();
  }
}

function cached<T>(store: Map<string, CacheEntry<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value;
  }
  if (store.size >= MAX_ENTRIES) {
    sweep(store, now);
  }
  // Don't cache rejections: on failure, drop the entry so the next call retries.
  const value = load().catch((error) => {
    if (store.get(key)?.value === value) {
      store.delete(key);
    }
    throw error;
  });
  store.set(key, { value, expiresAt: now + TTL_MS });
  return value;
}

export function getChannelTypingPerms(communityId: string, channelId: string): Promise<ChannelTypingPerms> {
  return cached(channelPermsCache, `${communityId}:${channelId}`, () => loadChannelPerms(communityId, channelId));
}

function accessScopeKey(access: API.Messages.MessageAccess): string | null {
  if ('communityId' in access) {
    return `community:${access.communityId}:${access.channelId}`;
  }
  if ('chatId' in access) {
    return `chat:${access.chatId}:${access.channelId}`;
  }
  if ('articleId' in access && 'articleCommunityId' in access) {
    return `communityArticle:${access.articleId}:${access.articleCommunityId}:${access.channelId}`;
  }
  if ('articleId' in access && 'articleUserId' in access) {
    return `userArticle:${access.articleId}:${access.articleUserId}:${access.channelId}`;
  }
  return null;
}

/**
 * Cached `messageHelper.isChannelInAccessScope` for community, chat and
 * article access objects (calls have no typing surface).
 */
export function isChannelInAccessScope(access: API.Messages.MessageAccess): Promise<boolean> {
  const key = accessScopeKey(access);
  if (!key) {
    return Promise.resolve(false);
  }
  return cached(accessScopeCache, key, () => messageHelper.isChannelInAccessScope(access));
}

export function getChatUserIds(chatId: string): Promise<string[]> {
  return cached(chatUsersCache, chatId, async () => (await chatHelper.getChatById(chatId)).userIds);
}

export function invalidateChannel(channelId: string): void {
  const suffix = `:${channelId}`;
  for (const key of channelPermsCache.keys()) {
    if (key.endsWith(suffix)) {
      channelPermsCache.delete(key);
    }
  }
}

export function invalidateAllChannels(): void {
  channelPermsCache.clear();
}

let invalidationStarted = false;

/** delay before the second attempt; it doubles per further attempt up to RELISTEN_MAX_DELAY_MS */
export const RELISTEN_DELAY_MS = 2_000;
export const RELISTEN_MAX_DELAY_MS = 30_000;
const KEEPALIVE_MS = 60_000;

// Wire event-driven busting. Called once from the socket server after redis is
// ready; safe to call more than once. Until LISTEN works the cache relies on
// its TTL alone (correctness holds, staleness just rises to the TTL), so the
// dedicated LISTEN connection is retried until it works — the socket server
// can start before Postgres accepts connections.
//
// A LISTEN connection that fails later (the database restarted or closed it:
// its `error` event, or a failing keepalive) is given up and LISTEN is set
// up again on a new connection the same way. Every cached channel entry is
// dropped when LISTEN works (again): entries cached while nobody listened may
// have missed notifications. The connection's own `error` listener — from
// right after `pool.connect()` on — is what keeps that event from ending the
// process (the pool only listens on idle connections, srv/util/postgres.ts).
export async function initTypingCacheInvalidation(): Promise<void> {
  await startListening();
}

/** one LISTEN connection, set up with retries until it works */
async function startListening(): Promise<void> {
  if (invalidationStarted) {
    return;
  }
  invalidationStarted = true;

  let listening: { client: PoolClient; setupError: (error: unknown) => void; failed: { error?: unknown } } | undefined;
  for (let attempt = 1; !listening; attempt++) {
    let client: PoolClient | undefined;
    // a connection that dies during the setup emits `error` besides failing
    // the query that runs (or the next one): taken here, the query decides
    const failed: { error?: unknown } = {};
    const setupError = (error: unknown) => { failed.error ??= error; };
    try {
      client = await pool.connect();
      client.on('error', setupError);
      await client.query('LISTEN channelrolepermissionchange');
      await client.query('LISTEN rolechange');
      listening = { client, setupError, failed };
    } catch (error) {
      if (client) {
        // a dead connection never goes back to the pool; `setupError` stays
        // for the `error` events a dead connection may still emit
        try { client.release(true); } catch { /* ignore */ }
      }
      console.error(`typingCache: LISTEN failed (attempt ${attempt}), trying again`, describeErrorForLog(error));
      await new Promise((resolve) => setTimeout(resolve, relistenDelay(attempt)));
    }
  }
  const { client, setupError, failed } = listening;

  let lost = false;
  const onLost = (error: unknown) => {
    if (lost) {
      return;
    }
    lost = true;
    clearInterval(keepAlive);
    client.removeListener('notification', onNotification);
    // a dead connection never goes back to the pool
    try { client.release(true); } catch { /* ignore */ }
    // changes while nobody listened were not seen
    invalidateAllChannels();
    invalidationStarted = false;
    console.error('typingCache: the LISTEN connection failed, listening again', describeErrorForLog(error));
    const retry = setTimeout(() => {
      startListening().catch((e) => console.error('typingCache: listening again failed', describeErrorForLog(e)));
    }, RELISTEN_DELAY_MS);
    retry.unref?.();
  };
  // from now on the connection's failures are a lost connection (one
  // listener at a time)
  client.on('error', onLost);
  client.removeListener('error', setupError);

  const onNotification = (msg: Notification) => {
    if (!msg.payload) {
      return;
    }
    try {
      const payload = JSON.parse(msg.payload) as { type?: string; channelId?: string };
      if (payload.type === 'channelrolepermissionchange' && payload.channelId) {
        invalidateChannel(payload.channelId);
      } else if (payload.type === 'rolechange') {
        // A role was created / deleted / retyped. Its effect on any channel's
        // reader/writer set isn't in the payload, so flush all channel entries;
        // role changes are rare, so the re-warm cost is negligible.
        invalidateAllChannels();
      }
    } catch (error) {
      console.error('typingCache: bad notification payload', error);
    }
  };
  client.on('notification', onNotification);
  // listening (again): entries cached before may have missed notifications
  invalidateAllChannels();

  // Keep the dedicated LISTEN connection from being reaped; a failing
  // keepalive is a lost connection as well.
  const keepAlive = setInterval(() => {
    client.query('SELECT 1').catch(onLost);
  }, KEEPALIVE_MS);
  keepAlive.unref?.();
  if (failed.error !== undefined) {
    // it failed right after the setup, before onLost listened
    onLost(failed.error);
  }
}

/** RELISTEN_DELAY_MS, doubled per further attempt, at most RELISTEN_MAX_DELAY_MS */
function relistenDelay(attempt: number): number {
  return Math.min(RELISTEN_DELAY_MS * 2 ** Math.max(0, attempt - 1), RELISTEN_MAX_DELAY_MS);
}
