// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { renameSync, rmSync, writeFileSync } from 'fs';
import net from 'net';
import type { Pool } from 'pg';

/**
 * Container health of a backend process (docs/infrastructure/README.md,
 * "Backend health checks").
 *
 * Every backend process runs the probes it depends on every 10 s and writes
 * the outcome to `healthcheck.txt` in its working directory (`/dist`): `ok`, or
 * `fail` plus one line per failed probe. The image's `HEALTHCHECK`
 * (`healthcheck/healthcheck.sh`) reports healthy only while that file says
 * `ok` and was written within the last 30 s — so a process whose event loop
 * hangs, or whose probes hang, turns unhealthy as well. Docker keeps the
 * script's output, so `docker inspect` shows which probe failed.
 *
 * A probe whose last attempt has not settled yet is not started again (a hung
 * database connection must not take one more pool client every round); it
 * counts as failed once it has been pending for `PROBE_TIMEOUT_MS`.
 *
 * This module imports neither the Redis manager nor anything else that holds
 * connections; the Valkey probe lives in `redis/healthProbe.ts`, so a process
 * that does not use Valkey (memberlist) never loads it.
 */

export type HealthProbe = {
  /** short name for the report, e.g. "postgres" */
  name: string;
  /** resolves when healthy, rejects (or throws) with the reason otherwise */
  check: () => Promise<unknown>;
};

const HEALTH_FILE = './healthcheck.txt';
const INTERVAL_MS = 10_000;
const PROBE_TIMEOUT_MS = 5_000;

type ProbeState = {
  probe: HealthProbe;
  /** start time of the attempt that has not settled yet */
  pendingSince?: number;
  /** reason of the last settled attempt's failure; undefined = it passed */
  lastError?: string;
};

let started = false;

// A container restart keeps its filesystem: a report the previous run left
// behind must not count until this process has written its own (the image's
// start period covers the time until then).
rmSync(HEALTH_FILE, { force: true });

function reason(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  // one line, bounded: it ends up in the health log of `docker inspect`
  return text.replace(/\s+/g, ' ').slice(0, 200) || 'failed';
}

/** Runs the probe unless its last attempt is still pending; waits at most PROBE_TIMEOUT_MS. */
function runProbe(state: ProbeState): Promise<void> {
  if (state.pendingSince !== undefined) {
    return Promise.resolve();
  }
  state.pendingSince = Date.now();
  const attempt = Promise.resolve()
    .then(() => state.probe.check())
    .then(
      () => { state.lastError = undefined; },
      (error) => { state.lastError = reason(error); },
    )
    .finally(() => { state.pendingSince = undefined; });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(resolve, PROBE_TIMEOUT_MS);
    timer.unref();
  });
  return Promise.race([attempt, timeout]).finally(() => clearTimeout(timer));
}

function report(states: ProbeState[]): string {
  const now = Date.now();
  const failures: string[] = [];
  for (const state of states) {
    if (state.pendingSince !== undefined) {
      failures.push(`${state.probe.name}: no answer for ${Math.round((now - state.pendingSince) / 1000)} s`);
    } else if (state.lastError !== undefined) {
      failures.push(`${state.probe.name}: ${state.lastError}`);
    }
  }
  return failures.length === 0 ? 'ok\n' : `fail\n${failures.join('\n')}\n`;
}

function writeReport(text: string) {
  try {
    // rename, so the healthcheck script never reads a half-written file
    writeFileSync(`${HEALTH_FILE}.tmp`, text);
    renameSync(`${HEALTH_FILE}.tmp`, HEALTH_FILE);
  } catch (e) {
    console.error('healthcheck: could not write', HEALTH_FILE, e);
  }
}

/**
 * Starts the periodic health report of this process (once per process).
 * `probes` are what "healthy" means for it, e.g. the database, Valkey and its
 * own listener.
 */
export function startHealthcheck(probes: HealthProbe[]): void {
  if (started) return;
  started = true;
  const states: ProbeState[] = probes.map((probe) => ({ probe }));
  const round = async () => {
    await Promise.all(states.map(runProbe));
    writeReport(report(states));
    setTimeout(round, INTERVAL_MS).unref();
  };
  void round();
}

/** The process's PostgreSQL pool answers a query. */
export function postgresProbe(pool: Pool): HealthProbe {
  return {
    name: 'postgres',
    check: () => pool.query('SELECT 1'),
  };
}

/** Something accepts TCP connections on this port (the process's own listener). */
export function listenerProbe(port: number, host = '127.0.0.1'): HealthProbe {
  return {
    name: `listener :${port}`,
    check: () => new Promise<void>((resolve, reject) => {
      const socket = net.connect({ port, host });
      socket.setTimeout(PROBE_TIMEOUT_MS);
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('timeout', () => { socket.destroy(); reject(new Error('connect timed out')); });
      socket.once('error', (error) => { socket.destroy(); reject(error); });
    }),
  };
}
