// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
  realRandomHexString,
  dockerSecret
} from '../util';
import UserDataManager from './userdata';
import { createRedisClient, type CgRedisClient } from './client';

type ClientType = 'session'|'socketIOPub'|'socketIOSub'|'data';

class RedisManager {
  private clients: { [name in ClientType]: CgRedisClient };
  private _userData: UserDataManager;
  private _instanceId: string;

  public isReady: Promise<void>;

  constructor() {
    // One Redis instance serves every purpose. Four client objects: the
    // Socket.IO adapter needs a dedicated subscriber connection (a subscribed
    // RESP2 connection cannot issue normal commands), which is a protocol
    // requirement; the separate `session` client is now only historical (it
    // used to be the one client that needed `legacyMode`) and is kept because
    // collapsing connections is a behaviour change, not a dependency bump.
    // Key prefixes are pairwise disjoint.
    //
    // NOTE: `REDIS_LEGACY_MODE` is obsolete and ignored. It existed because
    // connect-redis v6 spoke the node-redis v3 callback API, so the session
    // client had to be created with `legacyMode: true`. connect-redis 10 uses
    // the promise API directly and node-redis dropped `legacyMode` entirely, so
    // there is nothing left to switch. The variable is still set in the compose
    // files; it is harmless, and removing it there is a maintainer decision.
    const url = process.env.REDIS_URL || 'redis://redis:6379';
    const password = dockerSecret('redis_password') || process.env.REDIS_PASSWORD;
    const sessionClient = createRedisClient({ url, password });
    const socketIOPubClient = createRedisClient({ url, password });
    const socketIOSubClient = socketIOPubClient.duplicate();
    const dataClient = createRedisClient({ url, password });
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
    return this.clients[type].get(key);
  }

  public async set(type: ClientType, key: string, value: string) {
    await this.isReady;
    return this.clients[type].set(key, value);
  }

  public async del(type: ClientType, key: string) {
    await this.isReady;
    return this.clients[type].del(key);
  }
}

const redisManager = new RedisManager();
export default redisManager;
