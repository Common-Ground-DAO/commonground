// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { HealthProbe } from '../healthcheck';
import redisManager from './index';

/**
 * Health probe for the Valkey state instance (srv/healthcheck.ts) — the one
 * the app cannot work without; the cache instance is optional. All clients of
 * the state instance share one server, so a PING on the `data` client is
 * enough. Its first call creates that client, so a process that otherwise
 * opens no `data` connection (the job-runner's main thread; its workers have
 * their own) holds one more for it.
 */
export function valkeyProbe(): HealthProbe {
  return {
    name: 'valkey',
    check: async () => {
      // not ready = (re)connecting: fail now instead of waiting in the
      // offline queue for the command timeout
      const client = redisManager.connectedClient('data');
      if (!client) {
        throw new Error('not connected');
      }
      const answer = await client.ping();
      if (answer !== 'PONG') {
        throw new Error(`unexpected PING answer ${JSON.stringify(answer)}`);
      }
    },
  };
}
