// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Migration } from "typeorm"
import { getDataSource } from './util/datasource';
import { refuseInGatewayMode } from './util/gateway';

// runs once, for the main instance only: never as part of a gateway
// (srv/util/gateway.ts)
refuseInGatewayMode('migrate-db');

(async () => {
  try {
    const dataSource = await getDataSource();
    console.log("Data Source has been initialized!");
    const migrations = await dataSource.runMigrations();
    if (!!migrations && migrations.length > 0) {
      console.log('following migrations are loaded:');
      migrations.map((migration: Migration) => console.log(migration.name));
    }
  } catch (e) {
    console.error("Error during migration", e);
    process.exit(1);
  }
  process.exit(0);
})();
