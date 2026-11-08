// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * A database on the throwaway PostgreSQL of the real-PostgreSQL specs
 * (tests/helpers/testPg.ts) with the real schema: every migration of
 * srv/migrations, in timestamp order and in one transaction (transaction
 * mode "all", as migrateDb runs them), optionally only those before a given
 * timestamp. Tables, indexes, constraints and triggers are those of a
 * migrated production database. The roles the migrations grant to are
 * created cluster-wide if missing: `writer` and `reader` without login (the
 * specs that log in as them set a password), `mediasoup` by its migration.
 */

import fs from 'fs';
import path from 'path';
import { Pool } from 'pg';
import { DataSource, MigrationInterface } from 'typeorm';
import { TEST_PG_HOST, TEST_PG_PORT, TEST_PG_PASSWORD } from './testPg';

const MIGRATIONS_DIR = path.join(__dirname, '..', '..', 'migrations');

/** the migration classes of srv/migrations with a timestamp below `before`, in order */
function migrationClasses(before?: number): (new () => MigrationInterface)[] {
  const files = fs.readdirSync(MIGRATIONS_DIR)
    .filter(f => /^\d+-.+\.ts$/.test(f) && !f.endsWith('.d.ts'))
    .filter(f => before === undefined || Number(f.split('-')[0]) < before)
    .sort((a, b) => Number(a.split('-')[0]) - Number(b.split('-')[0]));
  const classes: (new () => MigrationInterface)[] = [];
  for (const file of files) {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const exported = require(path.join(MIGRATIONS_DIR, file));
    for (const value of Object.values(exported)) {
      if (typeof value === 'function') {
        classes.push(value as new () => MigrationInterface);
      }
    }
  }
  return classes;
}

/**
 * (Re)creates `database` and runs the migration chain on it. `server` is a
 * pool on the `postgres` database of the throwaway server.
 */
export async function createMigratedDatabase(server: Pool, database: string, options: { before?: number } = {}): Promise<void> {
  await server.query(`DROP DATABASE IF EXISTS ${database} WITH (FORCE)`);
  await server.query(`CREATE DATABASE ${database}`);
  for (const role of ['writer', 'reader']) {
    await server.query(`DO $$ BEGIN IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN CREATE ROLE ${role}; END IF; END $$`);
  }
  // addMediasoupRole creates the role `mediasoup` where it is missing, with
  // this password — the one the other real-PostgreSQL specs log in with
  process.env.PG_MEDIASOUP_PASSWORD ||= 'mediasoup-test';

  const dataSource = new DataSource({
    type: 'postgres',
    host: TEST_PG_HOST,
    port: TEST_PG_PORT,
    username: 'postgres',
    password: TEST_PG_PASSWORD,
    database,
    schema: 'public',
    migrations: migrationClasses(options.before),
    migrationsTransactionMode: 'all',
    synchronize: false,
    uuidExtension: 'pgcrypto',
    logging: false,
  });
  await dataSource.initialize();
  const log = jest.spyOn(console, 'log').mockImplementation(() => undefined);
  try {
    await dataSource.runMigrations();
  } finally {
    log.mockRestore();
    await dataSource.destroy();
  }
}
