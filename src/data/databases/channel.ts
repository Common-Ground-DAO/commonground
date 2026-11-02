// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * `data.channelManager`: a thin façade over the tab's chat stores
 * (data/chat/runtime.ts). Messages live in memory in `chat.channels`
 * (ChannelStore); read state in `chat.readState` (ReadStateStore, the only
 * sender of setChannelLastRead) plus the community/chat rows it persists to.
 *
 * New code uses the store API directly or through the façade's pass-throughs
 * (`openWindow`, `watchMessage`, `createMarker`, `createMessage`, `retrySend`,
 * `discardPending`, `editMessage`, `deleteMessage`, `setReaction`, ...). The
 * members marked @deprecated keep the list components of before chat-sync
 * working until they are moved to windows; they go with them.
 */

import { applyStoredReadState, chat, clearChat, getChatAccountUser, setChatAccountUser, startChatRuntime } from 'data/chat/runtime';
import type { ChannelReadState, ChannelWindow, NewMessage, ReadMarker, Unsubscribe } from 'data/chat/types';
import { LegacyItemList } from './channelLegacyList';

type Message = Models.Message.Message;

class ChannelManager {
  /** @deprecated interim: legacy lists per channel (for setChannelLastRead) */
  private readonly legacyLists = new Map<string, Set<LegacyItemList>>();

  /**
   * The account of this tab, set by login.ts (`undefined` after logout).
   * The stores see it as ChatEventSource.userId while the login state is
   * `loggedin`.
   */
  public get userId(): string | undefined {
    return getChatAccountUser();
  }
  public set userId(userId: string | undefined) {
    setChatAccountUser(userId);
  }

  // ----- access --------------------------------------------------------------

  /**
   * Remember how to address a channel (idempotent). `_data` (the row's
   * `serverLastRead`, from the entity databases) is not used: the
   * read-state store decides sends from its own server-acknowledged value
   * (getSyncState, cliChannelLastRead, setChannelLastRead answers, own
   * posts); stored read state comes in through `applyStoredReadState`.
   */
  public registerAccessForChannel(access: API.Messages.MessageAccess, _data?: { lastRead: string }) {
    chat.channels.registerAccessForChannel(access);
  }

  /** The full MessageAccess (community/chat/call/article variant) for a channel, if known. */
  public getAccessForChannel(channelId: string): API.Messages.MessageAccess | undefined {
    return chat.channels.getAccessForChannel(channelId);
  }

  /**
   * Read state of community channels / DMs as the entity databases stored it
   * after a snapshot (login, getOwnCommunities, getChats, community/chat
   * events, page load): merged into `chat.readState` in memory only, since
   * the rows already hold it.
   */
  public applyStoredReadState(states: ChannelReadState[]) {
    applyStoredReadState(states);
  }

  // ----- store pass-throughs ---------------------------------------------------

  /** ChannelStore.openWindow: a ref-counted window on the channel's messages */
  public openWindow(channelId: string): ChannelWindow {
    return chat.channels.openWindow(channelId);
  }

  /** ChannelStore.watchMessage: reply parents, pinned messages (no window needed) */
  public watchMessage(channelId: string, messageId: string, onChange: (message: Message | undefined) => void): Unsubscribe {
    return chat.channels.watchMessage(channelId, messageId, onChange);
  }

  /** ReadStateStore.createMarker: one per mounted message window */
  public createMarker(channelId: string): ReadMarker {
    return chat.readState.createMarker(channelId);
  }

  /**
   * Send; resolves once the pending item is shown and never rejects (the
   * outcome is the item's `sendStatus`). `creatorId` is ignored: the sender
   * is the logged-in user.
   */
  public createMessage(
    data: Pick<Message, "attachments" | "body" | "parentMessageId" | "channelId"> & { creatorId?: string },
    isModerationMessage: boolean = false,
  ): Promise<void> {
    const message: NewMessage = {
      channelId: data.channelId,
      body: data.body,
      attachments: data.attachments,
      parentMessageId: data.parentMessageId,
    };
    return chat.channels.createMessage(message, { moderation: isModerationMessage });
  }

  public retrySend(channelId: string, messageId: string): Promise<void> {
    return chat.channels.retrySend(channelId, messageId);
  }

  public discardPending(channelId: string, messageId: string): void {
    chat.channels.discardPending(channelId, messageId);
  }

  /** like createMessage: resolves once the overlay is shown, never rejects; failure = `error-update` */
  public editMessage(message: Message, update: Partial<Pick<Message, "attachments" | "body" | "parentMessageId">>): Promise<void> {
    return chat.channels.editMessage(message, {
      body: update.body ?? message.body,
      attachments: update.attachments ?? message.attachments,
      parentMessageId: update.parentMessageId !== undefined ? update.parentMessageId : message.parentMessageId,
    });
  }

