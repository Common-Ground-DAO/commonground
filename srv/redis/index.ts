// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import * as redis from 'redis';
import {
  realRandomHexString,
  dockerSecret
} from '../util';
import UserDataManager from './userdata';

type ClientType = 'session'|'socketIOPub'|'socketIOSub'|'data';

class RedisManager {
  private legacyMode: boolean;
  private clients: { [name in ClientType]: ReturnType<typeof redis['createClient']> };
  private _userData: UserDataManager;
  private _instanceId: string;

  public isReady: Promise<void>;

  constructor() {
    this.legacyMode = process.env.REDIS_LEGACY_MODE === 'true';
    // One Redis instance serves every purpose. The four client objects stay:
    // the session client needs `legacyMode` (connect-redis v6 speaks the
    // node-redis v3 API) and the Socket.IO adapter needs a dedicated
    // subscriber connection — both are protocol requirements, not reasons to
    // run separate servers. Key prefixes are pairwise disjoint.
    const url = process.env.REDIS_URL || 'redis://redis:6379';
    const password = dockerSecret('redis_password') || process.env.REDIS_PASSWORD;
    const sessionClient = redis.createClient({
      url,
      password,
      legacyMode: this.legacyMode
    });
    const socketIOPubClient = redis.createClient({ url, password });
    const socketIOSubClient = socketIOPubClient.duplicate();
    const dataClient = redis.createClient({ url, password });
    this.clients = {
      session: sessionClient,
      socketIOPub: socketIOPubClient,
      socketIOSub: socketIOSubClient,
      data: dataClient,
    };
    const promises = [
      sessionClient.connect(),
      socketIOPubClient.connect(),
      socketIOSubClient.connect(),
      dataClient.connect(),
    ];
    this.isReady = (async () => {
      await Promise.all(promises);
    })();
    this._userData = new UserDataManager(dataClient, this.isReady);

    // generate random instance id
    this._instanceId = realRandomHexString(16);
  }

  get instanceId() {
    return this._instanceId;
  }

  get userData() {
    return this._userData;
  }

  /* PUBLIC */
  public getClient(type: ClientType) {
    return this.clients[type];
  }

  public async get(type: ClientType, key: string) {
    await this.isReady;
    if (this.legacyMode && type === 'session') {
      return new Promise<string|null>((resolve, reject) => {
        (this.clients.session as any).get(key, (err: unknown, value: string|null) => {
          if (err) {
            reject(err);
          } else {
            resolve(value);
          }
        });
      });
    } else {
      return this.clients[type].get(key);
    }
  }

  public async set(type: ClientType, key: string, value: string) {
    await this.isReady;
    if (this.legacyMode && type === 'session') {
      return new Promise<void>((resolve, reject) => {
        (this.clients.session as any).set(key, value, (err: unknown, status: string) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    } else {
      return this.clients[type].set(key, value);
    }
  }

  public async del(type: ClientType, key: string) {
    await this.isReady;
    if (this.legacyMode && type === 'session') {
      return new Promise<void>((resolve, reject) => {
        (this.clients.session as any).del(key, (err: unknown, status: string) => {
          if (err) {
            reject(err);
          } else {
            resolve();
          }
        });
      });
    } else {
      return this.clients[type].del(key);
    }
  }
}

const redisManager = new RedisManager();
export default redisManager;