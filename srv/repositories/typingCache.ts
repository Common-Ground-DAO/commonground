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

import pool from '../util/postgres';
import communityHelper from './communities';
import chatHelper from './chats';

const TTL_MS = 30_000;

export type ChannelTypingPerms = {
  readerRoleIds: string[];
  writerRoleIds: string[];
  // A public reader role means the channel is readable by the whole community,
  // so typing is delivered to the community room rather than per-role rooms —
  // mirroring how message events are scoped.
  isPublic: boolean;
};

type CacheEntry<T> = { value: Promise<T>; expiresAt: number };

const channelPermsCache = new Map<string, CacheEntry<ChannelTypingPerms>>();
const chatUsersCache = new Map<string, CacheEntry<string[]>>();

const PUBLIC_ROLE_TITLE = 'Public';

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
      if (row.roleTitle === PUBLIC_ROLE_TITLE) {
        isPublic = true;
      }
    }
    if (canWrite) {
      writerRoleIds.push(row.roleId);
    }
  }
  return { readerRoleIds, writerRoleIds, isPublic };
}

function cached<T>(store: Map<string, CacheEntry<T>>, key: string, load: () => Promise<T>): Promise<T> {
  const now = Date.now();
  const hit = store.get(key);
  if (hit && hit.expiresAt > now) {
    return hit.value;
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
  return cached(channelPermsCache, channelId, () => loadChannelPerms(communityId, channelId));
}

export function getChatUserIds(chatId: string): Promise<string[]> {
  return cached(chatUsersCache, chatId, async () => (await chatHelper.getChatById(chatId)).userIds);
}

export function invalidateChannel(channelId: string): void {
  channelPermsCache.delete(channelId);
}

export function invalidateAllChannels(): void {
  channelPermsCache.clear();
}

let invalidationStarted = false;

// Wire event-driven busting. Called once from the socket server after redis is
// ready; safe to call more than once. Falls back to pure TTL if the LISTEN
// connection can't be established.
export async function initTypingCacheInvalidation(): Promise<void> {
  if (invalidationStarted) {
    return;
  }
  invalidationStarted = true;
  let client;
  try {
    client = await pool.connect();
    await client.query('LISTEN channelrolepermissionchange');
    await client.query('LISTEN rolechange');
  } catch (error) {
    invalidationStarted = false;
    console.error('typingCache: failed to start LISTEN, relying on TTL only', error);
    return;
  }

  client.on('notification', (msg) => {
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
  });

  // Keep the dedicated LISTEN connection from being reaped.
  const keepAlive = setInterval(() => {
    client.query('SELECT 1').catch((error) => {
      console.error('typingCache: keepalive failed', error);
      clearInterval(keepAlive);
      invalidationStarted = false;
    });
  }, 60_000);
}
