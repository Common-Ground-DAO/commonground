// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import webSocketManager from "data/appstate/webSocket";
import BaseApiConnector from "./baseConnector";

class MessagesApiConnector extends BaseApiConnector {
  constructor() {
    super('Message');
  }

  public async createMessage(
    data: API.Messages.createMessage.Request
  ): Promise<API.Messages.createMessage.Response> {
    return await this.ajax<API.Messages.createMessage.Response>(
      "POST",
      '/createMessage',
      data
    ); 
  }

  public async createModerationMessage(
    data: API.Messages.createMessage.Request
  ): Promise<API.Messages.createMessage.Response> {
    return await this.ajax<API.Messages.createMessage.Response>(
      "POST",
      '/createModerationMessage',
      data
    ); 
  }

  public async editMessage(
    data: API.Messages.editMessage.Request
  ): Promise<API.Messages.editMessage.Response> {
    return await this.ajax<API.Messages.editMessage.Response>(
      "POST",
      '/editMessage',
      data
    ); 
  }

  public async deleteMessage(
    data: API.Messages.deleteMessage.Request
  ): Promise<API.Messages.deleteMessage.Response> {
    return await this.ajax<API.Messages.deleteMessage.Response>(
      "POST",
      '/deleteMessage',
      data
    ); 
  }

  public async deleteAllUserMessages(
    data: API.Messages.deleteAllUserMessages.Request
  ): Promise<API.Messages.deleteAllUserMessages.Response> {
    return await this.ajax<API.Messages.deleteAllUserMessages.Response>(
      "POST",
      '/deleteAllUserMessages',
      data
    ); 
  }

  public async loadMessages(
    data: API.Messages.loadMessages.Request
  ): Promise<API.Messages.loadMessages.Response> {
    return await this.ajax<API.Messages.loadMessages.Response>(
      "POST",
      '/loadMessages',
      data
    ); 
  }
  
  public async messagesById(
    data: API.Messages.messagesById.Request
  ): Promise<API.Messages.messagesById.Response> {
    return await this.ajax<API.Messages.messagesById.Response>(
      "POST",
      '/messagesById',
      data
    ); 
  }

  public async loadUpdates(
    data: API.Messages.loadUpdates.Request
  ): Promise<API.Messages.loadUpdates.Response> {
    return await this.ajax<API.Messages.loadUpdates.Response>(
      "POST",
      '/loadUpdates',
      data
    ); 
  }

  /** chat-sync catch-up of one channel (404 on servers before chat-sync) */
  public async getChanges(
    data: API.Messages.getChanges.Request
  ): Promise<API.Messages.getChanges.Response> {
    return await this.ajax<API.Messages.getChanges.Response>(
      "POST",
      '/getChanges',
      data
    );
  }

  /** chat-sync read-only snapshot of all readable channels (404 on servers before chat-sync) */
  public async getSyncState(
    data: API.Messages.getSyncState.Request
  ): Promise<API.Messages.getSyncState.Response> {
    return await this.ajax<API.Messages.getSyncState.Response>(
      "POST",
      '/getSyncState',
      data
    );
  }

  public async setReaction(
    data: API.Messages.setReaction.Request
  ): Promise<API.Messages.setReaction.Response> {
    return await this.ajax<API.Messages.setReaction.Response>(
      "POST",
      '/setReaction',
      data
    ); 
  }

  // FIXME: Require access to unset reaction
  public async unsetReaction(
    data: API.Messages.unsetReaction.Request
  ): Promise<API.Messages.unsetReaction.Response> {
    return await this.ajax<API.Messages.unsetReaction.Response>(
      "POST",
      '/unsetReaction',
      data
    ); 
  }

  public async setChannelLastRead(
    data: API.Messages.setChannelLastRead.Request
  ): Promise<API.Messages.setChannelLastRead.Response> {
    return await this.ajax<API.Messages.setChannelLastRead.Response>(
      "POST",
      '/setChannelLastRead',
      data
    );
  }

  public async getUrlPreview(
    data: API.Messages.getUrlPreview.Request
  ): Promise<API.Messages.getUrlPreview.Response> {
    return await this.ajax<API.Messages.getUrlPreview.Response>(
      "POST",
      '/getUrlPreview',
      data
    );
  }

  public async joinArticleEventRoom(
    data: API.Messages.joinArticleEventRoom.Request
  ): Promise<API.Messages.joinArticleEventRoom.Response> {
    return this.ajax<API.Messages.joinArticleEventRoom.Response>(
      "POST",
      '/joinArticleEventRoom',
      data
    );
  }

  public async leaveArticleEventRoom(
    data: API.Messages.leaveArticleEventRoom.Request
  ): Promise<API.Messages.leaveArticleEventRoom.Response> {
    return this.ajax<API.Messages.leaveArticleEventRoom.Response>(
      "POST",
      '/leaveArticleEventRoom',
      data
    );
  }
}

const messageApi = new MessagesApiConnector();
export default messageApi;