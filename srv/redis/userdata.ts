// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type * as redis from 'redis';
import { randomString } from '../util';

const userSessionPrefix = 'us';
const userDataPrefix = 'ud';
const onlineUsersKey = 'online-user-addresses';

export default class UserDataManager {
  private client: ReturnType<typeof redis['createClient']>;
  private isReady: Promise<void>;

  constructor(
    client: ReturnType<typeof redis['createClient']>,
    isReady: Promise<void>,
  ) {
    this.client = client;
    this.isReady = isReady;
  }

  // SESSIONS
  public async addUserSession(userId: string, sessionId: string): Promise<void> {
    await this.isReady;
    const key = `${userSessionPrefix}:${userId}`;
    await this.client.multi()
      .sAdd(key, sessionId)
      .sAdd(onlineUsersKey, userId)
      .exec();
  }

  public async removeUserSession(userId: string, sessionId: string): Promise<number> {
    await this.isReady;
    const key = `${userSessionPrefix}:${userId}`;
    const sessionCount = (await this.client.multi()
      .sRem(key, sessionId)
      .sCard(key)
      .exec())[1] as number;
    if (sessionCount === 0) {
      await this.client.sRem(onlineUsersKey, userId);
    }
    return sessionCount;
  }

  public async setUserData(userId: string, data: { status: Models.User.OnlineStatus }): Promise<void> {
    await this.isReady;
    const key = `${userDataPrefix}:${userId}`;
    await this.client.hSet(key, 'status', data.status);
  }

  public async getUserData(userIds: string[]): Promise<{ status?: Models.User.OnlineStatus }[]> {
    await this.isReady;
    if (userIds.length === 0) {
      return [];
    }
    const keys = userIds.map(userId => `${userDataPrefix}:${userId}`);
    let dataQuery = this.client.multi();
    for (const key of keys) {
      dataQuery = dataQuery.hGetAll(key);
    }
    return (await dataQuery.exec()) as unknown as { status?: Models.User.OnlineStatus }[];
  }

  public async intersectWithOnlineUsers(userIds: string[]): Promise<string[]> {
    await this.isReady;
    if (userIds.length > 0) {
      // namespaced so the throwaway intersection set can never collide with
      // one of the real key prefixes on the shared instance
      const randomKey = `tmp:${randomString(6)}`;
      const [ , result ] = (await this.client.multi()
        .sAdd(randomKey, userIds)
        .sInter([randomKey, onlineUsersKey])
        .del(randomKey)
        .exec()) as [undefined, string[]];
      return result;
    } else {
      return [];
    }
  }
}