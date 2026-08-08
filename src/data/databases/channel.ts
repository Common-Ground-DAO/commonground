// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import messageApi from "data/api/messages";
import connectionManager from "../appstate/connection";
import ChunkedItemDatabase from "./channel/chunkedDatabase";
import config from "common/config";
import Dexie from "dexie";

type DatabaseUIHandlerEvent = {
  randomTabId: number;
  access: API.Messages.MessageAccess;
  action: "register" | "unregister";
};

const openDatabaseHandles = new Map<string, Set<number>>();
const thisRandomTabId = Math.random();

export function makeMessage(apiMessage: Models.Message.ApiMessage): Models.Message.Message {
  const { createdAt, updatedAt, ...newMessage } = apiMessage;
  return {
    ...newMessage,
    createdAt: new Date(createdAt),
    updatedAt: new Date(updatedAt),
  };
}

class ChannelDatabaseManager {
  private channelDatabases: Map<string, ChunkedItemDatabase<Models.Message.Message>> = new Map();
  private accessByChannelId = new Map<string, API.Messages.MessageAccess>();
  private lastReadByChannelId = new Map<string, Date>();
  private setNextLastReadTimeouts = new Map<string, {
    local: Promise<void> | null;
    api: Promise<void> | null;
  }>();
  public userId: string | undefined;
  private broadcastChannel = new BroadcastChannel("channelDatabaseManager_events");
  private tabState = connectionManager.tabState;

  constructor() {
    connectionManager.registerClientEventHandler(
      "cliConnectionEstablished",
      event => {
        // nothing to do here
      }
    );
    connectionManager.registerClientEventHandler(
      "cliConnectionLost",
      event => {
        // nothing to do here
      }
    );
    connectionManager.registerClientEventHandler(
      "cliConnectionRestored",
      event => {
        // nothing to do here
      }
    );
    connectionManager.registerClientEventHandler(
      "cliChannelLastRead",
      event => {
        const access = this.accessByChannelId.get(event.channelId);
        const currentLastRead = this.lastReadByChannelId.get(event.channelId);
        const newLastRead = new Date(event.lastRead);
        if (
          !!access &&
          (!currentLastRead || currentLastRead < newLastRead)
        ) {
          this.lastReadByChannelId.set(access.channelId, newLastRead);
          this.updateChannelLastRead(access, newLastRead);
        }
      }
    );

    connectionManager.registerClientEventHandler(
      "cliMessageEvent",
      event => {
        let database = this.channelDatabases.get(event.data.channelId);
        const access = this.accessByChannelId.get(event.data.channelId);
        if (event.action === "new") {
          const message = {
            ...event.data,
            createdAt: new Date(event.data.createdAt),
            updatedAt: new Date(event.data.updatedAt), 
          };
          database?.addNewItem(message);

          if (!!access) {
            if ('communityId' in access) {
              (import('./community')).then(impl => {
                const communityDatabase = impl.default;
                return communityDatabase.newMessageReceived(access.channelId, message, message.creatorId === this.userId);
              });
            }
            else if ('chatId' in access) {
              (import('./chats')).then(impl => {
                const chatDatabase = impl.default;
                return chatDatabase.newMessageReceived(access.channelId, message, message.creatorId === this.userId);
              });
            }
          }
        }
        else if (event.action === "update") {
          const { updatedAt, channelId, ...updateData } = event.data;
          database?.updateItems([{
            ...updateData,
            updatedAt: new Date(updatedAt),
          }]);
        }
        else if (event.action === "delete") {
          database?.deleteItems(event.data.deletedIds);
        }
      }
    );

    connectionManager.addListener("tabStateChange", (tabState) => {
      // if the tab goes from passive to active, we need to set alwaysInstantFlush for all databases
      // and create databases for all channels that don't have one yet (so that the main tab can insert new messages)
      if (
        (tabState === 'active' || tabState === 'active-throttled') &&
        (this.tabState === 'passive' || this.tabState === 'passive-throttled')
      ) {
        const knownHandles = Array.from(openDatabaseHandles.entries());
        for (const [channelId, currentSet] of knownHandles) {
          if (currentSet.size > 0) {
            const database = this.channelDatabases.get(channelId);
            if (!!database) {
              database.alwaysInstantFlush = true;
            }
            else {
              // create db if it doesn't exist, so that the main tab can insert new messages
              try {
                this.getOrCreateChannelDatabase(channelId, true);
              }
              catch (e) {
                // if access has not been set up yet, we can't create the database, catch it to
                // handle as many databases as possible
                console.error("Error creating database for channelId", channelId, e);
              }
            }
          }
        }
      }
      this.tabState = tabState;
    });
    
    this.broadcastChannel.onmessage = (event: MessageEvent<DatabaseUIHandlerEvent>) => {
      const { action, access, randomTabId } = event.data;
      if (action === "register") {
        let currentSet = openDatabaseHandles.get(access.channelId);
        if (!currentSet) {
          currentSet = new Set();
          openDatabaseHandles.set(access.channelId, currentSet);
        }
        currentSet.add(randomTabId);
        if (!this.accessByChannelId.has(access.channelId)) {
          // fallback for db access not being set up
          this.registerAccessForChannel(access);
        }
        
        const { tabState } = connectionManager;
        if (tabState === 'active' || tabState === 'active-throttled') {
          const existingDatabase = this.channelDatabases.get(access.channelId);
          if (!!existingDatabase) {
            existingDatabase.alwaysInstantFlush = true;
          }
          else {
            // create db if it doesn't exist, so that the main tab can insert new messages
            this.getOrCreateChannelDatabase(access.channelId, true);
          }
        }
      }
      else if (action === "unregister") {
        let currentSet = openDatabaseHandles.get(access.channelId);
        currentSet?.delete(randomTabId);
        if (currentSet?.size === 0) {
          openDatabaseHandles.delete(access.channelId);
        }
        const { tabState } = connectionManager;
        if (!currentSet?.size && (tabState === 'active' || tabState === 'active-throttled')) {
          const existingDatabase = this.channelDatabases.get(access.channelId);
          if (!!existingDatabase) {
            existingDatabase.alwaysInstantFlush = false;
          }
        }
      }
    };
  }

