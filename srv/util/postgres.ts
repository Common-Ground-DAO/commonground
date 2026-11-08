// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { ClientConfig, Pool, PoolConfig } from "pg";
import { dockerSecret } from ".";
import { describeErrorForLog } from "./errorLog";

// SSL config
const ssl_ca = dockerSecret('rootca.crt') || null;
const ssl_key = dockerSecret('appservers.key') || null;
const ssl_cert = dockerSecret('appservers.crt') || null;

/** node-postgres' own default */
export const DEFAULT_POOL_MAX = 10;

/**
 * Connections this process's pool may open (PG_POOL_MAX; each job-runner
 * worker thread has a pool of its own). The compose files set it per service
 * so that every process of the main instance and the gateway together stay
 * below the server's max_connections (docker/db/postgresql.conf). A value
 * that is not a positive integer stops the process.
 */
export function poolMaxFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const raw = env.PG_POOL_MAX?.trim();
  if (!raw) {
    return DEFAULT_POOL_MAX;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`PG_POOL_MAX must be a positive integer, got "${raw}"`);
  }
  return value;
}

const options: PoolConfig = {
  user: process.env.PG_SU_NAME || process.env.DB_TYPE || 'cryptoadmin',
  host: process.env.DB_HOST || 'db',
  database: 'cryptogram',
  password: dockerSecret('pg_su_password') || dockerSecret('pg_password') || process.env.PG_SU_PASSWORD || process.env.PG_PASSWORD,
  port: Number(process.env.DB_PORT) || 5432,
  max: poolMaxFromEnv(),
}
if (ssl_ca && ssl_key && ssl_cert) {
  const sslOptions: ClientConfig["ssl"] = {
    requestCert: true,
    rejectUnauthorized: true,
    ca: ssl_ca,
    key: ssl_key,
    cert: ssl_cert
  };
  options.ssl = sslOptions;
}

const pool = new Pool(options);

/**
 * A connection that fails — the database restarted or closed it — emits
 * `error`; without a listener that event ends the process. node-postgres
 * listens on every **idle** connection of the pool and re-emits the failure
 * as the pool's `error` event, then drops the connection, so the next query
 * opens a new one: that is logged here instead of ending the process.
 *
 * A connection a caller holds (`pool.connect()`) has no listener from the
 * pool. Its failure fails the query that runs (if any) and is then emitted
 * as the connection's own `error` event as well — also while a query runs,
 * and possibly twice. So a holder without an `error` listener ends the
 * process (in a job-runner worker thread: the worker) as an uncaught
 * exception — e.g. an api or wsapi transaction that runs while the database
 * restarts; the process restarts. The holders of long-lived LISTEN
 * connections listen themselves: memberlist, the call server (mediasoup) and
 * the job-runner's call-update worker end the process or worker, whose
 * restart registers LISTEN again; the wsapi's typing cache listens from
 * right after `pool.connect()` and sets LISTEN up again on a new connection.
 */
export function logConnectionError(error: unknown): void {
  console.error(`PostgreSQL: a pooled connection failed (${describeErrorForLog(error)})`);
}
pool.on('error', logConnectionError);

export default pool;
