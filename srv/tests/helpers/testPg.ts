// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Connection target of the opt-in real-PostgreSQL specs (`*Db.spec.ts`).
 *
 * The specs run only when `CG_TEST_PG_HOST` is set, and then they connect
 * only to `CG_TEST_PG_HOST`:`CG_TEST_PG_PORT`. There is no default port and
 * no fallback to `DB_PORT`, `PGPORT` or 5432: a spec must never reach
 * another PostgreSQL on the machine (a dev stack, another agent's
 * container). Every Pool a spec opens, and every `util/postgres` it loads,
 * gets host and port from here explicitly.
 */

const host = process.env.CG_TEST_PG_HOST || undefined;

function portFromEnv(): number | undefined {
  if (!host) {
    return undefined;
  }
  const raw = process.env.CG_TEST_PG_PORT;
  const port = Number(raw);
  if (!raw || !Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(
      'CG_TEST_PG_HOST is set, so CG_TEST_PG_PORT must name the port of the throwaway '
      + 'PostgreSQL (there is no default, so a test never reaches another server)',
    );
  }
  return port;
}

/** set when the real-PostgreSQL specs should run */
export const TEST_PG_HOST = host;
/** the throwaway server's port; set whenever TEST_PG_HOST is */
export const TEST_PG_PORT = portFromEnv();
/** password of the superuser `postgres` on the throwaway server */
export const TEST_PG_PASSWORD = process.env.CG_TEST_PG_PASSWORD || 'pw';

/** `describe` when a throwaway server is configured, `describe.skip` otherwise */
export const describeDb = TEST_PG_HOST ? describe : describe.skip;
