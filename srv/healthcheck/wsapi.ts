// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { listenerProbe, postgresProbe, startHealthcheck } from '../healthcheck';
import { valkeyProbe } from '../redis/healthProbe';
import pool from '../util/postgres';

/**
 * What "healthy" means for wsapi (srv/healthcheck.ts): the database and the
 * Valkey state instance (sessions, the Socket.IO adapter) answer, and the
 * Socket.IO listener on :4000 accepts connections. Kept out of srv/wsapi.ts
 * so that file only starts it.
 */
export function startWsapiHealthcheck(): void {
  startHealthcheck([postgresProbe(pool), valkeyProbe(), listenerProbe(4000)]);
}
