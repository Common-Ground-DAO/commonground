// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "reflect-metadata"
import { DataSource, DataSourceOptions } from "typeorm"
import { PostgresConnectionCredentialsOptions } from "typeorm/driver/postgres/PostgresConnectionCredentialsOptions";
import { dockerSecret } from ".";
import path from "path";

// SSL config
const ssl_ca = dockerSecret('rootca.crt') || null;
const ssl_key = dockerSecret('appservers.key') || null;
const ssl_cert = dockerSecret('appservers.crt') || null;

export const connectionOptions: DataSourceOptions = {
  type: "postgres",
  host: process.env.DB_HOST || 'db',
  port: Number(process.env.DB_PORT) || 5432,
  username: process.env.PG_SU_NAME || process.env.DB_TYPE || 'cryptoadmin',
  database: 'cryptogram',
  schema: 'public',
  password: dockerSecret('pg_su_password') || dockerSecret('pg_password') || process.env.PG_SU_PASSWORD || process.env.PG_PASSWORD,
  entities: [path.join(__dirname, '..', 'entities', '*.js')],
  migrations: [path.join(__dirname, '..', 'migrations', '*.js')],
  synchronize: false,
  uuidExtension: 'pgcrypto'
};

if (ssl_ca && ssl_key && ssl_cert) {
  const sslOptions: PostgresConnectionCredentialsOptions["ssl"] = {
    requestCert: true,
    rejectUnauthorized: true,
    ca: ssl_ca,
    key: ssl_key,
    cert: ssl_cert
  };
  (connectionOptions as any).ssl = sslOptions;
}

export const ormDataSource = new DataSource(connectionOptions);

// Connected on first use (migrateDb.ts), not on import: the TypeORM CLI
// (tools/makeMigration.sh, revertLastMigration.sh, testEntities.sh) loads
// this file and initializes `ormDataSource` itself, and TypeORM 1.x refuses
// a second initialize() while one is in flight.
let dataSourcePromise: Promise<DataSource> | undefined;
export function getDataSource(): Promise<DataSource> {
  dataSourcePromise ??= ormDataSource.initialize();
  return dataSourcePromise;
}
