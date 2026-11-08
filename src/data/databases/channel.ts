// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * `data.channelManager`: a thin façade over the tab's chat stores
 * (data/chat/runtime.ts). Messages live in memory in `chat.channels`
 * (ChannelStore); read state in `chat.readState` (ReadStateStore, the only
 * sender of setChannelLastRead) plus the community/chat rows it persists to.
 *
 * Callers use the store API directly (`chat.channels`, `chat.readState`) or
 * the façade's pass-throughs (`openWindow`, `watchMessage`, `createMarker`,
 * `createMessage`, `retrySend`, `discardPending`, `editMessage`,
 * `deleteMessage`, `setReaction`, ...).
 */

import { applyStoredReadState, chat, clearChat, getChatAccountUser, setChatAccountUser, startChatRuntime } from 'data/chat/runtime';
import type { ChannelReadState, ChannelWindow, NewMessage, ReadMarker, Unsubscribe } from 'data/chat/types';
import { isGatewayInstance } from 'common/gateway';

/**
 * A gateway (docs/auth-identity §12) runs no chat stores. The entity
 * databases reach the stores only through this façade (stored rows on page
 * load, snapshots, events): on a gateway it hands them nothing, so the stores
 * are never created.
 */
const chatStoresEnabled = !isGatewayInstance();

type Message = Models.Message.Message;

class ChannelManager {
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
    if (!chatStoresEnabled) return;
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
    if (!chatStoresEnabled) return;
    applyStoredReadState(states);
  }

  // ----- store pass-throughs ---------------------------------------------------

  /** ChannelStore.openWindow: a ref-counted window on the channel's messages */
  public openWindow(channelId: string): ChannelWindow {
    return chat.channels.openWindow(channelId);
  }

  /** ChannelStore.watchMessage: reply parents, pinned messages (no window needed) */
  public watchMessage(
    channelId: string,
    messageId: string,
    onChange: (message: Message | undefined) => void,
    onError?: (error: unknown) => void,
  ): Unsubscribe {
    return chat.channels.watchMessage(channelId, messageId, onChange, onError);
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
    if (!chatStoresEnabled) return undefined;
    chat.channels.forgetChannel(channelId);
    return undefined;
  }

  /** logout: clears messages, read state and notifications of this tab; open windows re-init */
  public async clear(): Promise<void> {
    clearChat();
  }
}

const channelManager = new ChannelManager();
// login.ts loads this before the socket starts: the stores see the first live signal
if (chatStoresEnabled) {
  startChatRuntime();
}
export default channelManager;
