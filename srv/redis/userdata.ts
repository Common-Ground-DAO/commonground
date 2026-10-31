// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { withTimeout, type CgRedisClient } from './client';
import { randomString } from '../util';

const userSessionPrefix = 'us';
const userDataPrefix = 'ud';
const onlineUsersKey = 'online-user-addresses';

export default class UserDataManager {
  // a getter, so the `data` client is only created (and connected) on first
  // use. Nothing here waits for the connection: commands queue until it is up,
  // and every MULTI is wrapped in withTimeout() because node-redis gives MULTI
  // no command timeout.
  private getClient: () => CgRedisClient;

  constructor(getClient: () => CgRedisClient) {
    this.getClient = getClient;
  }

  private get client() {
    return this.getClient();
  }

  // SESSIONS
  public async addUserSession(userId: string, sessionId: string): Promise<void> {
    const key = `${userSessionPrefix}:${userId}`;
    await withTimeout(this.client.multi()
      .sAdd(key, sessionId)
      .sAdd(onlineUsersKey, userId)
      .exec(), 'addUserSession MULTI');
  }

  public async removeUserSession(userId: string, sessionId: string): Promise<number> {
    const key = `${userSessionPrefix}:${userId}`;
    // `execTyped()` (node-redis 5+) keeps the per-command reply types of the
    // chain instead of collapsing them to `ReplyUnion[]` like plain `exec()`.
    const sessionCount = (await withTimeout(this.client.multi()
      .sRem(key, sessionId)
      .sCard(key)
      .execTyped(), 'removeUserSession MULTI'))[1];
    if (sessionCount === 0) {
      await this.client.sRem(onlineUsersKey, userId);
    }
    return sessionCount;
  }

  public async setUserData(userId: string, data: { status: Models.User.OnlineStatus }): Promise<void> {
    const key = `${userDataPrefix}:${userId}`;
    await this.client.hSet(key, 'status', data.status);
  }

  public async getUserData(userIds: string[]): Promise<{ status?: Models.User.OnlineStatus }[]> {
    if (userIds.length === 0) {
      return [];
    }
    const keys = userIds.map(userId => `${userDataPrefix}:${userId}`);
    // Queued in place rather than by reassignment: since node-redis 5 the multi
    // builder carries the accumulated reply tuple in its type, so
    // `q = q.hGetAll(k)` no longer type-checks. The methods mutate and return
    // `this`, so the loop is equivalent. HGETALL replies stay plain objects
    // (RESP2 — see redis/client.ts), which is what the cast below assumes.
    const dataQuery = this.client.multi();
    for (const key of keys) {
      dataQuery.hGetAll(key);
    }
    return (await withTimeout(dataQuery.exec(), 'getUserData MULTI')) as unknown as { status?: Models.User.OnlineStatus }[];
  }

  public async intersectWithOnlineUsers(userIds: string[]): Promise<string[]> {
    if (userIds.length > 0) {
      // namespaced so the throwaway intersection set can never collide with
      // one of the real key prefixes on the shared instance
      const randomKey = `tmp:${randomString(6)}`;
      const [ , result ] = await withTimeout(this.client.multi()
        .sAdd(randomKey, userIds)
        .sInter([randomKey, onlineUsersKey])
        .del(randomKey)
        .execTyped(), 'intersectWithOnlineUsers MULTI');
      return result;
    } else {
      return [];
    }
  }
}