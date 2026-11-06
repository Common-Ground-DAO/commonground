// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Dexie } from "dexie";
import AbstractDatabase, { IdbSetupInfo } from "./abstractDatabase";
import fileApi from "../api/file";
import connectionManager from "../appstate/connection";
import urlConfig from "../util/urls";

type SignedUrlEntry = {
  objectId: string;
  url: string;
  validUntil: Date;
};

type RetrievalKey = 'signedUrlsByFileId';

class SignedUrlDatabase extends AbstractDatabase<{
  signedUrls: Dexie.Table<SignedUrlEntry>;
}, RetrievalKey> {
  private urlCache = new Map<string, SignedUrlEntry>();

  constructor() {
    super('signedUrl');
    if (!this.localData) {
      // a gateway never opens the database
      return;
    }
    // delete stale urls
    this.db.signedUrls.filter(entry => {
      return entry.validUntil === null || entry.validUntil <= new Date();
    }).delete().then((deleteCount) => {
      console.log(`Deleted ${deleteCount} stale or invalid URLs from db`);
      return this.db.signedUrls.toArray();
    }).then(urls => {
      for (const url of urls) {
        this.urlCache.set(url.objectId, url);
      }
    });
  }

  protected setUpDb(info: IdbSetupInfo): void {
    this.db.version(1).stores({
      signedUrls: '&objectId,validUntil', // indexed props
    });
  }

  protected setUpHandlers(): void {
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

  private __objectIdsToRefresh: Set<string> = new Set();
  private __refreshPromise: Promise<void> | undefined;
  protected async scheduleSignedUrlRefresh(objectIds?: string[]) {
    if (objectIds) {
      for (const objectId of objectIds) {
        this.__objectIdsToRefresh.add(objectId);
      }
    }
    if (!this.__refreshPromise) {
      this.__refreshPromise = new Promise<void>(async (resolve, reject) => {
        await new Promise(resolve => setTimeout(resolve, 100));
        const idsToRefresh = Array.from(this.__objectIdsToRefresh);
        this.__objectIdsToRefresh.clear();
        if (idsToRefresh.length > 0) {
          try {
            await this.db.signedUrls.bulkDelete(idsToRefresh);
            this.scheduleRetrieval('signedUrlsByFileId', idsToRefresh);
            resolve();
          }
          catch (e) {
            for (const id of idsToRefresh) {
              this.__objectIdsToRefresh.add(id);
            }
            reject(e);
          }
        }
      }).finally(() => {
        delete this.__refreshPromise;
      });
    }
    try {
      await this.__refreshPromise;
    }
    finally {
      if (this.__objectIdsToRefresh.size > 0) {
        this.scheduleSignedUrlRefresh();
      }
    }
  }

  protected async retrieveMissing(key: RetrievalKey, values: string[]): Promise<void> {
    if (key === 'signedUrlsByFileId') {
      const result = await fileApi.getSignedUrls({ objectIds: values });
      const signedUrls = result.map(item => ({
        ...item,
        validUntil: new Date(item.validUntil),
      }));
      const missingIds = new Set(values);
      for (const signedUrl of signedUrls) {
        missingIds.delete(signedUrl.objectId);
        this.urlCache.set(signedUrl.objectId, signedUrl);
      }
      for (const missing of Array.from(missingIds)) {
        const data = {
          objectId: missing,
          url: `${urlConfig.APP_URL}/missing.jpg`,
          validUntil: new Date(Date.now() + (10 * 60 * 1000)), // re-request in 10m
        };
        this.urlCache.set(data.objectId, data);
        signedUrls.push(data);
      }
      await this.db.signedUrls.bulkPut(signedUrls);
    }
  }

  public getFromCache(fileId: string) {
    const fromCache = this.urlCache.get(fileId);
    if (fromCache) {
      if (
        (!!fromCache.validUntil && fromCache.validUntil < new Date()) &&
        connectionManager.onlineState === "online"
      ) {
        this.urlCache.delete(fileId);
      } else {
        return fromCache;
      }
    }
  }

  public async getSignedUrl(fileId: string) {
    if (!fileId) {
      console.warn("getSignedUrl called with falsy value. See below console.trace() output");
      console.trace();
      return;
    };
    const fromCache = this.getFromCache(fileId);
    if (fromCache) {
      return fromCache;
    }
    const signedUrl = await this.db.signedUrls.get(fileId);
    if (!!signedUrl) {
      if (!!signedUrl.validUntil) {
        if (signedUrl.validUntil < new Date()) {
          setTimeout(() => {
            this.scheduleSignedUrlRefresh([fileId]);
          }, 1);
        } else {
          this.urlCache.set(fileId, signedUrl);
          return signedUrl;
        }
      } else {
        this.urlCache.set(fileId, signedUrl);
        return signedUrl; // validUntil (and probably url) are null -> file doesn't exist
      }
    }
    this.scheduleRetrieval('signedUrlsByFileId', [fileId]);
  }

  public async getSignedUrls(fileIds: string[]): Promise<(SignedUrlEntry | undefined)[]> {
    if (!fileIds) {
      console.warn("getSignedUrl called with falsy value. See below console.trace() output");
      console.trace();
      return [];
    };
    const { fromCache, missing } = fileIds.reduce<{ fromCache: SignedUrlEntry[], missing: string[] }>((agg, fileId) => {
      const result = this.getFromCache(fileId);
      if (!!result) {
        agg.fromCache.push(result);
      } else {
        agg.missing.push(fileId);
      }
      return agg;
    }, { fromCache: [], missing: [] });
    if (missing.length === 0) {
      return fromCache;
    }

    const receivedSignedUrls: Map<string, SignedUrlEntry> = new Map(fromCache.map(item => [item.objectId, item]));
    const signedUrls = await this.db.signedUrls.bulkGet(missing);
    const scheduleMissingIds: Set<string> = new Set();
    for (let i = 0; i < missing.length; i++) {
      const fileId = missing[i];
      const signedUrl = signedUrls[i];
      if (!signedUrl || (!!signedUrl.validUntil && signedUrl.validUntil < new Date())) {
        scheduleMissingIds.add(fileId);
      } else {
        receivedSignedUrls.set(fileId, signedUrl);
        this.urlCache.set(fileId, signedUrl);
      }
    }
    if (scheduleMissingIds.size > 0) {
      this.scheduleRetrieval('signedUrlsByFileId', Array.from(scheduleMissingIds));
    }
    return fileIds.map(fileId => receivedSignedUrls.get(fileId));
  }

  public async getSignedUrlAwaitRetrieval(fileId: string) {
    let result: SignedUrlEntry | undefined;
    let tries = 0;
    while (!result && tries <= 3) {
      result = await this.getSignedUrl(fileId);
      if (result === undefined) {
        await this.awaitNextRetrieval('signedUrlsByFileId');
      }
    }
    if (!result) {
      throw new Error("SignedUrl could not be loaded");
    }
    return result;
  }
}

const signedUrlDatabase = new SignedUrlDatabase();
export default signedUrlDatabase;