  /** rejects on failure */
  public deleteMessage(channelId: string, messageId: string, creatorId: string): Promise<void> {
    return chat.channels.deleteMessage(channelId, messageId, creatorId);
  }

  /** rejects on failure */
  public setReaction(channelId: string, message: Pick<Message, 'id'>, reaction: string): Promise<void> {
    return chat.channels.setReaction(channelId, message.id, reaction);
  }

  /** rejects on failure */
  public unsetReaction(channelId: string, message: Pick<Message, 'id'>): Promise<void> {
    return chat.channels.unsetReaction(channelId, message.id);
  }

  /** drop everything of a channel (left community, closed chat) */
  public deleteChannelDatabase({ channelId }: { channelId: string }): undefined {
    chat.channels.forgetChannel(channelId);
    return undefined;
  }

  /** logout: clears messages, read state and notifications of this tab; open windows re-init */
  public async clear(): Promise<void> {
    clearChat();
  }

  // ----- @deprecated: callers of before chat-sync ------------------------------

  /**
   * @deprecated use `watchMessage`. Resolves with the message once it is
   * known (from memory, else fetched); later changes go to `onchange`.
   */
  public getMessageById(
    channelId: string,
    id: string,
    onchange: (item: Message | undefined) => void,
  ): Promise<{ item?: Message; unsubscribe: () => void }> {
    return new Promise(resolve => {
      let first = true;
      let unsubscribe: Unsubscribe = () => undefined;
      let unsubscribed = false;
      const result = {
        item: undefined as Message | undefined,
        unsubscribe: () => {
          unsubscribed = true;
          unsubscribe();
        },
      };
      unsubscribe = chat.channels.watchMessage(channelId, id, message => {
        if (first) {
          first = false;
          result.item = message;
          resolve(result);
        } else if (!unsubscribed) {
          onchange(message);
        }
      });
      if (unsubscribed) unsubscribe();
    });
  }

  /**
   * @deprecated the list marks through `createMarker(channelId).update(...)`.
   * One mark up to the shown message with this createdAt (the newest shown
   * one at or before it), through the read-state store.
   */
  public setChannelLastRead(channelId: string, lastRead: Date) {
    const t = lastRead.getTime();
    let newest: Message | undefined;
    for (const list of this.legacyLists.get(channelId) ?? []) {
      for (const item of list.window.state.items) {
        if (item.sendStatus !== undefined) continue;
        const ms = item.createdAt.getTime();
        if (ms <= t && (!newest || ms > newest.createdAt.getTime())) newest = item;
      }
    }
    if (!newest) return;
    const marker = chat.readState.createMarker(channelId);
    marker.update({ atLatest: true, atBottom: true, newest: { id: newest.id, createdAt: newest.createdAt } });
    marker.dispose();
  }

  /** @deprecated windows load by themselves */
  public async loadItems(_options: { channelId: string, order?: "ASC" | "DESC", createdBefore?: Date, createdAfter?: Date }): Promise<void> {
    // nothing to do
  }

  /** @deprecated windows reconcile by themselves */
  public async loadUpdates(_options: { channelId: string, itemRangeUpdateJobs: Models.ItemList.ItemRangeUpdateJob[] }): Promise<void> {
    // nothing to do
  }

  /** @deprecated `init({ type: 'atItemId' })` fetches the item and its neighbours itself */
  public async loadItemWithNeighbours(_options: { channelId: string, itemId: string }): Promise<void> {
    // nothing to do
  }

  /**
   * @deprecated use `openWindow`. A handle whose `createItemList` opens a
   * window (old ItemList interface); `onUnmount` destroys the lists it
   * created. Any number of handles per channel.
   */
  public getMountedChannelDatabase(channelId: string) {
    const lists = new Set<LegacyItemList>();
    const database = {
      createItemList: (_scheduleItemRangeUpdate?: (job: Models.ItemList.ItemRangeUpdateJob) => void): Models.ItemList.ItemList<Message> => {
        const list = new LegacyItemList(chat.channels.openWindow(channelId), l => {
          lists.delete(l);
          const set = this.legacyLists.get(channelId);
          set?.delete(l);
          if (set?.size === 0) this.legacyLists.delete(channelId);
        });
        lists.add(list);
        let set = this.legacyLists.get(channelId);
        if (!set) this.legacyLists.set(channelId, (set = new Set()));
        set.add(list);
        return list;
      },
    };
    return {
      database,
      onUnmount: () => {
        for (const list of [...lists]) list.destroy(false);
      },
    };
  }
}

const channelManager = new ChannelManager();
// login.ts loads this before the socket starts: the stores see the first live signal
startChatRuntime();
export default channelManager;
