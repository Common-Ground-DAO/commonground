// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { createClient } from 'redis';

/** At most one logged connection error per client and interval. */
const ERROR_LOG_INTERVAL_MS = 30_000;

/**
 * node-redis' default per-command timeout (`DEFAULT_COMMAND_TIMEOUT`), which
 * `withTimeout()` applies to MULTI / pipeline chains as well.
 */
export const COMMAND_TIMEOUT_MS = 5_000;

/**
 * Upper bound for commands queued per client (written or awaiting a reply).
 * While the server is unreachable, commands wait in this queue; beyond the
 * bound node-redis rejects new ones at once ("The queue is full") instead of
 * letting the queue grow for the whole outage.
 */
const COMMANDS_QUEUE_MAX_LENGTH = 10_000;

/**
 * Single place where a node-redis client is constructed, so every connection in
 * this process shares the same protocol settings — and so the client type has
 * one name instead of being spelled `ReturnType<typeof createClient>` (which,
 * since node-redis 6, no longer describes *our* clients: the type carries a
 * RESP-version generic that defaults to 3).
 *
 * The server is Valkey (a Redis fork that speaks the same protocol); node-redis
 * does not care which of the two it talks to.
 *
 * `RESP: 2` is deliberate. node-redis 6 flipped the default protocol to RESP3
 * (`DEFAULT_RESP = 3`), which changes reply shapes for a number of commands and
 * moves pub/sub onto the RESP3 push protocol. `@socket.io/redis-adapter` 8.3 —
 * still the newest release — was written against RESP2: it drives pub/sub
 * through the node-redis v4 `pSubscribe(pattern, listener, bufferMode)` API and
 * reads `PUBSUB NUMSUB` positionally (`parseInt(reply[1])`), which
 * redis.io documents as a *map* reply under RESP3. Pinning RESP2 keeps the wire
 * format identical to what redis 4 spoke, so this upgrade stays a pure
 * client-library change instead of also being a protocol change.
 *
 * (Measured 2026-08-04 against redis 6.2.7 — the version this stack ran then —
 * and redis 8.10: both still answer `PUBSUB NUMSUB` with a flat array even on a
 * RESP3 connection, so that specific hazard is latent rather than live. The pin
 * stands anyway; adopting RESP3 is its own change with its own verification.)
 *
 * Every client gets an `error` listener here. node-redis emits `error` on the
 * client for every failed (re)connection attempt; an EventEmitter `error`
 * without a listener is thrown, which would take the whole process down on a
 * plain server restart. With the listener, the client keeps reconnecting with
 * node-redis' default strategy (exponential backoff capped at 2 s plus jitter,
 * no retry limit) and pub/sub subscriptions are restored on reconnect.
 *
 * Commands issued meanwhile wait in the offline queue (bounded by
 * `commandsQueueMaxLength`). Single commands fail after node-redis' default
 * 5 s command timeout; MULTI and pipeline chains get no timeout from
 * node-redis 6 (`_executeMulti` / `_executePipeline` queue their commands
 * without one), so every call site wraps `exec()` / `execTyped()` in
 * `withTimeout()`.
 */
export function createRedisClient(options: { url: string; password?: string; name: string }) {
  const client = createClient({
    url: options.url,
    password: options.password,
    RESP: 2,
    commandsQueueMaxLength: COMMANDS_QUEUE_MAX_LENGTH,
  });

  let lastLoggedAt = 0;
  let suppressed = 0;
  let failing = false;
  const logError = (error: unknown) => {
    const now = Date.now();
    if (now - lastLoggedAt < ERROR_LOG_INTERVAL_MS) {
      suppressed++;
      return;
    }
    const message = error instanceof Error ? error.message : String(error);
    console.error(
      `Redis client "${options.name}" (${redactUrl(options.url)}): ${message}` +
      (suppressed > 0 ? ` (${suppressed} more errors since the last report)` : ''),
    );
    lastLoggedAt = now;
    suppressed = 0;
  };
  client.on('error', (error: unknown) => {
    failing = true;
    logError(error);
  });
  client.on('ready', () => {
    if (failing) {
      console.log(`Redis client "${options.name}" (${redactUrl(options.url)}) is connected again`);
      failing = false;
      lastLoggedAt = 0;
      suppressed = 0;
    }
  });

  // `@socket.io/redis-emitter` and `@socket.io/redis-adapter` call
  // `publish()` without awaiting or catching it. During an outage the queued
  // PUBLISH fails after the command timeout, and that rejection would be
  // unhandled — which `api` and `wsapi` (and Node's default) answer by exiting.
  // Attaching a handler here marks every publish promise as handled; callers
  // that do await it still see the rejection.
  // (typed read-only by node-redis, hence defineProperty)
  const publish = client.publish.bind(client);
  const guardedPublish = (...args: Parameters<typeof publish>) => {
    const result = publish(...args);
    result.catch((error: unknown) => logError(error));
    return result;
  };
  Object.defineProperty(client, 'publish', { value: guardedPublish, configurable: true, writable: true });

  return client;
}

/**
 * Rejects after `ms` if `promise` has not settled — for MULTI / pipeline
 * chains, which node-redis 6 queues without a command timeout. The chain
 * itself stays queued and runs if the connection comes back; only the caller
 * stops waiting.
 */
export function withTimeout<T>(promise: Promise<T>, what: string, ms = COMMAND_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Redis ${what} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Host and port only — a REDIS_URL may carry credentials. */
function redactUrl(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid url';
  }
}

export type CgRedisClient = ReturnType<typeof createRedisClient>;
