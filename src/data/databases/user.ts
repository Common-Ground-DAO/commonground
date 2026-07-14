// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import userApi from "../api/user";
import { Dexie } from "dexie";
import AbstractDatabase, { IdbSetupInfo } from "./abstractDatabase";
import loginManager from "../appstate/login";
import connectionManager from "../appstate/connection";
import uniqueDb from "./unique";
import { isAppVersionNewer } from "data/util/appversion";
import dbTracker, { DbStatusObject } from "./dbTracker";
import config from "common/config";
import _ from "lodash";

const STALE_AFTER = 60_000;
type RetrievalKey = 'userDataById';

class UserDatabase extends AbstractDatabase<{
  userData: Dexie.Table<Models.User.Data, string>;
  status: Dexie.Table<DbStatusObject, DbStatusObject["id"]>;
}, RetrievalKey> {
  private walletsRetrievalPromise?: Promise<void>;
  private userDataLastUpdateMap = new Map<string, Date>();
  private ready!: Promise<void>;
  private isReady = false;

  constructor() {
    super('users');
  }

  protected setUpDb(info: IdbSetupInfo): void {
    this.db.version(3).stores({
      userData: '&id',
      status: '&id',
    });
    if (isAppVersionNewer({ oldAppVersion: info.createdInAppVersion, newAppVersion: "0.9.0" })) {
      // clear tables if db was created before newAppVersion
      this.ready = this.db.transaction(
        'rw',
        ['userListViews', 'userDetailViews', 'status'],
        async tx => {
          let updateState = await tx.status.get("UpdatedInAppVersion");
          if (!updateState || updateState.updatedInAppVersion !== config.APP_VERSION) {
            dbTracker.databaseHasBeenUpdated(info.idbName);
            console.log("UserDatabase: Clearing userListViews, userDetailViews table: Cleared.");
            if (!updateState) {
              updateState = {
                id: 'UpdatedInAppVersion',
                updatedInAppVersion: config.APP_VERSION,
              };
            }
            updateState.updatedInAppVersion = config.APP_VERSION;
            await Dexie.Promise.all([
              tx.userData.clear(),
              tx.status.put(updateState),
            ]);
          }
          else {
            console.log("UserDatabase: Clearing userListViews, userDetailViews table: No action required.");
          }
        },
      )
        .then(() => {
          this.isReady = true;
        });
    }
    else {
      this.isReady = true;
      this.ready = Promise.resolve();
    }
  }

  protected setUpHandlers(): void {
    connectionManager.registerClientEventHandler(
      "cliUserOwnData",
      async (event) => {
        !this.isReady && await this.ready;
        const updateData = Object.keys(event.data).reduce<any>((agg, key) => {
          agg[`data.${key}`] = (event.data as any)[key];
          return agg;
        }, {});
        const selfData = await uniqueDb.uniques.get("OwnData");
        const updates = [
          // this.db.users.update(userId, userData),
          uniqueDb.uniques.update("OwnData", updateData),
        ];

        // Updates own userdata with own data, too
        if (selfData?.key === 'OwnData' && selfData.data.id) {
          const update: Partial<Models.User.Data> = {};
          const { onlineStatus, updatedAt, displayAccount, premiumFeatures, accounts } = event.data;
          if (onlineStatus !== undefined)
            update.onlineStatus = onlineStatus;
          if (updatedAt !== undefined)
            update.updatedAt = updatedAt;
          if (displayAccount !== undefined)
            update.displayAccount = displayAccount;
          if (premiumFeatures !== undefined)
            update.premiumFeatures = premiumFeatures;
          if (accounts !== undefined)
            update.accounts = accounts.map(acc => {
              const { extraData, ...result } = acc;
              return result;
            });
          if (Object.keys(update).length > 0)
            updates.push(this.db.userData.update(selfData.data.id, update));
        }

        await Dexie.Promise.all(updates);
      }
    );
    connectionManager.registerClientEventHandler(
      "cliUserData",
      async (event) => {
        !this.isReady && await this.ready;
        const { id, updatedAt, ...updateData } = event.data;
        await this.db.userData.update(id, {
          ...updateData,
          updatedAt,
        });
      }
    );
    connectionManager.registerClientEventHandler(
      "cliWalletEvent",
      async (event) => {
        !this.isReady && await this.ready;
        await uniqueDb.transaction(
          'rw',
          ['uniques'],
          async tx => {
            const result = await tx.uniques.get("OwnWallets") as Unique.OwnWallets | undefined;
            let wallets: Models.Wallet.Wallet[];
            if (event.action === "new") {
              const { data } = event;
              const index = (result?.wallets || []).findIndex(w => w.id === data.id);
              if (index === -1) {
                wallets = [...(result?.wallets || []), data];
              }
              else {
                wallets = [...(result?.wallets || [])];
                wallets[index] = data;
              }
            }
            else if (event.action === "update") {
              const { data } = event;
              const index = (result?.wallets || []).findIndex(w => w.id === data.id);
              if (index === -1) {
                wallets = (result?.wallets || []);
                console.warn("Received update event for unknown wallet (event, knownWallets)", event, (result?.wallets || []));
              }
              else {
                wallets = [...(result?.wallets || [])];
                wallets[index] = {
                  ...wallets[index],
                  ...data,
                } as any;
              }
            }
            else if (event.action === "delete") {
              const { data } = event;
              wallets = [...(result?.wallets || [])].filter(w => w.id !== data.id);
            }
            else {
              console.error("Unknown wallet event", event);
              throw new Error("Unknown wallet event");
            }
            await tx.uniques.put({ key: "OwnWallets", wallets });
          }
        );
      }
    );
    connectionManager.registerClientEventHandler(
      "cliConnectionLost",
      event => {
        this.onConnectionLoss(event.lastKnownConnectionTime);
      }
    );
    connectionManager.registerClientEventHandler(
      "cliConnectionRestored",
      event => {
        this.onConnectionRestored();
      }
    );
  }

  protected onConnectionLoss(lastKnownConnectionTime: number): void {
    this.lastKnownConnectionTime = lastKnownConnectionTime;
  }

  protected onConnectionRestored(): void {

  }

  public async getUserData(userId?: string) {
    if (!userId) return undefined;

    const userData = await this.db.userData.get(userId);
    const lastUpdate = this.userDataLastUpdateMap.get(userId);
    if (!userData || !lastUpdate || Date.now() - lastUpdate.getTime() > STALE_AFTER) {
      this.scheduleRetrieval('userDataById', [userId]);
    }
    return userData;
  }

  public async getMultipleUserData(userIds: string[]) {
    const undefinedIndices: number[] = [];
    const filteredIds = userIds.filter((id, index) => {
      if (!id) {
        undefinedIndices.push(index);
        return false;
      }
      return true;
    });

    let userData = await this.db.userData.bulkGet(filteredIds);
    const retrievalIds = filteredIds.filter((_, i) => {
      const lastUpdate = this.userDataLastUpdateMap.get(filteredIds[i]);
      return !userData[i] || !lastUpdate || Date.now() - lastUpdate.getTime() > STALE_AFTER;
    });
    if (retrievalIds.length > 0) {
      this.scheduleRetrieval('userDataById', retrievalIds);
    }
    if (undefinedIndices.length > 0) {
      userData = [...userData];
      undefinedIndices.forEach(i => userData.splice(i, 0, undefined));
    }
    return userData;
  }

  public async bulkDeleteUserData(userIds: string[]) {
    await this.db.userData.bulkDelete(userIds);
  }

  private _setupPromise: Promise<void> | undefined;
  public setupAfterLogin(data: Models.User.OwnData): Promise<void> {
    if (!this._setupPromise) {
      this._setupPromise = new Promise<void>(async (resolve, reject) => {
        let rejected = false;
        const susTimeout = setTimeout(() => {
          console.log("UserDatabase.setupAfterLogin is taking longer than 7s, cancelling login...");
          rejected = true;
          reject(new Error("UserDatabase.setupAfterLogin timed out"));
        }, 7_000);
    
        try {
          !this.isReady && await this.ready;
          const tmp = await uniqueDb.uniques.get("OwnData") as (Unique.Object & { key: "OwnData" }) | undefined;
          const current = tmp?.data;
      
          const changed = (
            !current ||
            current.id !== data.id ||
            current.displayAccount !== data.displayAccount ||
            current.followingCount !== data.followingCount ||
            current.followerCount !== data.followerCount ||
            current.newsletter !== data.newsletter ||
            current.email !== data.email ||
            current.trustScore !== data.trustScore ||
            current.onlineStatus !== data.onlineStatus ||
            current.updatedAt !== data.updatedAt ||
            current.pointBalance !== data.pointBalance ||
            !_.isEqual(current.accounts, data.accounts) ||
            !_.isEqual(current.finishedTutorials, data.finishedTutorials) ||
            !_.isEqual(current.communityOrder, data.communityOrder) ||
            !_.isEqual(current.premiumFeatures, data.premiumFeatures) ||
            !_.isEqual(current.passkeys, data.passkeys) ||
            !_.isEqual(current.features, data.features) ||
            !_.isEqual(current.extraData, data.extraData)
          );

          if (changed) {
            if (!!current) {
              console.log("OwnData has changed, updating db entry. Old, New:", current, data);
            }
            await uniqueDb.uniques.put({ key: "OwnData", data });

            // clear user db if own user was switched or login is new
            if (!current || current.id !== data.id) {
              this.userDataLastUpdateMap.clear();
              await this.db.userData.clear();
            }
          } else {
            console.log("OwnData didn't change, no update required");
          }

          this.retrieveWallets().catch(e => {
            console.log("Error while retrieving own wallets", e);
          });
        }
        catch (e) {
          clearTimeout(susTimeout);
          rejected = true;
          reject(e);
        }
        finally {
          if (!rejected) {
            clearTimeout(susTimeout);
            resolve();
          }
          delete this._setupPromise;
        }
      });
    }
    return this._setupPromise;
  }

  public async clear() {
    !this.isReady && await this.ready;
    this.userDataLastUpdateMap.clear();
    await Dexie.Promise.all([
      uniqueDb.uniques.bulkDelete(["OwnData", "OwnWallets"]),
      this.db.userData.clear(),
    ]);
  }

  public async getOwnData(): Promise<Models.User.OwnData | undefined> {
    const result = await (uniqueDb.uniques.get("OwnData")) as Unique.OwnData | undefined;
    return result?.data;
  }

  public async getOwnWallets(): Promise<Models.Wallet.Wallet[] | undefined> {
    const result = await (uniqueDb.uniques.get("OwnWallets")) as Unique.OwnWallets | undefined;
    return result?.wallets;
  }

  public async createUser(data: Omit<API.User.createUser.Request, 'device'>) {
    !this.isReady && await this.ready;
    return await loginManager.createUser(data);
  }

  public async updateOwnData(userData: API.User.updateOwnData.Request) {
    !this.isReady && await this.ready;
    await userApi.updateOwnData(userData);
    const updateData = Object.keys(userData).reduce<any>((agg, key) => {
      // this "trick" only sets the inner attributes instead
      // of replacing the data object completely, otherwise
      // existing properties would be deleted when not present
      // in the update
      if ((userData as any)[key] !== undefined) {
        agg[`data.${key}`] = (userData as any)[key];
      }
      return agg;
    }, {});
    await Dexie.Promise.all([
      // this.db.users.update(userId, userData),
      uniqueDb.uniques.update("OwnData", updateData),
    ]);
  }

  public async subscribeNewsletter(email: string) {
    await userApi.subscribeNewsletter({ email });
  }

  public async unsubscribeNewsletter(email: string) {
    await userApi.unsubscribeNewsletter({ email });
  }

  private followPromises: {
    [userId: string]: Promise<void>;
  } = {};
  public async follow(userId: string) {
    !this.isReady && await this.ready;
    if (this.followPromises[userId] === undefined && this.unfollowPromises[userId] === undefined) {
      this.followPromises[userId] = (async () => {
        await this.db.userData.update(userId, {
          isFollowed: true,
        });
        try {
          await userApi.followUser({ userId });
        }
        catch (e) {
          await this.db.userData.update(userId, {
            isFollowed: false,
          });
        }
      })();
    }
    try {
      await this.followPromises[userId];
    }
    finally {
      delete this.followPromises[userId];
    }
  }

  private unfollowPromises: {
    [userId: string]: Promise<void>;
  } = {};
  public async unfollow(userId: string) {
    !this.isReady && await this.ready;
    if (this.followPromises[userId] === undefined && this.unfollowPromises[userId] === undefined) {
      this.unfollowPromises[userId] = (async () => {
        await this.db.userData.update(userId, {
          isFollowed: false,
        });
        try {
          await userApi.unfollowUser({ userId });
        }
        catch (e) {
          await this.db.userData.update(userId, {
            isFollowed: true,
          });
        }
      })();
    }
    try {
      await this.unfollowPromises[userId];
    }
    finally {
      delete this.unfollowPromises[userId];
    }
  }

  protected clientEventHandler(events: (Events.User.Event | Events.Application.Event)[]): void {
    for (const event of events) {
      switch (event.type) {

        case "cliConnectionLost": {
          this.onConnectionLoss(event.lastKnownConnectionTime);
          break;
        }
        case "cliConnectionRestored": {
          this.onConnectionRestored();
          break;
        }
      }
    }
  }

  protected async retrieveMissing(key: RetrievalKey, values: string[]): Promise<void> {
    if (key === 'userDataById') {
      if (values.some(v => !v)) {
        console.warn("Only userIds allowed, but received: ", values);
        values = values.filter(v => !!v);
      }
      let lastUpdate = new Date();
      const users = await userApi.getUserData({ userIds: values });
      const missingIds = values.filter((_, i) => !users[i]);
      for (const missing of missingIds) {
        users.push({
          id: missing,
          isBot: false,
          premiumFeatures: [],
          isFollowed: false,
          isFollower: false,
          createdAt: new Date(0).toISOString(),
          updatedAt: new Date(0).toISOString(),
          onlineStatus: 'offline',
          displayAccount: 'cg',
          bannerImageId: null,
          tags: null,
          accounts: [{
            type: 'cg',
            displayName: '<missing-user>',
            imageId: null,
          }],
          followerCount: 0,
          followingCount: 0,
        });
      }
      for (const user of users) {
        this.userDataLastUpdateMap.set(user.id, lastUpdate);
      }
      await this.db.userData.bulkPut(users);
    }
  }

  protected async retrieveWallets() {
    if (!this.walletsRetrievalPromise) {
      this.walletsRetrievalPromise = userApi.getWallets({})
        .then(async (wallets) => {
          await uniqueDb.uniques.put({ key: "OwnWallets", wallets });
        })
        .catch(e => {
          console.error("Error saving own wallets", e)
        })
        .finally(() => {
          delete this.walletsRetrievalPromise;
        });
    }
  }
}

const usersDatabase = new UserDatabase();
export default usersDatabase;
