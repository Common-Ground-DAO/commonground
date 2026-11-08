// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
  realRandomHexString,
  dockerSecret
} from '../util';
import UserDataManager from './userdata';
import { createRedisClient, type CgRedisClient } from './client';

type ClientType = 'session'|'socketIOPub'|'socketIOSub'|'data'|'cache';

/**
 * Two server instances (both Valkey), split by what may be lost:
 *
 * - `state` (`REDIS_URL`, default `redis://redis:6379`): sessions, the
 *   Socket.IO pub/sub, and every key whose loss changes behaviour — rate-limit
 *   windows, captcha / plugin-request replay guards, the shared ALTCHA HMAC
 *   key, bot presence leases, user online status. `noeviction` and persisted:
 *   when memory runs out, writes fail loudly instead of silently dropping a
 *   session or a replay guard.
 * - `cache` (`REDIS_CACHE_URL`, default `redis://redis-cache:6379`): data that
 *   can be rebuilt at any time (today only the URL-preview cache).
 *   `allkeys-lru`, not persisted, its own memory budget — so a filling cache
 *   evicts its own entries and can never push the state instance into
 *   out-of-memory errors that break logins.
 *
 * Point both URLs at the same server to run on one instance (the key prefixes
 * are disjoint); that just gives up the isolation.
 */
const INSTANCE_OF: { [type in ClientType]: 'state'|'cache' } = {
  session: 'state',
  socketIOPub: 'state',
  socketIOSub: 'state',
  data: 'state',
  cache: 'cache',
};

class RedisManager {
  private clients: { [type in ClientType]?: { client: CgRedisClient; connected: Promise<void> } } = {};
  private urls: { state: string; cache: string };
  private password: string | undefined;
  private _userData: UserDataManager;
  private _instanceId: string;

  constructor() {
    // Clients are created — and connect — on first use, so a process only
    // holds the connections it actually needs (memberlist and the job-runner
    // main thread import this module without using it; job workers only need
    // the Socket.IO publisher; only `api` uses the session store and the cache;
    // only `wsapi` subscribes).
    //
    // Five client objects at most: the Socket.IO adapter needs a dedicated
    // subscriber connection (a subscribed RESP2 connection cannot issue normal
    // commands), which is a protocol requirement; the separate `session`
    // client is historical (it used to be the one client that needed
    // `legacyMode`) and is kept because collapsing connections is a behaviour
    // change, not part of this refactor; `cache` talks to the other instance.
    //
    // NOTE: `REDIS_LEGACY_MODE` is obsolete and ignored. It existed because
    // connect-redis v6 spoke the node-redis v3 callback API, so the session
    // client had to be created with `legacyMode: true`. connect-redis 10 uses
    // the promise API directly and node-redis dropped `legacyMode` entirely.
    this.urls = {
      state: process.env.REDIS_URL || 'redis://redis:6379',
      cache: process.env.REDIS_CACHE_URL || 'redis://redis-cache:6379',
    };
    this.password = dockerSecret('redis_password') || process.env.REDIS_PASSWORD;
    this._userData = new UserDataManager(() => this.getClient('data'));

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

  /**
   * The client of the given type, created and connecting on first call.
   * Commands sent before the connection is up wait in node-redis' offline
   * queue; single commands fail after its 5 s command timeout if the server
   * stays away, MULTI / pipeline chains need `withTimeout()` (see client.ts).
   */
  public getClient(type: ClientType): CgRedisClient {
    return this.entry(type).client;
  }

  /**
   * The client if it is connected right now, else `undefined` — for optional
   * uses (caches) that should be skipped rather than waited for while their
   * server is away. The first call creates the client, so it starts out
   * `undefined` until the connection is up.
   */
  public connectedClient(type: ClientType): CgRedisClient | undefined {
    const client = this.getClient(type);
    return client.isReady ? client : undefined;
  }

  /**
   * Resolves once the clients of the given types have connected (once — it
   * says nothing about the connection still being up). Never rejects while
   * node-redis keeps retrying, so it waits for as long as the server is
   * unreachable: use it for startup ordering (`wsapi` attaching the Socket.IO
   * adapter), not on request paths.
   */
  public async ready(...types: ClientType[]): Promise<void> {
    await Promise.all(types.map(type => this.entry(type).connected));
  }

  public async get(type: ClientType, key: string) {
    return this.getClient(type).get(key);
  }

  public async set(type: ClientType, key: string, value: string) {
    return this.getClient(type).set(key, value);
  }

  public async del(type: ClientType, key: string) {
    return this.getClient(type).del(key);
  }

  /* PRIVATE */

  private entry(type: ClientType) {
    let entry = this.clients[type];
    if (!entry) {
      const client = createRedisClient({
        url: this.urls[INSTANCE_OF[type]],
        password: this.password,
        name: type,
      });
      // connect() keeps retrying until the server answers (the default
      // reconnect strategy never gives up); failed attempts are reported
      // through the client's `error` listener (see client.ts). Should it
      // reject anyway (e.g. an invalid URL), the entry is dropped so the next
      // call starts over with a fresh client.
      const connected = client.connect().then(() => undefined);
      const created = { client, connected };
      connected.catch((error) => {
        console.error(`Redis client "${type}" gave up connecting`, error);
        if (this.clients[type] === created) {
          delete this.clients[type];
        }
      });
      entry = created;
      this.clients[type] = entry;
    }
    return entry;
  }
}

const redisManager = new RedisManager();
export default redisManager;
