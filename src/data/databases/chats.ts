// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import userApi from "../api/user";
import { Dexie } from "dexie";
import AbstractDatabase, {
  IdbSetupInfo,
  LocalWriteStamp,
  deletableBySnapshot,
  snapshotRequestStart,
  withLocalWriteStamp,
} from "./abstractDatabase";
import chatApi from "../api/chat";
import connectionManager from "../appstate/connection";
import channelDatabaseManager from "./channel";
import { isEqual } from "lodash";
import { mergeReadState, sameReadState } from "data/chat/mergeReadState";
import type { ChannelReadState, ReadStateInput } from "data/chat/types";
import {
  chatFromApi,
  chatRowReadState,
  mergeChatSnapshot,
  messageInput,
  newerLastMessage,
  readStateRowFields,
  serverLastReadAfter,
  type StoredChat,
} from "./readStateRows";

class ChatDatabase extends AbstractDatabase<{
  chats: Dexie.Table<StoredChat & LocalWriteStamp, string>;
}> {
  constructor() {
    super('chat');

    // initialize: the in-memory read state starts from the stored rows
    // (none on a gateway, which never opens the database)
    if (this.localData) {
      this.registerStoredChats();
    }
  }

  /**
   * Registers the stored DMs' access and read state in this tab's chat
   * stores: on page load, and when the tab takes over the login of another
   * tab (which wrote the rows; a logout before cleared the stores).
   */
  public async registerStoredChats(): Promise<void> {
    try {
      this.registerChatLastRead(await this.db.chats.toArray());
    } catch (e) {
      console.error(`Error initializing channel access for chat channels`, e);
    }
  }

  protected setUpDb(info: IdbSetupInfo): void {
    this.db.version(2).stores({
      chats: '&id,channelId',
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
    connectionManager.registerClientEventHandler(
      "cliChatEvent",
      async event => {
        if (event.action === "new") {
          await this.putChatSnapshots([chatFromApi(event.data)]);
        }
        else if (event.action === "delete") {
          const existing = await this.db.chats.get(event.data.id);
          if (existing) {
            await this.db.chats.delete(event.data.id);
            await channelDatabaseManager.deleteChannelDatabase({ channelId: existing.channelId });
          }
        }
        // Todo: update event
      }
    );
  }

  protected onConnectionLoss(lastKnownConnectionTime: number): void {
    this.lastKnownConnectionTime = lastKnownConnectionTime;
  }

  protected onConnectionRestored(): void {

  }

  private _setupPromise: Promise<void> | undefined;
  /**
   * `options.requestStartedAt` (client clock, ms): when the request for this
   * snapshot started; chats an event or startChat wrote after it are not
   * deleted. Without it, SNAPSHOT_REQUEST_MARGIN_MS before now is assumed.
   */
  public async setupAfterLogin(chats: Models.Chat.ChatFromApi[], options?: { requestStartedAt?: number }): Promise<void> {
    const requestStartedAt = snapshotRequestStart(options?.requestStartedAt);
    if (!this._setupPromise) {
      this._setupPromise = new Promise<void>(async (resolve, reject) => {
        let rejected = false;
        const susTimeout = setTimeout(() => {
          console.log("ChatDatabase.setupAfterLogin is taking longer than 7s, cancelling...");
          rejected = true;
          reject(new Error("ChatDatabase.setupAfterLogin timed out"));
        }, 7_000);
    
        try {
          const newChats = chats.map(chatFromApi);
          for (const chat of newChats) {
            // the lastRead guard is seeded after the merge below
            channelDatabaseManager.registerAccessForChannel({
              channelId: chat.channelId,
              chatId: chat.id,
            });
          }

          if (!rejected) {
            // one transaction on fresh rows: another tab may write the same
            // chats meanwhile; read state and lastMessage are merged, never
            // replaced by an older snapshot
            const { stored, channelIdsToDelete } = await this.db.transaction('rw', this.db.chats, async () => {
              const oldChats = await this.db.chats.toArray();
              const oldChatsById = new Map(oldChats.map(c => [c.id, c]));
              const toPut: StoredChat[] = [];
              const stored: StoredChat[] = [];
              for (const newChat of newChats) {
                const oldChat = oldChatsById.get(newChat.id);
                oldChatsById.delete(newChat.id);
                const merged = mergeChatSnapshot(oldChat, newChat);
                if (!oldChat || !isEqual(oldChat, merged)) {
                  toPut.push(merged);
                }
                stored.push(merged);
              }
              // remaining chats in oldChatsById don't have a counterpart in
              // newChats and need to be deleted, unless an event wrote them
              // after this snapshot's request started
              const chatsToDelete = Array.from(oldChatsById.values()).filter(c => deletableBySnapshot(c, requestStartedAt));
              console.log(`Updating ${toPut.length} chats, deleting ${chatsToDelete.length} chats`);
              await this.db.chats.bulkDelete(chatsToDelete.map(c => c.id));
              await this.db.chats.bulkPut(toPut);
              return { stored, channelIdsToDelete: chatsToDelete.map(c => c.channelId) };
            });
            this.registerChatLastRead(stored);

            const results = await Dexie.Promise.allSettled(
              channelIdsToDelete.map(channelId => channelDatabaseManager.deleteChannelDatabase({ channelId })).filter(Boolean),
            );
            for (const result of results) {
              if (result.status === 'rejected') {
                console.error("Error deleting chat database", result.reason);
              }
            }
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

  /**
   * Applies one read-state input to the DM row with this channelId: re-reads
   * the row and merges with mergeReadState in one rw transaction (idempotent,
   * order-safe across tabs). A received `message` also becomes the row's
   * `lastMessage` if it is newer. Resolves to the merged state, or undefined
   * if no such chat row exists.
   */
  public async applyReadState(input: ReadStateInput, message?: Models.Message.Message): Promise<ChannelReadState | undefined> {
    return this.db.transaction('rw', this.db.chats, async () => {
      const row = await this.db.chats.where('channelId').equals(input.channelId).first();
      if (!row) return undefined;
      const before = chatRowReadState(row);
      const after = mergeReadState(before, input);
      const serverLastRead = serverLastReadAfter(row.serverLastRead, input);
      const lastMessage = message ? newerLastMessage(row.lastMessage, message) : row.lastMessage;
      if (!sameReadState(before, after) || lastMessage !== row.lastMessage || serverLastRead !== (row.serverLastRead ?? null)) {
        await this.db.chats.update(row.id, { ...readStateRowFields(after), serverLastRead, lastMessage });
      }
      return after;
    });
  }

  /** the stored read state of a DM, if the row exists */
  public async getReadState(channelId: string): Promise<ChannelReadState | undefined> {
    const row = await this.db.chats.where('channelId').equals(channelId).first();
    return row ? chatRowReadState(row) : undefined;
  }

  /**
   * Local read mark or cliChannelLastRead echo: lastRead only moves forward,
   * and every call re-evaluates the stored row (no in-memory guard that could
   * keep a restored count from being cleared again).
   */
  public async setChannelLastRead(channelId: string, lastRead: Date) {
    await this.applyReadState({ kind: 'lastRead', channelId, lastRead: lastRead.toISOString() });
  }

  /**
   * A new message in a DM (live event of another user, or an own message).
   * Counted at most once per message across tabs: by its syncSeq, or (older
   * servers) only if newer than every message seen.
   */
  public newMessageReceived(channelId: string, message: Models.Message.Message, isOwnMessage: boolean): Promise<void> {
    return this.applyReadState(messageInput(channelId, message, isOwnMessage), message)
      .then(() => undefined)
      .catch(e => {
        console.error("Error applying new message to chat read state", e);
      });
  }

  /** chat snapshots (event, startChat): merged with the stored rows in one transaction */
  private async putChatSnapshots(chats: Models.Chat.Chat[]) {
    for (const chat of chats) {
      channelDatabaseManager.registerAccessForChannel({ channelId: chat.channelId, chatId: chat.id });
    }
    const merged = await this.db.transaction('rw', this.db.chats, async () => {
      const stored = await this.db.chats.bulkGet(chats.map(c => c.id));
      const merged = chats.map((chat, i) => withLocalWriteStamp(mergeChatSnapshot(stored[i], chat)));
      await this.db.chats.bulkPut(merged);
      return merged;
    });
    this.registerChatLastRead(merged);
  }

  /**
   * Registers the DMs' access (with what the server is known to hold,
   * `serverLastRead`) and hands their merged read state to the in-memory
   * read-state store (data.channelManager.applyStoredReadState), so a
   * snapshot is merged into the rows once and mirrored in memory.
   */
  private registerChatLastRead(chats: StoredChat[]) {
    for (const chat of chats) {
      channelDatabaseManager.registerAccessForChannel({
        channelId: chat.channelId,
        chatId: chat.id,
      }, chat.serverLastRead ? { lastRead: chat.serverLastRead } : undefined);
    }
    channelDatabaseManager.applyStoredReadState(chats.map(chatRowReadState));
  }

  public async clear() {
    await this.db.chats.clear();
  }

  public async createChat(otherUserId: string) {
    const newChat = await chatApi.startChat({ otherUserId });
    await this.putChatSnapshots([chatFromApi(newChat)]);
    return newChat;
  }

  public async update(userData: Partial<Omit<Models.User.OwnData, 'id' | 'premiumFeatures'>>) {
    await userApi.updateOwnData(userData);
  }

  public async getAllChats() {
    return await this.db.chats.toArray();
  }

  public async getAllChatsWithLastMessage() {
    const chats = await this.db.chats.toArray();
    // Todo: Add last messages
    return chats;
  }

  public async closeChat(chatId: string) {
    await chatApi.closeChat({ chatId });
    const existing = await this.db.chats.get(chatId);
    if (existing) {
      await this.db.chats.delete(chatId);
      await channelDatabaseManager.deleteChannelDatabase({ channelId: existing.channelId });
    }
  }
}

const chatDatabase = new ChatDatabase();
export default chatDatabase;