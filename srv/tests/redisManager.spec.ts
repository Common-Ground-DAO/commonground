// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Redis client setup: every client survives `error` events (an EventEmitter
 * `error` without a listener would crash the process), clients are only
 * created on first use, and each client type goes to its instance (state vs.
 * cache). No server is needed — node-redis' `createClient` is mocked.
 */

import { EventEmitter } from 'events';

type FakeClient = EventEmitter & {
  options: { url: string; password?: string; RESP: number; commandsQueueMaxLength: number };
  isReady: boolean;
  connect: jest.Mock;
  publish: jest.Mock;
  /** the original publish mock, before createRedisClient wraps it */
  rawPublish: jest.Mock;
};
const created: FakeClient[] = [];
const pending = () => new Promise<void>(() => undefined);
let connectBehaviour: () => Promise<void> = pending;

jest.mock('redis', () => ({
  createClient: (options: FakeClient['options']) => {
    const publish = jest.fn();
    const client = Object.assign(new EventEmitter(), {
      options,
      isReady: false,
      connect: jest.fn(() => connectBehaviour()),
      publish,
      rawPublish: publish,
    });
    created.push(client as FakeClient);
    return client;
  },
}));

import { createRedisClient, withTimeout } from '../redis/client';

beforeEach(() => {
  created.length = 0;
  connectBehaviour = pending;
  jest.restoreAllMocks();
});

describe('createRedisClient', () => {
  it('pins RESP2, bounds the command queue and passes url and password through', () => {
    createRedisClient({ url: 'redis://redis:6379', password: 'pw', name: 'data' });
    expect(created[0].options).toEqual({
      url: 'redis://redis:6379',
      password: 'pw',
      RESP: 2,
      commandsQueueMaxLength: 10_000,
    });
  });

  it('marks publish promises as handled, so an un-awaited failed PUBLISH cannot crash the process', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const unhandled = jest.fn();
    process.on('unhandledRejection', unhandled);
    try {
      const client = createRedisClient({ url: 'redis://redis:6379', name: 'socketIOPub' });
      created[0].rawPublish.mockImplementation(() => Promise.reject(new Error('Command timeout')));
      // what the Socket.IO emitter does: call and forget
      client.publish('channel', 'message');
      await new Promise(resolve => setImmediate(resolve));
      expect(unhandled).not.toHaveBeenCalled();
      expect(log).toHaveBeenCalledWith(expect.stringContaining('Command timeout'));
      // a caller that awaits still sees the error
      created[0].rawPublish.mockImplementation(() => Promise.reject(new Error('Command timeout')));
      await expect(client.publish('channel', 'message')).rejects.toThrow('Command timeout');
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('handles error events instead of throwing them, and throttles the log', () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    createRedisClient({ url: 'redis://user:secret@redis:6379', name: 'data' });
    const client = created[0];
    expect(client.listenerCount('error')).toBe(1);
    expect(() => client.emit('error', new Error('connect ECONNREFUSED'))).not.toThrow();
    expect(() => client.emit('error', new Error('connect ECONNREFUSED'))).not.toThrow();
    expect(log).toHaveBeenCalledTimes(1);
    expect(log.mock.calls[0][0]).toContain('Redis client "data" (redis:6379): connect ECONNREFUSED');
    expect(log.mock.calls[0][0]).not.toContain('secret');
  });

  it('reports the next error right away once the client was connected again', () => {
    const error = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    const info = jest.spyOn(console, 'log').mockImplementation(() => undefined);
    createRedisClient({ url: 'redis://redis:6379', name: 'session' });
    const client = created[0];
    client.emit('error', new Error('Socket closed unexpectedly'));
    client.emit('ready');
    expect(info).toHaveBeenCalledWith('Redis client "session" (redis:6379) is connected again');
    client.emit('error', new Error('Socket closed unexpectedly'));
    expect(error).toHaveBeenCalledTimes(2);
  });
});

describe('withTimeout', () => {
  it('rejects a chain that does not settle in time', async () => {
    await expect(withTimeout(new Promise(() => undefined), 'test MULTI', 20)).rejects.toThrow('Redis test MULTI timed out after 20 ms');
  });

  it('passes a timely result through', async () => {
    await expect(withTimeout(Promise.resolve([1, 2]), 'test MULTI', 1000)).resolves.toEqual([1, 2]);
  });
});

describe('redisManager', () => {
  const env = { ...process.env };
  afterEach(() => {
    process.env = { ...env };
  });

  function loadManager() {
    let manager: typeof import('../redis').default | undefined;
    jest.isolateModules(() => {
      manager = require('../redis').default;
    });
    return manager!;
  }

  it('opens no connection until a client is used', () => {
    const manager = loadManager();
    expect(created).toHaveLength(0);
    manager.getClient('data');
    manager.getClient('data');
    expect(created).toHaveLength(1);
    expect(created[0].connect).toHaveBeenCalledTimes(1);
  });

  it('sends the cache client to the cache instance and everything else to the state instance', () => {
    delete process.env.REDIS_URL;
    delete process.env.REDIS_CACHE_URL;
    const manager = loadManager();
    for (const type of ['session', 'socketIOPub', 'socketIOSub', 'data', 'cache'] as const) {
      manager.getClient(type);
    }
    expect(created.map(c => c.options.url)).toEqual([
      'redis://redis:6379',
      'redis://redis:6379',
      'redis://redis:6379',
      'redis://redis:6379',
      'redis://redis-cache:6379',
    ]);
    for (const client of created) {
      expect(client.listenerCount('error')).toBe(1);
    }
  });

  it('honours REDIS_URL and REDIS_CACHE_URL', () => {
    process.env.REDIS_URL = 'redis://state.example:6380';
    process.env.REDIS_CACHE_URL = 'redis://cache.example:6381';
    const manager = loadManager();
    manager.getClient('session');
    manager.getClient('cache');
    expect(created.map(c => c.options.url)).toEqual(['redis://state.example:6380', 'redis://cache.example:6381']);
  });

  it('drops a client whose connect() gave up, so the next call starts over', async () => {
    const log = jest.spyOn(console, 'error').mockImplementation(() => undefined);
    connectBehaviour = () => Promise.reject(new Error('Invalid URL'));
    const manager = loadManager();
    manager.getClient('data');
    await expect(manager.ready('data')).rejects.toThrow('Invalid URL');
    expect(log).toHaveBeenCalledWith('Redis client "data" gave up connecting', expect.any(Error));
    connectBehaviour = pending;
    manager.getClient('data');
    expect(created).toHaveLength(2);
  });

  it('hands out the cache client only while it is connected', () => {
    const manager = loadManager();
    expect(manager.connectedClient('cache')).toBeUndefined();
    created[0].isReady = true;
    expect(manager.connectedClient('cache')).toBe(created[0]);
  });
});
