// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Dexie } from "dexie";
import AbstractDatabase, { IdbSetupInfo, guardedPut, guardedUpdate, isOlderThanStored } from "./abstractDatabase";
import communityApi from "../api/community";
import connectionManager from "../appstate/connection";
import uniqueDb from "./unique";
import communityManager from "data/managers/communityManager";
import channelDatabaseManager from "data/databases/channel";
import { isAppVersionNewer } from "data/util/appversion";
import dbTracker, { DbStatusObject } from "./dbTracker";
import config from "common/config";
import { PredefinedRole, RoleType } from "common/enums";
import serviceWorkerManager from "data/appstate/serviceWorker";
import { isEqual } from "lodash";

const TAG_FREQUENCY_VALIDFOR = 120000;
const MEMBER_LIST_VALIDFOR = 60000;
const NEWMESSAGE_DEBOUNCE_INTERVAL = 500;

type CommunityMembership = {
  userId: string;
  communityId: string;
  roleIds: string[];
}

type RetrievalKey =
  'listViewsById' |
  'detailViewsById' |
  'detailViewsByUrl' |
  'membersByCommunityId';

type CommunityDatabaseTables = {
  communities: Dexie.Table<Models.Community.DetailView, string>;
  areas: Dexie.Table<Models.Community.Area, [string, string]>;
  channels: Dexie.Table<Models.Community.Channel, [string, string]>;
  roles: Dexie.Table<Models.Community.Role, [string, string]>;
  calls: Dexie.Table<Models.Calls.Call, string>;
  communityListViews: Dexie.Table<Models.Community.ListView, string>;
  communityMembers: Dexie.Table<CommunityMembership, [string, string]>;
  status: Dexie.Table<DbStatusObject, DbStatusObject["id"]>;
};

class CommunityDatabase extends AbstractDatabase<CommunityDatabaseTables, RetrievalKey> {
  private channelsUpToDate: {
    [id: string]: boolean;
  } = {};
  private memberListLastFetch = new Map<string, Date>();
  private __ready!: {
    promise: Promise<void>;
    resolve?: () => void;
  };
  private __waitForSetup = false;

  constructor() {
    super('communities');

    this.__ready = {} as any;
    this.__ready.promise = new Promise<void>(resolve => {
      if (this.__waitForSetup === false) {
        resolve();
      }
      else {
        this.__ready.resolve = resolve;
      }
    }).then(async () => {
      // initialize
      try {
        const [
          channels,
          calls,
        ] = await Dexie.Promise.all([
          this.db.channels.toArray(),
          this.db.calls.toArray(),
        ]);
        for (const channel of channels) {
          channelDatabaseManager.registerAccessForChannel({
            channelId: channel.channelId,
            communityId: channel.communityId,
          }, {
            lastRead: channel.lastRead,
          });
        }
        for (const call of calls) {
          channelDatabaseManager.registerAccessForChannel({
            callId: call.id,
            channelId: call.channelId,
            communityId: call.communityId,
          });
        }
      } catch (e) {
        console.error(`Error initializing channel access for community channels`, e);
      }
    });
  }

  protected setUpDb(info: IdbSetupInfo): void {
    this.db.version(3).stores({
      communities: '&id,url',
      areas: '&[communityId+id],id,communityId',
      channels: '&[communityId+channelId],channelId,communityId',
      roles: '&[communityId+id],[title+type],id,communityId',
      calls: '&id,communityId',
      communityListViews: '&id,url',
      communityMembers: '&[communityId+userId],communityId',
      status: '&id',
    });
    // HERE
    if (isAppVersionNewer({ oldAppVersion: info.createdInAppVersion, newAppVersion: "0.9.0" })) {
      // clear tables if db was created before newAppVersion
      this.__waitForSetup = true;
      this.db.transaction(
        'rw',
        [
          'communities',
          'areas',
          'channels',
          'roles',
          'calls',
          'communityListViews',
          'communityMembers',
          'status',
        ],
        async tx => {
          let updateState = await tx.status.get("UpdatedInAppVersion");
          if (!updateState || updateState.updatedInAppVersion !== config.APP_VERSION) {
            console.log("CommunityDatabase: Clearing community tables : Cleared.");
            dbTracker.databaseHasBeenUpdated(info.idbName);
            if (!updateState) {
              updateState = {
                id: 'UpdatedInAppVersion',
                updatedInAppVersion: config.APP_VERSION,
              };
            }
            updateState.updatedInAppVersion = config.APP_VERSION;
            tx.communities.clear();
            tx.areas.clear();
            tx.channels.clear();
            tx.roles.clear();
            tx.calls.clear();
            tx.communityListViews.clear();
            tx.communityMembers.clear();
            tx.status.put(updateState);
          }
          else {
            console.log("CommunityDatabase: Clear community tables: No action required.");
          }
        },
      ).then(() => {
        this.__ready.resolve?.();
      });
    }
    else {
      this.__waitForSetup = false;
      this.__ready?.resolve?.();
    }
  }