  private async updateChannelLastRead(access: API.Messages.MessageAccess, lastRead: Date) {
    if ('communityId' in access) {
      const communityDatabase = (await import('./community')).default;
      await communityDatabase.setChannelLastRead(access.channelId, lastRead);
    }
    else if ('chatId' in access) {
      const chatDatabase = (await import('./chats')).default;
      await chatDatabase.setChannelLastRead(access.channelId, lastRead);
    }
  };

  public registerAccessForChannel(access: API.Messages.MessageAccess, data?: { lastRead: string }) {
    this.accessByChannelId.set(access.channelId, access);
    if (!!data) {
      this.lastReadByChannelId.set(access.channelId, new Date(data.lastRead));
    }
  }

  /** The full MessageAccess (community/chat/article variant) for a channel, if known. */
  public getAccessForChannel(channelId: string): API.Messages.MessageAccess | undefined {
    return this.accessByChannelId.get(channelId);
  }

  public async getMessageById(
    channelId: string,
    id: string,
    onchange: (item: Models.Message.Message | undefined) => void,
  ) {
    const access = this.accessByChannelId.get(channelId);
    if (!access) {
      throw new Error(`ChannelAccess has not been set up for channelId ${channelId}`);
    }

    const database = this.channelDatabases.get(channelId);
    if (!database) {
      throw new Error("Channel database does not exist");
    }

    const result: {
      item?: Models.Message.Message;
      unsubscribe: () => void;
    } = {} as any;

    result.item = await new Promise<Models.Message.Message | undefined>(async (resolve, reject) => {
      let resolved = false;
      const innerOnchange = (item: Models.Message.Message | undefined) => {
        if (!resolved) {
          resolved = true;
          resolve(item);
        }
        else {
          onchange(item);
        }
      };
      const observeResult = database.observeSingleItemById({
        id,
        onchange: innerOnchange,
        onerror: reject
      });
      result.unsubscribe = observeResult.unsubscribe;
    });

    if (result.item) {
      return result;
    }
    
    else {
      const retrievedItem = (await messageApi.messagesById({
        access,
        messageIds: [id],
      }))[0];
      if (!retrievedItem) {
        throw new Error('Item cannot be retrieved');
      }
      const message = makeMessage(retrievedItem)
      await database.addCompleteItemRange([message]);
      result.item = message;
      return result;
    }
  }

