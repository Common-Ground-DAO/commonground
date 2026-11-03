// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import config from "common/config";
import { isAppVersionNewer } from "data/util/appversion";
import { isObsoleteDatabase } from "./obsoleteDatabases";

const identifier = "CG_KNOWN_INDEXEDDBS";

type DbInfo = {
    createdInAppVersion: string;
    createdAtTime: number;
}

export type DbStatusObject = {
    id: 'UpdatedInAppVersion';
    updatedInAppVersion: string;
};

class DbTracker {
    private existingDatabases: {
        [dbName: string]: DbInfo,
    };

    constructor() {
        this.existingDatabases = JSON.parse(localStorage.getItem(identifier) || '{}');
        const storageListener = (event: StorageEvent) => {
            if (event.key === identifier) {
                if (!event.newValue) {
                    console.error('Received falsy value for CG_KNOWN_INDEXEDDBS, this is not expected.');
                }
                else {
                    const oldValue = event.oldValue === null ? null : JSON.parse(event.oldValue) as typeof this.existingDatabases;
                    const newValue = JSON.parse(event.newValue as string) as typeof this.existingDatabases;
                    const updatedDbNames = new Set<string>();
                    const oldNames = Object.keys(oldValue || {});
                    const newNames = Object.keys(newValue);
                    for (const oldName of oldNames) {
                        updatedDbNames.add(oldName);
                        const ownDbInfo = this.existingDatabases[oldName] as DbInfo | undefined;
                        const newDbInfo = newValue[oldName] as DbInfo | undefined;
                        if (newDbInfo === undefined) {
                            if (isObsoleteDatabase(oldName)) {
                                // another tab deleted it (forgetDatabase, obsoleteDatabases.ts)
                                delete this.existingDatabases[oldName];
                            }
                            else {
                                // a live database: keep it (another tab's write may have raced a registerDatabase)
                                console.warn("dbInfo is gone from new localstorage object, this should not happen for now");
                            }
                        }
                        else {
                            if (newDbInfo.createdInAppVersion !== ownDbInfo?.createdInAppVersion) {
                                if (!ownDbInfo) {
                                    this.existingDatabases[oldName] = newDbInfo;
                                }
                                else if (isAppVersionNewer({ oldAppVersion: ownDbInfo.createdInAppVersion, newAppVersion: newDbInfo.createdInAppVersion })) {
                                    ownDbInfo.createdInAppVersion = newDbInfo.createdInAppVersion;
                                    ownDbInfo.createdAtTime = newDbInfo.createdAtTime;
                                }
                            }
                        }
                    }
                    for (const newName of newNames) {
                        if (!updatedDbNames.has(newName)) {
                            updatedDbNames.add(newName);
                            const ownDbInfo = this.existingDatabases[newName] as DbInfo | undefined;
                            const newDbInfo = newValue[newName];
                            if (newDbInfo.createdInAppVersion !== ownDbInfo?.createdInAppVersion) {
                                if (!ownDbInfo) {
                                    this.existingDatabases[newName] = newDbInfo;
                                }
                                else if (isAppVersionNewer({ oldAppVersion: ownDbInfo.createdInAppVersion, newAppVersion: newDbInfo.createdInAppVersion })) {
                                    ownDbInfo.createdInAppVersion = newDbInfo.createdInAppVersion;
                                    ownDbInfo.createdAtTime = newDbInfo.createdAtTime;
                                }
                            }
                        }
                    }
                    const saveRequired = Object.keys(this.existingDatabases).some(name => !updatedDbNames.has(name));
                    if (saveRequired) {
                        localStorage.setItem(identifier, JSON.stringify(this.existingDatabases)); 
                    }
                }
                // console.log("Updated dbTracker.existingDatabases by localstorage listener");
                // console.log("New value:", this.existingDatabases);
                // console.log("Applied update:", event.newValue);
            }
        };
        window.addEventListener("storage", storageListener);
    }

    public registerDatabase(dbName: string) {
        let dbInfo = this.existingDatabases[dbName] as DbInfo | undefined;
        let createdInOldAppVersion: boolean;
        if (!dbInfo) {
            createdInOldAppVersion = true;
            dbInfo = {
                createdInAppVersion: config.APP_VERSION,
                createdAtTime: Date.now(),
            };
            this.existingDatabases[dbName] = dbInfo;
            localStorage.setItem(identifier, JSON.stringify(this.existingDatabases));
        }
        else {
            createdInOldAppVersion = dbInfo.createdInAppVersion !== config.APP_VERSION;
        }
        return {
            createdAt: new Date(dbInfo.createdAtTime),
            createdInOldAppVersion,
            createdInAppVersion: dbInfo.createdInAppVersion,
        };
    }

    public databaseHasBeenUpdated(dbName: string) {
        let dbInfo = this.existingDatabases[dbName] as DbInfo | undefined;
        if (!!dbInfo) {
            dbInfo = {
                createdInAppVersion: config.APP_VERSION,
                createdAtTime: Date.now(),
            };
            this.existingDatabases[dbName] = dbInfo;
            localStorage.setItem(identifier, JSON.stringify(this.existingDatabases));
        }
        else {
            throw new Error("That database does not exist")
        }
    }

    /** Names of the databases this browser registered (incl. ones that may no longer exist). */
    public knownDatabaseNames(): string[] {
        return Object.keys(this.existingDatabases);
    }

    /** Drops a deleted database from the registry (see obsoleteDatabases.ts). */
    public forgetDatabase(dbName: string) {
        if (!(dbName in this.existingDatabases)) return;
        delete this.existingDatabases[dbName];
        localStorage.setItem(identifier, JSON.stringify(this.existingDatabases));
    }
}

const dbTracker = new DbTracker();
export default dbTracker;