  protected setUpHandlers(): void {
    connectionManager.registerClientEventHandler(
      "cliCommunityEvent",
      event => {
        if (event.action === "new-or-full-update") {
          return this.addCommunity(event.data);
        }
        else if (event.action === "update") {
          return this.applyCommunityUpdate(event.data).catch(e => {
            console.error("Error handling community update event", e);
          });
        }
        else if (event.action === "delete") {
          return this.db.communities.delete(event.data.id);
        }
      }
    );
    connectionManager.registerClientEventHandler(
      "cliAreaEvent",
      event => {
        if (event.action === "new") {
          return guardedPut(this.db, this.db.areas, [event.data.communityId, event.data.id], event.data);
        }
        else if (event.action === "update") {
          return guardedUpdate(this.db, this.db.areas, [
            event.data.communityId,
            event.data.id
          ], event.data);
        }
        else if (event.action === "delete") {
          return this.db.areas.delete([
            event.data.communityId,
            event.data.id
          ]);
        }
      }
    );
    connectionManager.registerClientEventHandler(
      "cliChannelEvent",
      event => {
        if (event.action === "new") {
          channelDatabaseManager.registerAccessForChannel({
            channelId: event.data.channelId,
            communityId: event.data.communityId,
          }, {
            lastRead: event.data.lastRead,
          });
          return this.db.channels.put(event.data).then(() => {
            return channelDatabaseManager.setInitialChannelLastRead(event.data.channelId, new Date(event.data.lastRead));
          })
          .catch(e => {
            console.error("Error handling new channel event", e);
          });
        }
        else if (event.action === "update") {
          // read state (unread, lastRead, lastMessageDate) is per user and
          // only changes through the read-state merge
          const { unread, lastRead, lastMessageDate, ...changes } = event.data;
          return guardedUpdate(this.db, this.db.channels, [
            event.data.communityId,
            event.data.channelId,
          ], changes);
        }
        else if (event.action === "delete") {
          channelDatabaseManager.deleteChannelDatabase({ channelId: event.data.channelId });
          return this.db.channels.delete([
            event.data.communityId,
            event.data.channelId
          ]);
        }
      }
    );
    connectionManager.registerClientEventHandler(
      "cliRoleEvent",
      event => {
        if (event.action === "new") {
          return guardedPut(this.db, this.db.roles, [event.data.communityId, event.data.id], event.data);
        }
        else if (event.action === "update") {
          return guardedUpdate(this.db, this.db.roles, [
            event.data.communityId,
            event.data.id
          ], event.data);
        }
        else if (event.action === "delete") {
          return this.db.roles.delete([
            event.data.communityId,
            event.data.id
          ]);
        }
      }
    );
    connectionManager.registerClientEventHandler(
      "cliPluginEvent",
      event => {
        if (event.action === "new") {
          return this.db.transaction(
            'rw',
            ['communities'],
            async tx => {
              const existing = await tx.communities.get(event.data.communityId);
              if (existing) {
                // idempotent: every tab applies the same event
                const index = existing.plugins.findIndex(p => p.id === event.data.id);
                if (index === -1) {
                  existing.plugins.push(event.data);
                }
                else {
                  existing.plugins[index] = event.data;
                }
                tx.communities.put(existing);
              }
            }
          );
        }
        else if (event.action === "update") {
          return this.db.transaction(
            'rw',
            ['communities'],
            async tx => {
              const existing = await tx.communities.get(event.data.communityId);
              if (existing) {
                const pluginIndex = existing.plugins.findIndex(p => p.id === event.data.id);
                if (pluginIndex !== -1) {
                  existing.plugins[pluginIndex] = {
                    ...existing.plugins[pluginIndex],
                    ...event.data,
                  };
                }
                tx.communities.put(existing);
              }
            }
          );
        }
        else if (event.action === "dataUpdate") {
          return this.db.transaction(
            'rw',
            ['communities'],
            async tx => {
              tx.communities.each(community => {
                const pluginIndex = community.plugins.findIndex(p => p.pluginId === event.data.pluginId);
                if (pluginIndex !== -1) {
                  community.plugins[pluginIndex] = {
                    ...community.plugins[pluginIndex],
                    ...event.data,
                  };
                  tx.communities.put(community);
                }
              });
            }
          );
        }
        else if (event.action === "delete") {
          return this.db.transaction(
            'rw',
            ['communities'],
            async tx => {
              const existing = await tx.communities.get(event.data.communityId);
              if (existing) {
                existing.plugins = existing.plugins.filter(p => p.id !== event.data.id);
                tx.communities.put(existing);
              }
            }
          );
        }
        else if (event.action === "dataDelete") {
          return this.db.transaction(
            'rw',
            ['communities'],
            async tx => {
              tx.communities.each(community => {
                const pluginIndex = community.plugins.findIndex(p => p.pluginId === event.data.pluginId);
                if (pluginIndex !== -1) {
                  community.plugins.splice(pluginIndex, 1);
                  tx.communities.put(community);
                }
              });
            }
          );
        }
      }
    );
    connectionManager.registerClientEventHandler(
      "cliCallEvent",
      event => {
        if (event.action === "new") {
          return guardedPut(this.db, this.db.calls, event.data.id, event.data);
        }
        else if (event.action === "update") {
          return guardedUpdate(this.db, this.db.calls, event.data.id, event.data);
        }
        else if (event.action === "delete") {
          return this.db.calls.delete(event.data.id);
        }
      }
    );
    connectionManager.registerClientEventHandler(
      "cliMembershipEvent",
      event => {
        if (event.action === "join") {
          return this.db.communityMembers.put(event.data);
        }
        else if (event.action === "roles_added") {
          return this.db.transaction(
            'rw',
            ['communityMembers'],
            async tx => {
              const existing = await tx.communityMembers.get([event.data.communityId, event.data.userId]);
              if (existing) {
                let changed = false;
                for (const roleId of event.data.roleIds) {
                  if (existing.roleIds.indexOf(roleId) === -1) {
                    changed = true;
                    existing.roleIds.push(roleId);
                  }
                }
                if (changed) {
                  tx.communityMembers.put(existing);
                }
              }
            },
          );
        }
        else if (event.action === "roles_removed") {
          return this.db.transaction(
            'rw',
            ['communityMembers'],
            async tx => {
              const existing = await tx.communityMembers.get([event.data.communityId, event.data.userId]);
              if (existing) {
                let changed = false;
                for (const roleId of event.data.roleIds) {
                  const index = existing.roleIds.indexOf(roleId);
                  if (index > -1) {
                    changed = true;
                    existing.roleIds.splice(index, 1);
                  }
                }
                if (changed) {
                  tx.communityMembers.put(existing);
                }
              }
            },
          );
        }
        else if (event.action === "leave") {
          return this.db.communityMembers.delete([event.data.communityId, event.data.userId]);
        }
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
    for (const channelId of Object.keys(this.channelsUpToDate)) {
      this.channelsUpToDate[channelId] = false;
    }
    this.lastKnownConnectionTime = lastKnownConnectionTime;
  }

  protected onConnectionRestored(): void {

  }

  /**
   * URLs this tab has seen per community (from its own reads and writes). The
   * URL-change navigation must not depend on the shared row: another tab may
   * already have written the new URL when this tab processes the event.
   */
  private knownUrlsByCommunityId = new Map<string, Set<string>>();
  private rememberCommunityUrl(communityId: string | undefined, url: string | null | undefined) {
    if (!communityId || !url) return;
    let urls = this.knownUrlsByCommunityId.get(communityId);
    if (!urls) {
      urls = new Set();
      this.knownUrlsByCommunityId.set(communityId, urls);
    }
    urls.add(url);
  }

  private async applyCommunityUpdate(data: Extract<Events.Community.Community, { action: 'update' }>['data']) {
    const omitListView: (keyof Models.Community.DetailViewFromApi)[] = [
      "calls",
      "channels",
      "areas",
      "roles",
      "description",
      "logoLargeId",
      "links",
      "creatorId",
      "myRoleIds",
      "blockState"
    ];
    const listViewUpdate = { ...data };
    for (const key of omitListView) {
      delete (listViewUpdate as any)[key];
    }

    const applied = await this.db.transaction(
      'rw',
      ['communities', 'communityListViews'],
      async tx => {
        let applied = true;
        const oldCommunity = await tx.communities.get(data.id);
        if (oldCommunity) {
          this.rememberCommunityUrl(oldCommunity.id, oldCommunity.url);
          if (isOlderThanStored(oldCommunity, data)) {
            applied = false;
          }
          else {
            await tx.communities.update(data.id, data);
          }
        }
        const oldListView = await tx.communityListViews.get(data.id);
        if (oldListView) {
          this.rememberCommunityUrl(oldListView.id, oldListView.url);
          if (isOlderThanStored(oldListView, data)) {
            applied = false;
          }
          else {
            await tx.communityListViews.update(data.id, listViewUpdate);
          }
        }
        return applied;
      },
    );

    const newUrl = data.url;
    if (!applied || !newUrl) return;
    const prefix = `/${config.URL_COMMUNITY}/`;
    const oldPathname = window.location.pathname;
    if (!oldPathname.startsWith(prefix)) return;
    const urlInPath = oldPathname.slice(prefix.length).split('/')[0];
    const pathHasTrailingSegment = oldPathname.length > prefix.length + urlInPath.length;
    if (
      !!urlInPath &&
      pathHasTrailingSegment &&
      urlInPath !== newUrl &&
      !!this.knownUrlsByCommunityId.get(data.id)?.has(urlInPath)
    ) {
      const newPathname = prefix + newUrl + oldPathname.slice(prefix.length + urlInPath.length) + window.location.search + window.location.hash;
      // Todo: find a better solution than using the serviceWorkerMananger navigate reference
      serviceWorkerManager.navigate?.(newPathname);
    }
    this.rememberCommunityUrl(data.id, newUrl);
  }

  public async getOwnCommunities() {
    const myCommunityIds = ((await uniqueDb.uniques.get("OwnCommunityIds")) as Unique.OwnCommunityIds | undefined)?.ids || [];
    return this.db.communities.bulkGet(myCommunityIds).then(result => {
      const communities = result.filter(c => c !== undefined);
      communities.forEach(c => this.rememberCommunityUrl(c.id, c.url));
      return communities;
    }) as Promise<Models.Community.DetailView[]>;
  }

  public async fetchOrUpdateCommunityDetailViews(communityIds: string[]) {
    this.scheduleRetrieval('detailViewsById', communityIds.filter(id => !!id));
  }

  public async getCommunityDetailView(communityId: string) {
    const detailView = await this.db.communities.get(communityId);
    if (!detailView) {
      this.scheduleRetrieval('detailViewsById', [communityId]);
    }
    else {
      this.rememberCommunityUrl(detailView.id, detailView.url);
    }
    return detailView;
  }

  public async fetchFreshCommunityDetailView(communityId: string) {
    const community = await communityManager.getCommunityDetailView({id: communityId});
    await this.addCommunity(community);
    return community; 
  }

  // public async getCommunityMembers(communityId: string) {
  //   const lastFetch = this.memberListLastFetch.get(communityId);
  //   if (!lastFetch || Date.now() - lastFetch.getTime() > MEMBER_LIST_VALIDFOR) {
  //     this.scheduleRetrieval('membersByCommunityId', [communityId]);
  //   }
  //   const members = await this.db.communityMembers.where('communityId').equals(communityId).toArray();
  //   return members.reduce<{ [userId: string]: { roleIds: string[] } }>((agg, member) => {
  //     const { userId, roleIds } = member;
  //     agg[userId] = { roleIds };
  //     return agg;
  //   }, {});
  // }

  // public async getCommunityListView(communityId: string) {
  //   if (!!communityId) {
  //     const result = await this.db.communityListViews.get(communityId);
  //     if (!result) {
  //       this.scheduleRetrieval('listViewsById', [communityId]);
  //     }
  //     return result;
  //   }
  // }

  // public async getCommunityListViews(communityIds: string[]) {
  //   const ids = communityIds.filter(id => !!id);
  //   if (ids.length > 0) {
  //     const result = await this.db.communityListViews.bulkGet(ids);
  //     return result.filter((listView, i) => {
  //       if (!listView) {
  //         this.scheduleRetrieval('listViewsById', [ids[i]]);
  //         return false;
  //       }
  //       else {
  //         return true;
  //       }
  //     }) as Models.Community.ListView[];
  //   }
  //   return [];
  // }

  public async getAllCommunityListViews() {
    return this.db.communityListViews.toArray();
  }

  public async fetchOrUpdateCommunityListViews(communityIds: string[]) {
    this.scheduleRetrieval('listViewsById', communityIds.filter(id => !!id));
  }

  public async bulkDeleteCommunityListViews(communityIds: string[]) {
    await this.db.communityListViews.bulkDelete(communityIds);
  }

  public async getCommunityByUrl(url: string) {
    const detailView = await this.db.communities.where('url').equals(url).first();
    if (!detailView) {
      this.scheduleRetrieval('detailViewsByUrl', [url]);
    }
    else {
      this.rememberCommunityUrl(detailView.id, detailView.url);
    }
    return detailView;
  }

  public async getArea(communityId: string, areaId: string) {
    return await this.db.areas.get([communityId, areaId]);
  }

  public async getAreas(communityId: string) {
    const areas = await this.db.areas.where('communityId').equals(communityId).toArray();
    return [...areas].sort((a, b) => a.order - b.order);
  }

  public async getChannel(communityId: string, channelId: string) {
    const channel = await this.db.channels.get([communityId, channelId]);
    if (!!channel) {
      channelDatabaseManager.registerAccessForChannel({
        channelId: channel.channelId,
        communityId,
      });
    }
    return channel;
  }

  public async getChannels(communityId: string) {
    const channels = await this.db.channels.where('communityId').equals(communityId).toArray();
    channels.forEach(c => {
      channelDatabaseManager.registerAccessForChannel({
        channelId: c.channelId,
        communityId,
      });
    });
    return [...channels].sort((a, b) => a.order - b.order);
  }

  public async getChannelsById(channelIds: string[]) {
    return await this.db.channels.where('channelId').anyOf(channelIds).toArray();    
  }

  public async areCommunitiesUnread(communityIds: string[]) {
    const channels = await this.db.channels.where('communityId').anyOf(communityIds).toArray();
    return channels.some(channel => !!channel.unread);
  }

  public async getRoles(communityId: string) {
    return await this.db.roles.where('communityId').equals(communityId).toArray();
  }

  public async getAllActiveCalls() {
    const calls = await this.db.calls.toArray();
    calls.forEach(c => {
      channelDatabaseManager.registerAccessForChannel({
        channelId: c.channelId,
        callId: c.id,
      });
    });
    const filteredCalls = calls.filter(c => !!c.callServerUrl);
    return filteredCalls;
  }

  public async getCalls(communityId: string) {
    const calls = await this.db.calls.where('communityId').equals(communityId).toArray();
    calls.forEach(c => {
      channelDatabaseManager.registerAccessForChannel({
        channelId: c.channelId,
        callId: c.id,
      });
    });
    const filteredCalls = calls.filter(c => !!c.callServerUrl);
    return filteredCalls;
  }

  public async getCallById(callId: string) {
    const call = await this.db.calls.get(callId);
    if (!!call) {
      channelDatabaseManager.registerAccessForChannel({
        channelId: call.channelId,
        callId: call.id,
      });
    }
    return call;
  }

  public async createRole(role: API.Community.createRole.Request) {
    return await communityApi.createRole(role);
  }

  public async updateRole(role: API.Community.updateRole.Request) {
    return await communityApi.updateRole(role);
  }

  public async deleteRole(role: API.Community.deleteRole.Request) {
    return await communityApi.deleteRole(role);
  }

  public async createCommunity(data: API.Community.createCommunity.Request): Promise<Models.Community.DetailView> {
    const community = await communityApi.createCommunity(data);
    await this.addCommunity(community);
    return (await this.db.communities.where('id').equals(community.id).toArray())[0];
  }

  public async updateCommunity(communityId: string, communityData: Partial<Omit<Models.Community.DetailView, "id">>): Promise<void> {
    await communityApi.updateCommunity({ ...communityData, id: communityId });
    await this.db.communities.update(communityId, communityData);
  }

  public async createArea(areaData: Omit<Models.Community.Area, "id" | "updatedAt">): Promise<void> {
    await communityApi.createArea(areaData);
  }

  public async updateArea(communityId: string, areaId: string, areaData: Partial<Omit<Models.Community.Area, "id">>): Promise<void> {
    await communityApi.updateArea({ ...areaData, communityId, id: areaId });
    await this.db.areas.update([communityId, areaId], areaData);
  }

  public async deleteArea(communityId: string, areaId: string): Promise<void> {
    await communityApi.deleteArea({ communityId, id: areaId });
    await this.db.areas.delete([communityId, areaId]);
  }

  public async createChannel(channelData: API.Community.createChannel.Request): Promise<void> {
    await communityApi.createChannel(channelData);
  }

  public async updateChannel(communityId: string, channelId: string, channelData: Partial<Omit<Models.Community.Channel, "id">>): Promise<void> {
    await communityApi.updateChannel({ ...channelData, communityId, channelId });
    if (!!channelData.rolePermissions) {
      const roles = await this.db.roles.where('communityId').equals(communityId).toArray();
      const adminRole = roles.find(r => r.type === RoleType.PREDEFINED && r.title === PredefinedRole.Admin);
      if (!adminRole) {
        console.warn("No admin role found for community", communityId);
      }
      else {
        channelData.rolePermissions.push({
          roleId: adminRole.id,
          roleTitle: adminRole.title,
          permissions: ["CHANNEL_EXISTS", "CHANNEL_MODERATE", "CHANNEL_READ", "CHANNEL_WRITE"],
        });
      }
    }
    await this.db.channels.update([communityId, channelId], channelData);
  }

  public async deleteChannel(communityId: string, channelId: string): Promise<void> {
    await communityApi.deleteChannel({ communityId, channelId });
    await this.db.channels.delete([communityId, channelId]);
  }

  private lastMessageReceivedExecution = 0;
  private updateMessageReceivedPromise: Promise<void> | undefined;
  private receivedMessagesByChannelId: Map<string, { message: Models.Message.Message, isOwnMessage: boolean }[]> = new Map();
  public newMessageReceived(channelId: string, message: Models.Message.Message, isOwnMessage: boolean): void {
    let receivedMessages = this.receivedMessagesByChannelId.get(channelId);
    if (!receivedMessages) {
      receivedMessages = [];
      this.receivedMessagesByChannelId.set(channelId, receivedMessages);
    }
    receivedMessages.push({ message, isOwnMessage });

    if (!this.updateMessageReceivedPromise) {
      this.updateMessageReceivedPromise = new Promise<void>(async (resolve, reject) => {
        try {
          let finished = false;
          while (!finished) {
            // only execute every NEWMESSAGE_DEBOUNCE_INTERVAL ms
            const lastExecutedTimeDelta = Date.now() - this.lastMessageReceivedExecution;
            if (lastExecutedTimeDelta < NEWMESSAGE_DEBOUNCE_INTERVAL) {
              await new Promise(res => setTimeout(res, NEWMESSAGE_DEBOUNCE_INTERVAL - lastExecutedTimeDelta));
            }
            this.lastMessageReceivedExecution = Date.now();

            await this.db.transaction(
              'rw',
              ['channels'],
              async tx => {
                const receivedMessagesMap = this.receivedMessagesByChannelId;
                this.receivedMessagesByChannelId = new Map();
                const channelIds = Array.from(receivedMessagesMap.keys());
                const channels = await tx.channels.where('channelId').anyOf(channelIds).toArray();
                const channelUpdates: {
                  key: [string, string];
                  changes: {
                    unread: number;
                    lastMessageDate: string | null;
                  }
                }[] = [];

                for (const channel of channels) {
                  const messageData = receivedMessagesMap.get(channel.channelId);
                  messageData?.sort((a, b) => a.message.createdAt.getTime() - b.message.createdAt.getTime());
                  let unread = channel.unread || 0;
                  let lastMessageDate = channel.lastMessageDate ? new Date(channel.lastMessageDate) : null;
                  const channelLastRead = new Date(channel.lastRead || 0);
                  for (const { message, isOwnMessage } of messageData || []) {
                    if (message.createdAt > channelLastRead) {
                      if (isOwnMessage) {
                        unread = 0;
                      }
                      else {
                        unread++;
                      }
                    }
                    if (!lastMessageDate || message.createdAt > lastMessageDate) {
                      lastMessageDate = message.createdAt;
                    }
                  }
                  if (
                    unread !== channel.unread ||
                    (lastMessageDate && (
                      !channel.lastMessageDate ||
                      new Date(channel.lastMessageDate) < lastMessageDate // compare against old lastMessageDate
                    ))
                  ) {
                    channelUpdates.push({
                      key: [channel.communityId, channel.channelId],
                      changes: {
                        unread,
                        lastMessageDate: lastMessageDate?.toISOString() || channel.lastMessageDate,
                      },
                    });
                  }
                }
                if (channelUpdates.length > 0) {
                  tx.channels.bulkUpdate(channelUpdates);
                }
              },
            );
            finished = this.receivedMessagesByChannelId.size === 0;
          }
          resolve();
        }
        catch (e) {
          reject(e);
        }
        finally {
          this.updateMessageReceivedPromise = undefined;
        }
      });
    }
  }

  public async setChannelLastRead(channelId: string, lastRead: Date) {
    await this.db.transaction(
      'rw',
      ['channels'],
      async tx => {
        const channel = await tx.channels.where('channelId').equals(channelId).first();
        if (!!channel) {
          const update: {
            unread?: number;
            lastRead?: string;
          } = {};
          if (
            (!!channel.lastMessageDate && new Date(channel.lastMessageDate).getTime() <= lastRead.getTime()) &&
            channel.unread !== 0
          ) {
            update.unread = 0;
          }
          if (new Date(channel.lastRead).getTime() < lastRead.getTime()) {
            update.lastRead = lastRead.toISOString();
          }
          if (Object.getOwnPropertyNames(update).length > 0) {
            tx.channels.update([channel.communityId, channel.channelId], update);
          }
        }
      },
    );
  }

  public async setChannelPinState(data: API.Community.setChannelPinState.Request) {
    const { communityId, channelId, ...updateData } = data;
    await communityApi.setChannelPinState(data);
    await this.db.channels.update([
      communityId,
      channelId,
    ], updateData as any);
  }

  private tagFrequencyRetrievalTimeout: any;
  public async getGlobalCommunityTagData(): Promise<Pick<Unique.TagFrequency, "byId" | "sortedArray"> | undefined> {
    const result = await uniqueDb.uniques.get("TagFrequency") as Unique.TagFrequency | undefined;
    if ((!result || result.validUntil < Date.now()) && !this.tagFrequencyRetrievalTimeout) {
      this.tagFrequencyRetrievalTimeout = setTimeout(() => {
        communityApi.getTagFrequencyData().then(data => {
          const sortedArray: Unique.TagFrequency["sortedArray"] = [];
          for (const tag of Object.keys(data)) {
            sortedArray.push({ tag, count: data[tag] })
          }
          sortedArray.sort((a, b) => a.count - b.count);
          const putData: Unique.TagFrequency = {
            key: "TagFrequency",
            byId: data,
            sortedArray,
            validUntil: Date.now() + TAG_FREQUENCY_VALIDFOR,
          }
          return uniqueDb.uniques.put(putData);
        }).catch(e => {
          console.error("Error retrieving global tag data", e);
        }).finally(() => {
          this.tagFrequencyRetrievalTimeout = undefined;
        })
      }, 0);
    }
    if (!!result) {
      return {
        byId: result.byId,
        sortedArray: result.sortedArray,
      }
    }
  }

  private _setupPromise: Promise<void> | undefined;
  public setupAfterLogin(communities: Models.Community.DetailViewFromApi[]): Promise<void> {
    if (!this._setupPromise) {
      this._setupPromise = new Promise<void>(async (resolve, reject) => {
        let rejected = false;
        const susTimeout = setTimeout(() => {
          console.log("CommunityDatabase.setupAfterLogin is taking longer than 7s, cancelling...");
          rejected = true;
          reject(new Error("CommunityDatabase.setupAfterLogin timed out"));
        }, 7_000);
    
        try {
          const newCommunities = [...communities];
          for (const newCommunity of newCommunities) {
            this.rememberCommunityUrl(newCommunity.id, newCommunity.url);
            for (const channel of newCommunity.channels) {
              channelDatabaseManager.registerAccessForChannel({
                channelId: channel.channelId,
                communityId: channel.communityId,
              }, {
                lastRead: channel.lastRead,
              });
            }
            for (const call of newCommunity.calls) {
              channelDatabaseManager.registerAccessForChannel({
                callId: call.id,
                channelId: call.channelId,
                communityId: call.communityId,
              });
            }
          }
          const communityIdsToDelete: string[] = [];
          const communitiesToUpsert: Models.Community.DetailView[] = [];
      
          /**
           * An array of [ communityId, channelId ] arrays
           */
          const channelIdsToDelete: [string, string][] = [];
          const channelsToUpsert: Models.Community.Channel[] = [];
          const areaIdsToDelete: [string, string][] = [];
          const areasToUpsert: Models.Community.Area[] = [];
          const roleIdsToDelete: [string, string][] = [];
          const rolesToUpsert: Models.Community.Role[] = [];
          const callIdsToDelete: string[] = [];
          const callsToUpsert: Models.Calls.Call[] = [];
      
          const oldCommunityIds = (await uniqueDb.uniques.get("OwnCommunityIds") as Unique.OwnCommunityIds | undefined)?.ids;
          const newCommunityIds: string[] = [];
          if (!!oldCommunityIds) {
            // data exists, do update
            const [
              oldCommunities,
              allOldChannels,
              allOldAreas,
              allOldRoles,
              allOldCalls,
            ] = await Promise.all([
              this.db.communities.where("id").anyOf(oldCommunityIds).toArray(),
              this.db.channels.where("communityId").anyOf(oldCommunityIds).toArray(),
              this.db.areas.where("communityId").anyOf(oldCommunityIds).toArray(),
              this.db.roles.where("communityId").anyOf(oldCommunityIds).toArray(),
              this.db.calls.where("communityId").anyOf(oldCommunityIds).toArray(),
            ]);
      
            for (const oldCommunity of oldCommunities) {
              const index = newCommunities.findIndex(c => c.id === oldCommunity.id);
              let newCommunity: Models.Community.DetailViewFromApi | undefined;
      
              if (index > -1) {
                newCommunity = newCommunities[index];
                newCommunities.splice(index, 1);
              }
      
              if (!newCommunity) {
                // community was deleted
                communityIdsToDelete.push(oldCommunity.id);
                allOldChannels
                  .filter(c => c.communityId === oldCommunity.id)
                  .forEach(c => channelIdsToDelete.push([c.communityId, c.channelId]));
                allOldAreas
                  .filter(a => a.communityId === oldCommunity.id)
                  .forEach(a => areaIdsToDelete.push([a.communityId, a.id]));
                allOldRoles
                  .filter(r => r.communityId === oldCommunity.id)
                  .forEach(r => roleIdsToDelete.push([r.communityId, r.id]));
                allOldCalls
                  .filter(c => c.communityId === oldCommunity.id)
                  .forEach(c => callIdsToDelete.push(c.id));
      
              } else {
                // community exists
                newCommunityIds.push(newCommunity.id);
                const { roles, channels, areas, calls, ...updateData } = newCommunity;

                // Check if plugins have changed
                let pluginsChanged = !isEqual(updateData.plugins, oldCommunity.plugins);

                if (
                  oldCommunity.updatedAt !== newCommunity.updatedAt ||
                  newCommunity.myRoleIds.length !== oldCommunity.myRoleIds.length ||
                  newCommunity.myRoleIds.some(roleId => !oldCommunity.myRoleIds.includes(roleId)) ||
                  newCommunity.blockState?.state !== oldCommunity.blockState?.state ||
                  newCommunity.blockState?.until !== oldCommunity.blockState?.until ||
                  newCommunity.tokens.length !== oldCommunity.tokens.length ||
                  newCommunity.tokens.some(token => !oldCommunity.tokens.find(t => t.contractId === token.contractId || t.order === token.order)) ||
                  newCommunity.premium?.activeUntil !== oldCommunity.premium?.activeUntil ||
                  newCommunity.premium?.featureName !== oldCommunity.premium?.featureName ||
                  newCommunity.premium?.autoRenew !== oldCommunity.premium?.autoRenew ||
                  newCommunity.pointBalance !== oldCommunity.pointBalance ||
                  newCommunity.official !== oldCommunity.official ||
                  newCommunity.myApplicationStatus !== oldCommunity.myApplicationStatus ||
                  newCommunity.membersPendingApproval !== oldCommunity.membersPendingApproval ||
                  newCommunity.enablePersonalNewsletter !== oldCommunity.enablePersonalNewsletter ||
                  newCommunity.myNewsletterEnabled !== oldCommunity.myNewsletterEnabled ||
                  pluginsChanged
                ) {
                  // community changed
                  console.log("Community changed and needs to be updated", updateData);
                  communitiesToUpsert.push(updateData);
                }
      
                // update channels
                const oldChannels = allOldChannels.filter(channel => channel.communityId === oldCommunity.id);
                for (const channel of channels) {
                  let oldChannel: Models.Community.Channel | undefined;
                  const index = oldChannels.findIndex(c => c.channelId === channel.channelId);
                  if (index > -1) {
                    oldChannel = oldChannels[index];
                    oldChannels.splice(index, 1);
                  }
                  if (
                    !oldChannel ||
                    oldChannel.updatedAt !== channel.updatedAt ||
                    oldChannel.unread !== channel.unread ||
                    oldChannel.rolePermissions.length !== channel.rolePermissions.length ||
                    oldChannel.lastMessageDate !== channel.lastMessageDate ||
                    channel.rolePermissions.some((newPermisson, i) => {
                      const existingPermission = oldChannel?.rolePermissions.find(rp => (
                        rp.roleId === newPermisson.roleId &&
                        rp.roleTitle === newPermisson.roleTitle
                      ));
                      return (
                        !existingPermission ||
                        existingPermission.permissions.length !== newPermisson.permissions.length ||
                        existingPermission.permissions.some(p => !newPermisson.permissions.includes(p))
                      );
                    })
                  ) {
                    // channel is new or was changed and needs to be added
                    console.log("Channel changed and needs to be updated", channel);
                    channelsToUpsert.push(channel);
                  } else {
                    // console.log(`Community Channel with channelId ${channel.channelId} did not change`);
                  }
                }
                for (const oldChannel of oldChannels) {
                  // the "leftover" channels don't exist in db anymore
                  // and need to be deleted
                  console.log(`Removing Community Channel with channelId ${oldChannel.channelId}`);
                  channelIdsToDelete.push([oldChannel.communityId, oldChannel.channelId]);
                }
      
                const oldAreas = allOldAreas.filter(a => a.communityId === oldCommunity.id);
                for (const area of areas) {
                  let oldArea: Models.Community.Area | undefined;
                  const index = oldAreas.findIndex(a => a.id === area.id);
                  if (index > -1) {
                    oldArea = oldAreas[index];
                    oldAreas.splice(index, 1);
                  }
                  if (!oldArea || oldArea.updatedAt !== area.updatedAt) {
                    // area is new or was changed and needs to be added
                    console.log("Area changed and needs to be updated", area);
                    areasToUpsert.push(area);
                  } else {
                    // console.log(`Community Area with id ${area.id} did not change`);
                  }
                }
                for (const oldArea of oldAreas) {
                  // the "leftover" areas don't exist in db anymore
                  // and need to be deleted
                  console.log(`Removing Community Area with id ${oldArea.id}`);
                  areaIdsToDelete.push([oldArea.communityId, oldArea.id]);
                }
      
                const oldRoles = allOldRoles.filter(r => r.communityId === oldCommunity.id);
                for (const role of roles) {
                  let oldRole: Models.Community.Role | undefined;
                  const index = oldRoles.findIndex(r => r.id === role.id);
                  if (index > -1) {
                    oldRole = oldRoles[index];
                    oldRoles.splice(index, 1);
                  }
                  if (!oldRole || oldRole.updatedAt !== role.updatedAt) {
                    // role is new or was changed and needs to be added
                    console.log("Role changed and needs to be updated", role);
                    rolesToUpsert.push(role);
                  } else {
                    // console.log(`Community Role with id ${role.id} did not change`);
                  }
                }
                for (const oldRole of oldRoles) {
                  // the "leftover" roles don't exist in db anymore
                  // and need to be deleted
                  console.log(`Removing Community Role with id ${oldRole.id}`);
                  roleIdsToDelete.push([oldRole.communityId, oldRole.id]);
                }
      
                const oldCalls = allOldCalls.filter(c => c.communityId === oldCommunity.id);
                for (const call of calls) {
                  let oldCall: Models.Calls.Call | undefined;
                  const index = oldCalls.findIndex(r => r.id === call.id);
                  if (index > -1) {
                    oldCall = oldCalls[index];
                    oldCalls.splice(index, 1);
                  }
                  if (
                    !oldCall ||
                    oldCall.callServerUrl !== call.callServerUrl ||
                    oldCall.slots !== call.slots ||
                    oldCall.callMembers !== call.callMembers ||
                    call.previewUserIds.some((id, i) => id !== oldCall?.previewUserIds?.[i])
                  ) {
                    // call is new or was changed and needs to be added
                    console.log("Call changed and needs to be updated", call);
                    callsToUpsert.push(call);
                  } else {
                    // console.log(`Community Call with id ${call.id} did not change`);
                  }
                }
                for (const oldCall of oldCalls) {
                  // the "leftover" calls don't exist in db anymore
                  // and need to be deleted
                  console.log(`Removing Community Call with id ${oldCall.id}`);
                  callIdsToDelete.push(oldCall.id);
                }
              }
            }
          }
      
          // all items left in "communities" are new
          for (const newCommunity of newCommunities) {
            newCommunityIds.push(newCommunity.id);
            console.log(`Creating new Community in DB with id ${newCommunity.id}`);
            const { roles, channels, areas, calls, ...updateData } = newCommunity;
            communitiesToUpsert.push(updateData);
            channelsToUpsert.push(...channels);
            areasToUpsert.push(...areas);
            rolesToUpsert.push(...roles);
            callsToUpsert.push(...calls);
          }
      
          // delete old channel databases
          for (const data of channelIdsToDelete) {
            channelDatabaseManager.deleteChannelDatabase({ channelId: data[1] });
          }
      
          if (!rejected) {
            await this.db.transaction(
              'rw',
              ['communities', 'channels', 'areas', 'roles', 'calls'],
              async (tx) => {
                const abortTxTimeout = setTimeout(() => {
                  tx.abort();
                }, 5000);

                await Dexie.Promise.all([
                  tx.communities.bulkPut(communitiesToUpsert).then(() => {
                    return tx.communities.bulkDelete(communityIdsToDelete);
                  }),
                  tx.channels.bulkPut(channelsToUpsert).then(() => {
                    return tx.channels.bulkDelete(channelIdsToDelete);
                  }),
                  tx.areas.bulkPut(areasToUpsert).then(() => {
                    return tx.areas.bulkDelete(areaIdsToDelete);
                  }),
                  tx.roles.bulkPut(rolesToUpsert).then(() => {
                    return tx.roles.bulkDelete(roleIdsToDelete);
                  }),
                  tx.calls.bulkPut(callsToUpsert).then(() => {
                    return tx.calls.bulkDelete(callIdsToDelete);
                  }),
                ]);

                clearTimeout(abortTxTimeout);
              }
            );
        
            console.log("Updating OwnCommunityIds", newCommunityIds);
            await uniqueDb.transaction("rw", uniqueDb.uniques, async tx => {
              const now = Date.now();
              const existing = await tx.uniques.get("CommunityDetailViewUpdateTimestamps");
              let object = (existing || { key: "CommunityDetailViewUpdateTimestamps", data: {} }) as Unique.CommunityDetailViewUpdateTimestamps;
              for (const communityId of newCommunityIds) {
                object.data[communityId] = now;
              }
              // bugfix
              if ("communityId" in object.data) {
                delete object.data.communityId;
              }
              await tx.uniques.put(object);
              // update OwnCommunityIds, if changed
              if (
                !oldCommunityIds ||
                newCommunityIds.length !== oldCommunityIds.length ||
                newCommunityIds.some((id, i) => id !== oldCommunityIds[i])
              ) {
                await tx.uniques.put({
                  key: "OwnCommunityIds",
                  ids: newCommunityIds,
                });
              }
            });
          }
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
    await Dexie.Promise.all([
      uniqueDb.uniques.delete("OwnCommunityIds"),
      this.db.transaction(
        'rw',
        ['communities', 'areas', 'channels', 'roles', 'calls', 'communityListViews', 'communityMembers'],
        async (tx) => {
          tx.communities.clear();
          tx.areas.clear();
          tx.channels.clear();
          tx.roles.clear();
          tx.calls.clear();
          tx.communityListViews.clear();
          tx.communityMembers.clear();
        }
      ),
    ]);
  }

  public async joinCommunity(request: API.Community.joinCommunity.Request) {
    const detailViewFromApi = await communityApi.joinCommunity(request);
    if (detailViewFromApi) await this.addCommunity(detailViewFromApi);
    else await this.db.communities.update(request.id, { myApplicationStatus: 'PENDING' });
  }

  public async leaveCommunity(communityId: string) {
    const detailViewFromApi = await communityApi.leaveCommunity({ id: communityId });
    await this.addCommunity(detailViewFromApi);
  }

  public async startCall(data: API.Community.startCall.Request) {
    const callData = await communityApi.startCall(data);
    await this.db.calls.put(callData);
    return callData;
  }

  private async addCommunity(detailViewFromApi: Models.Community.DetailViewFromApi): Promise<void> {
    const communityId = detailViewFromApi.id;
    // collect all properties into community except of areas, channels and roles
    const { areas, channels, roles, calls, ...community } = detailViewFromApi;
    this.rememberCommunityUrl(community.id, community.url);

    // register access
    for (const channel of channels) {
      channelDatabaseManager.registerAccessForChannel({
        channelId: channel.channelId,
        communityId: channel.communityId,
      }, {
        lastRead: channel.lastRead,
      });
    }
    for (const call of calls) {
      channelDatabaseManager.registerAccessForChannel({
        callId: call.id,
        channelId: call.channelId,
        communityId: call.communityId,
      });
    }

    return this.db.transaction(
      'rw',
      ['communities', 'areas', 'channels', 'roles', 'calls'],
      async (tx) => {
        const [
          existingChannels,
          existingAreas,
          existingRoles,
          existingCalls,
        ] = await Dexie.Promise.all([
          tx.channels.where("communityId").equals(communityId).toArray(),
          tx.areas.where("communityId").equals(communityId).toArray(),
          tx.roles.where("communityId").equals(communityId).toArray(),
          tx.calls.where("communityId").equals(communityId).toArray(),
        ]);
    
        const channelIdsToDelete: string[] = [];
        for (const existingChannel of existingChannels) {
          const index = channels.findIndex(channel => channel.channelId === existingChannel.channelId);
          if (index === -1) {
            channelIdsToDelete.push(existingChannel.channelId);
          }
        }
        const areaIdsToDelete: string[] = [];
        for (const existingArea of existingAreas) {
          const index = areas.findIndex(area => area.id === existingArea.id);
          if (index === -1) {
            areaIdsToDelete.push(existingArea.id);
          }
        }
        const roleIdsToDelete: string[] = [];
        for (const existingRole of existingRoles) {
          const index = roles.findIndex(role => role.id === existingRole.id);
          if (index === -1) {
            roleIdsToDelete.push(existingRole.id);
          }
        }
        const callIdsToDelete: string[] = [];
        for (const existingCall of existingCalls) {
          const index = calls.findIndex(call => call.id === existingCall.id);
          if (index === -1) {
            callIdsToDelete.push(existingCall.id);
          }
        }
    
        // delete old channel databases
        for (const channelId of channelIdsToDelete) {
          channelDatabaseManager.deleteChannelDatabase({ channelId });
        }
    
        for (const channel of channels) {
          if (!!channel.lastRead) {
            channelDatabaseManager.setInitialChannelLastRead(channel.channelId, new Date(channel.lastRead));
          }
        }

        await Dexie.Promise.all([
          tx.communities.put(community),
          tx.channels.bulkPut(channels.map(c => ({ ...c, communityId: community.id }))),
          tx.areas.bulkPut(areas.map(a => ({ ...a, communityId: community.id }))),
          tx.roles.bulkPut(roles.map(r => ({ ...r, communityId: community.id }))),
          tx.calls.bulkPut(calls),
          channelIdsToDelete.length > 0 ? tx.channels.bulkDelete(channelIdsToDelete.map(channelId => [community.id, channelId])) : Dexie.Promise.resolve(),
          areaIdsToDelete.length > 0 ? tx.areas.bulkDelete(areaIdsToDelete.map(areaId => [community.id, areaId])) : Dexie.Promise.resolve(),
          roleIdsToDelete.length > 0 ? tx.roles.bulkDelete(roleIdsToDelete.map(roleId => [community.id, roleId])) : Dexie.Promise.resolve(),
          callIdsToDelete.length > 0 ? tx.calls.bulkDelete(callIdsToDelete) : Dexie.Promise.resolve(),
        ]);
      }
    ).then(async () => {
      if (detailViewFromApi.myRoleIds.length > 0) {
        const ownCommunityIds = await (uniqueDb.uniques.get("OwnCommunityIds") as Promise<Unique.OwnCommunityIds | undefined>);
        const putData: Unique.OwnCommunityIds = {
          key: "OwnCommunityIds",
          ids: Array.from(new Set([...(ownCommunityIds?.ids || []), communityId])),
        }
        await uniqueDb.uniques.put(putData);
      }
    });
  };

  protected async retrieveMissing(key: RetrievalKey, values: string[]): Promise<void> {
    if (key === 'listViewsById') {
      const ids = values.filter(v => v !== "" && v !== undefined);
      if (ids.length === 0) {
        return;
      }
      const communities = await communityApi.getCommunitiesById({ ids });
      const missingIds = new Set(ids);
      for (const community of communities) {
        missingIds.delete(community.id);
      }
      if (missingIds.size > 0) {
        console.warn(`CommunityListViews [${Array.from(missingIds).join(', ')}] could not be retrieved`)
      }
      await uniqueDb.transaction("rw", uniqueDb.uniques, async tx => {
        const now = Date.now();
        const existing = await tx.uniques.get("CommunityListViewUpdateTimestamps");
        let object = (existing || { key: "CommunityListViewUpdateTimestamps", data: {} }) as Unique.CommunityListViewUpdateTimestamps;
        for (const community of communities) {
          object.data[community.id] = now;
        }
        await tx.uniques.put(object);
      });
      await this.db.communityListViews.bulkPut(communities);

    } else if (key === 'detailViewsById' || key === 'detailViewsByUrl') {
      let ret: ({ id: string } | { url: string })[];
      if (key === 'detailViewsById') {
        ret = values.map(v => ({ id: v }));
      } else {
        ret = values.map(v => ({ url: v }));
      }
      const communities = await Promise.all(ret.map(o => communityManager.getCommunityDetailView(o)));
      const missing = new Set(values);
      for (const community of communities) {
        if (key === 'detailViewsById') {
          missing.delete(community.id);
        } else {
          missing.delete(community.url || '');
        }
      }
      if (missing.size > 0) {
        console.warn(`CommunityDetailViews [${Array.from(missing).join(', ')}] could not be retrieved`)
      }
      for (const community of communities) {
        await this.addCommunity(community);
      }
      await uniqueDb.transaction("rw", uniqueDb.uniques, async tx => {
        const now = Date.now();
        const existing = await tx.uniques.get("CommunityDetailViewUpdateTimestamps");
        let object = (existing || { key: "CommunityDetailViewUpdateTimestamps", data: {} }) as Unique.CommunityDetailViewUpdateTimestamps;
        for (const community of communities) {
          object.data[community.id] = now;
        }
        // bugfix
        if ("communityId" in object.data) {
          delete object.data.communityId;
        }
        await tx.uniques.put(object);
      });

    } else if (key === 'membersByCommunityId') {
      // const data = await Promise.all(values.map(async (communityId) => {
      //   const memberList = await communityApi.getMemberList({ communityId: communityId });
      //   this.memberListLastFetch.set(communityId, new Date());
      //   return { communityId, memberList };
      // }));
      // return this.db.transaction('rw', this.db.communityMembers, async tx => {
      //   const insertElements: CommunityMembership[] = [];
      //   console.log("Member List Fetch Data", data);
      //   for (const d of data) {
      //     const { communityId, memberList } = d;
      //     Object.keys(memberList).forEach((userId) => {
      //       const { roleIds } = memberList[userId];
      //       insertElements.push({ userId, communityId, roleIds });
      //     });
      //     tx.communityMembers.where('communityId').equals(communityId).delete();
      //   }
      //   tx.communityMembers.bulkAdd(insertElements);
      // });
    }
  }
}

const communityDatabase = new CommunityDatabase();
export default communityDatabase;