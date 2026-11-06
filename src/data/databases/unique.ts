// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Dexie } from "dexie";
import config from "common/config";
import dbTracker from "./dbTracker";
import { isGatewayInstance } from "common/gateway";

const __dbName = `${config.IDB_PREFIX}_uniques`;

const uniqueDb: Dexie & {
  uniques: Dexie.Table<Unique.Object, Unique.Object["key"]>
} = new Dexie(__dbName) as any;
// a gateway (docs/auth-identity §12) leaves the database registry of an old
// page of the app as it is (abstractDatabase.ts); it only reads the stored
// account (`OwnData`) here for the device-key sign-in (login.ts)
if (!isGatewayInstance()) {
  dbTracker.registerDatabase(__dbName);
}

uniqueDb.version(1).stores({
  uniques: '&key'
});

export default uniqueDb;