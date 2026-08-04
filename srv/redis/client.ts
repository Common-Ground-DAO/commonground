// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { createClient } from 'redis';

/**
 * Single place where a node-redis client is constructed, so every connection in
 * this process shares the same protocol settings — and so the client type has
 * one name instead of being spelled `ReturnType<typeof createClient>` (which,
 * since node-redis 6, no longer describes *our* clients: the type carries a
 * RESP-version generic that defaults to 3).
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
 * (Measured 2026-08-04 against redis 6.2.7 — the version this stack runs — and
 * redis 8.10: both still answer `PUBSUB NUMSUB` with a flat array even on a
 * RESP3 connection, so that specific hazard is latent rather than live. The pin
 * stands anyway; adopting RESP3 is its own change with its own verification.)
 */
export function createRedisClient(options: { url: string; password?: string }) {
  return createClient({
    url: options.url,
    password: options.password,
    RESP: 2,
  });
}

export type CgRedisClient = ReturnType<typeof createRedisClient>;