  public async setReaction(channelId: string, message: Models.Message.Message, reaction: string) {
    const access = this.accessByChannelId.get(channelId);
    if (!access) {
      throw new Error(`ChannelAccess has not been set up for channelId ${channelId}`);
    }

    // Todo: Update locally instantly?
    await messageApi.setReaction({
      access,
      messageId: message.id,
      reaction
    });
  }

  public async unsetReaction(channelId: string, message: Models.Message.Message) {
    const access = this.accessByChannelId.get(channelId);
    if (!access) {
      throw new Error(`ChannelAccess has not been set up for channelId ${channelId}`);
    }

    // Todo: Update locally instantly?
    await messageApi.unsetReaction({
      access,
      messageId: message.id,
    });
  }

  public async setInitialChannelLastRead(channelId: string, lastRead: Date) {
    this.lastReadByChannelId.set(channelId, lastRead);
  }

  public setChannelLastRead(channelId: string, lastRead: Date) {
    const access = this.accessByChannelId.get(channelId);
    if (!access) {
      throw new Error(`ChannelAccess has not been set up for channelId ${channelId}`);
    }
    const currentLastRead = this.lastReadByChannelId.get(channelId);

    if (!currentLastRead || currentLastRead < lastRead) {      
      // update lastread value
      this.lastReadByChannelId.set(channelId, lastRead);

      // write to localDb and API, but debounce
      let timeouts = this.setNextLastReadTimeouts.get(channelId);
      if (!timeouts) {
        timeouts = { local: null, api: null };
        this.setNextLastReadTimeouts.set(channelId, timeouts);
      }
      if (!timeouts.local) {
        timeouts.local = new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            const newLastRead = this.lastReadByChannelId.get(channelId) as Date;
            this.updateChannelLastRead(access, newLastRead)
            .then(resolve)
            .catch(reject);
          }, 500);
        })
        .finally(() => {
          timeouts!.local = null;
        });
      }
      if (!timeouts.api) {
        timeouts.api = new Promise<void>((resolve, reject) => {
          setTimeout(() => {
            const newLastRead = this.lastReadByChannelId.get(channelId) as Date;
            messageApi.setChannelLastRead({
              access,
              lastRead: newLastRead.toISOString(),
            })
            .then(resolve)
            .catch(reject);
          }, 1000);
        })
        .finally(() => {
          timeouts!.api = null;
        });
      }
    }
  }

  public async createMessage(
    data: Pick<Models.Message.Message, "attachments" | "body" | "parentMessageId" | "creatorId" | "channelId">,
    isModerationMessage: boolean = false,
  ) {
    const access = this.accessByChannelId.get(data.channelId);
    if (!access) {
      throw new Error(`ChannelAccess has not been set up for channelId ${data.channelId}`);
    }

    const database = this.channelDatabases.get(access.channelId);
    if (!database) {
      throw new Error("Channel database does not exist");
    }

    const temporaryCreatedAt = new Date(Date.now() + 100);
    const { attachments, body, parentMessageId, creatorId } = data;
    if (
      attachments === undefined ||
      body === undefined ||
      parentMessageId === undefined
    ) {
      throw new Error('createItem: body, parentMessageId and attachments properties need to be present');
    }
    const id = (crypto as any).randomUUID();
    const temporaryItem: Models.Message.Message = {
      id,
      creatorId,
      channelId: access.channelId,
      body,
      attachments,
      editedAt: null,
      createdAt: temporaryCreatedAt,
      updatedAt: new Date(0),
      reactions: {},
      ownReaction: null,
      parentMessageId,
    };

    (isModerationMessage
      ? messageApi.createModerationMessage({
        id,
        access,
        attachments,
        body,
        parentMessageId,
      })
      : messageApi.createMessage({
        id,
        access,
        attachments,
        body,
        parentMessageId,
      })
    )
    .then((item) => {
      const { createdAt, updatedAt, ...rest } = item;
      const newMessage = {
        ...rest,
        createdAt: new Date(createdAt),
        updatedAt: new Date(updatedAt),
      };
      return database.addNewItem(newMessage).then(() => newMessage);
    })
    .catch(e => {
      return database.putTemporaryItemNoChunkChange({
        ...temporaryItem,
        sendStatus: "error-send",
      }).then(() => undefined);
    })
    .catch(e => {
      console.error('Error adding new item to database', e);
    })
    .then((message) => {
      if (message) {
        if ('communityId' in access) {
          return (import('./community')).then((impl) => {
            const communityDatabase = impl.default;
            return communityDatabase.newMessageReceived(access.channelId, message, true);
          });
        }
        else if ('chatId' in access) {
          return (import('./chats')).then((impl) => {
            const chatDatabase = impl.default;
            return chatDatabase.newMessageReceived(access.channelId, message, true);
          });
        }
      }
    });

    await database.putTemporaryItemNoChunkChange({
      ...temporaryItem,
      sendStatus: "sending",
    });
  }

  public async editMessage(
    message: Models.Message.Message,
    update: Partial<Pick<Models.Message.Message, "attachments" | "body">>,
  ) {
    const access = this.accessByChannelId.get(message.channelId);
    if (!access) {
      throw new Error(`ChannelAccess has not been set up for channelId ${message.channelId}`);
    }

    const database = this.channelDatabases.get(access.channelId);
    if (!database) {
      throw new Error("Channel database does not exist");
    }

    const { attachments, body } = update;
    if (attachments === undefined || body === undefined) {
      throw new Error('createItem: body and attachments properties need to be present');
    }
    
    const temporaryItem: Models.Message.Message = {
      ...message,
      sendStatus: "sending",
      body,
      attachments, // use original attachments here
      editedAt: new Date().toISOString(),
    };
    const cleanedAttachments: Models.Message.Attachment[] = attachments.map((attachment) => {
      if (attachment.type === 'image') {
        // this data is not accepeted by the API as it will
        // set it itself
        const { imageData, largeImageData, ...rest } = attachment;
        return rest;
      }
      // Todo: else if (attachment.type === 'giphy') { }
      return attachment;
    });

    messageApi.editMessage({
      id: message.id,
      parentMessageId: message.parentMessageId,
      access,
      attachments: cleanedAttachments, // use cleanedAttachments here
      body,
    })
    .then(result => {
      const finalItem: Models.Message.Message = {
        ...message,
        attachments: result.attachments || attachments || message.attachments,
        body: body || message.body,
        updatedAt: new Date(result.editedAt),
        editedAt: result.editedAt,
      };
      return database.updateItems([finalItem]);
    })
    .catch(e => {
      return database.putTemporaryItemNoChunkChange({
        ...temporaryItem,
        sendStatus: "error-update",
      });
    });

    await database.updateItems([temporaryItem]);
  }

  private apiMessageToMessage(apiMessage: Models.Message.ApiMessage): Models.Message.Message {
    const { createdAt, updatedAt, ...newItem } = apiMessage;
    return {
      ...newItem,
      createdAt: new Date(createdAt),
      updatedAt: new Date(updatedAt),
    };
  }

  public async loadItemWithNeighbours({ channelId, itemId }: { channelId: string, itemId: string }) {
    const access = this.accessByChannelId.get(channelId);
    if (!access) {
      throw new Error(`ChannelAccess has not been set up for channelId ${channelId}`);
    }
    const response = await messageApi.messagesById({ access, messageIds: [itemId] });
    if (response.length !== 1) {
      throw new Error(`Item not found`);
    }

    const [
      createdBeforeItems,
      createdAfterItems,
    ] = await Promise.all([
      messageApi.loadMessages({ access, createdBefore: response[0].createdAt, order: "DESC" }),
      messageApi.loadMessages({ access, createdAfter: response[0].createdAt, order: "ASC" }),
    ]);

    const isStartOfList = createdBeforeItems.length < config.ITEMLIST_BATCH_SIZE;
    const isEndOfList = createdAfterItems.length < config.ITEMLIST_BATCH_SIZE;
    const itemRange = [...createdAfterItems, response[0], ...createdBeforeItems]
    .map(this.apiMessageToMessage)
    .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());

    const db = this.getOrCreateChannelDatabase(access.channelId);
    await db.addCompleteItemRange(itemRange, { isStartOfList, isEndOfList });
  }

  public async loadItems({ channelId, order, createdBefore, createdAfter }: { channelId: string, order?: "ASC" | "DESC", createdBefore?: Date, createdAfter?: Date }) {
    if ((order === "ASC" && !!createdBefore) || (order === "DESC" && !!createdAfter)) {
      throw new Error("Invalid parameters");
    }
    const access = this.accessByChannelId.get(channelId);
    if (!access) {
      throw new Error(`ChannelAccess has not been set up for channelId ${channelId}`);
    }
    const db = this.getOrCreateChannelDatabase(channelId);
    
    const messages = await messageApi.loadMessages({
      access,
      order,
      createdAfter: !!createdAfter ? createdAfter.toISOString() : undefined,
      createdBefore: !!createdBefore ? createdBefore.toISOString() : undefined,
    });

    // if only one of createdBefore or createdAfter is set, we need to set endOfList or startOfList,
    // otherwise ITEMLIST_BATCH_SIZE is not a reliable indicator for start or end of list
    let isStartOfList = false, isEndOfList = false;
    if (!createdBefore && !createdAfter) {
      if (order === "DESC") {
        isEndOfList = true;
        if (messages.length < config.ITEMLIST_BATCH_SIZE) {
          isStartOfList = true;
        }
      }
      else {
        isStartOfList = true;
        if (messages.length < config.ITEMLIST_BATCH_SIZE) {
          isEndOfList = true;
        }
      }
    }
    else if (!createdBefore || !createdAfter) {
      if (!!createdBefore && messages.length < config.ITEMLIST_BATCH_SIZE) {
        isStartOfList = true;
      }
      else if (!!createdAfter && messages.length < config.ITEMLIST_BATCH_SIZE) {
        isEndOfList = true;
      }
    }
    const dbMessages = messages.map(this.apiMessageToMessage);

    await db.addCompleteItemRange(dbMessages, { isStartOfList, isEndOfList, createdAfter, createdBefore });
  };

  public async loadUpdates({ channelId, itemRangeUpdateJobs }: { channelId: string, itemRangeUpdateJobs: Models.ItemList.ItemRangeUpdateJob[] }) {
    const access = this.accessByChannelId.get(channelId);
    if (!access) {
      throw new Error(`ChannelAccess has not been set up for channelId ${channelId}`);
    }

    if (itemRangeUpdateJobs.length > 0) {
      const results = await Promise.all(itemRangeUpdateJobs.map(async job => {
        const result = await messageApi.loadUpdates({
          access,
          createdEnd: job.rangeEnd.toISOString(),
          createdStart: job.rangeStart.toISOString(),
          updatedAfter: job.updatedAfter.toISOString(),
        });
        const rangeUpdate: Models.ItemList.ItemRangeUpdateResult<Models.Message.Message> = {
          updated: result.updated.map(this.apiMessageToMessage),
          deleted: result.deleted,
          job,
        };
        return rangeUpdate;
      }));

      const db = this.getOrCreateChannelDatabase(channelId);
      await db.handleItemRangeUpdates(results);
    }
  };
  
  // Todo: this can be fixed by generating a random id on getMountedChannelDatabase
  // and managing a list of mounted databases, all using the same db "behind the scenes".
  // Needs some testing though.
  private mountedChannelIds = new Set<string>();
  private forceCloseExistingMountedHandle = new Map<string, () => void>(); 
  public getMountedChannelDatabase(channelId: string) {
    let forcefullyClosed = false;
    const existingHandle = this.forceCloseExistingMountedHandle.get(channelId);
    if (!!existingHandle) {
      existingHandle();
      this.forceCloseExistingMountedHandle.delete(channelId);
    }

    if (this.mountedChannelIds.has(channelId)) {
      throw new Error("Only one mounted database handle is allowed. Did you forget to call onUnmount on the previous handle?");
    }
    this.mountedChannelIds.add(channelId);
    const database = this.getOrCreateChannelDatabase(channelId, true);
    const access = this.accessByChannelId.get(channelId);
    let currentSet = openDatabaseHandles.get(channelId);
    if (!currentSet) {
      currentSet = new Set();
      openDatabaseHandles.set(channelId, currentSet);
    }
    currentSet.add(thisRandomTabId);

    const event: DatabaseUIHandlerEvent = {
      action: "register",
      randomTabId: thisRandomTabId,
      access: access!,
    };
    this.broadcastChannel.postMessage(event);

    const onUnmountBroadcastHandler = () => {
      const event: DatabaseUIHandlerEvent = {
        action: "unregister",
        randomTabId: thisRandomTabId,
        access: access!,
      };
      this.broadcastChannel.postMessage(event);
    };

    window.addEventListener("beforeunload", onUnmountBroadcastHandler);

    // forceCloseExistingMountedHandle is a workaround for a bug that only occurs
    // when resizing the window and triggering an isMobile layout switch. Due to
    // how memos work, in that case the new getMountedChannelDatabase call happens
    // before the old memo calls the unmount effect, in which case we close the
    // other db manuall before delivering the new one
    this.forceCloseExistingMountedHandle.set(channelId, () => {
      forcefullyClosed = true;
      window.removeEventListener("beforeunload", onUnmountBroadcastHandler);
      this.mountedChannelIds.delete(channelId);
    });

    return {
      database,
      onUnmount: () => {
        if (!forcefullyClosed) {
          this.mountedChannelIds.delete(channelId);
          const currentSet = openDatabaseHandles.get(channelId);
          currentSet?.delete(thisRandomTabId);
          if (!currentSet?.size) {
            console.log("Removing alwaysInstantFlush for channelId", channelId)
            openDatabaseHandles.delete(channelId);
            database.alwaysInstantFlush = false;
          }
          onUnmountBroadcastHandler();
          window.removeEventListener("beforeunload", onUnmountBroadcastHandler);

          // we can safely do this here because due to the forceCloseHappened check,
          // only one of both functions will ever execute
          this.forceCloseExistingMountedHandle.delete(channelId);

          if (this.tabState === 'passive' || this.tabState === 'passive-throttled') {
            database.close({ markAsStale: false });
          }
          else if (this.tabState === 'active' || this.tabState === 'active-throttled') {
            // Todo: use mount / unmount times to determine if we should close the database
            // Keeping too many dbs open can lead to performance issues if some of them
            // receive a lot of updates
          }
        }
      },
    };
  }

  private getOrCreateChannelDatabase(channelId: string, alwaysInstantFlush?: boolean) {
    const _channelId = channelId;
    const existingDatabase = this.channelDatabases.get(channelId);

    if (!!existingDatabase) {
      if (alwaysInstantFlush !== undefined) {
        existingDatabase.alwaysInstantFlush = alwaysInstantFlush;
      }
      return existingDatabase;
    }

    else {
      const access = this.accessByChannelId.get(_channelId);
      if (!access) {
        throw new Error(`ChannelAccess has not been set up for channelId ${_channelId}`);
      }

      const database = new ChunkedItemDatabase<Models.Message.Message>({
        databaseName: access.channelId,
        alwaysInstantFlush,
      });
      this.channelDatabases.set(access.channelId, database);

      return database;
    }
  }

  public deleteChannelDatabase({ channelId }: { channelId: string }) {
    const database = this.channelDatabases.get(channelId);
    if (!!database) {
      this.channelDatabases.delete(channelId);
      return database.clearDatabase({ close: true });
    }
  }

  public async clear() {
    const channelDatabasesArray = Array.from(this.channelDatabases.entries());
    this.channelDatabases.clear();
    this.accessByChannelId.clear();

    await Dexie.Promise.all(channelDatabasesArray.map<Promise<void>>(async ([ channelId, database ]) => {
      await database.clearDatabase({ close: true });
    }));
  }
}

const channelDatabaseManager = new ChannelDatabaseManager();
export default channelDatabaseManager;