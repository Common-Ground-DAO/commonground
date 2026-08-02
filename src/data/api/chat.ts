// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import BaseApiConnector from "./baseConnector";

class ChatApiConnector extends BaseApiConnector {
  constructor() {
    super('Chat');
  }
  
  public async startChat(
    data: API.Chat.startChat.Request
  ): Promise<API.Chat.startChat.Response> {
    return await this.ajax<API.Chat.startChat.Response>(
      "POST",
      '/startChat',
      data
    );
  }
  
  public async closeChat(
    data: API.Chat.closeChat.Request
  ): Promise<API.Chat.closeChat.Response> {
    return await this.ajax<API.Chat.closeChat.Response>(
      "POST",
      '/closeChat',
      data
    );
  }

  public async getChats(
    data: API.Chat.getChats.Request
  ): Promise<API.Chat.getChats.Response> {
    return await this.ajax<API.Chat.getChats.Response>(
      "POST",
      '/getChats',
      data
    );
  }

  public async getOwnAssistantChats(
    data: API.Chat.getOwnAssistantChats.Request
  ): Promise<API.Chat.getOwnAssistantChats.Response> {
    return await this.ajax<API.Chat.getOwnAssistantChats.Response>(
      "POST",
      '/getOwnAssistantChats',
      data
    );
  }

  public async loadAssistantChat(
    data: API.Chat.loadAssistantChat.Request
  ): Promise<API.Chat.loadAssistantChat.Response> {
    return await this.ajax<API.Chat.loadAssistantChat.Response>(
      "POST",
      '/loadAssistantChat',
      data
    );
  }

  public async startAssistantChat(
    data: API.Chat.startAssistantChat.Request
  ): Promise<API.Chat.startAssistantChat.Response> {
    return await this.ajax<API.Chat.startAssistantChat.Response>(
      "POST",
      '/startAssistantChat',
      data
    );
  }

  public async continueAssistantChat(
    data: API.Chat.continueAssistantChat.Request
  ): Promise<API.Chat.continueAssistantChat.Response> {
    return await this.ajax<API.Chat.continueAssistantChat.Response>(
      "POST",
      '/continueAssistantChat',
      data
    );
  }

  public async deleteAssistantChat(
    data: API.Chat.deleteAssistantChat.Request
  ): Promise<API.Chat.deleteAssistantChat.Response> {
    return await this.ajax<API.Chat.deleteAssistantChat.Response>(
      "POST",
      '/deleteAssistantChat',
      data
    );
  }

  public async getAssistantQueueData(
    data: API.Chat.getAssistantQueueData.Request
  ): Promise<API.Chat.getAssistantQueueData.Response> {
    return await this.ajax<API.Chat.getAssistantQueueData.Response>(
      "POST",
      '/getAssistantQueueData',
      data
    );
  }

  public async getAssistantAvailability(): Promise<API.Chat.getAssistantAvailability.Response> {
    return await this.ajax<API.Chat.getAssistantAvailability.Response>(
      "POST",
      '/getAssistantAvailability',
      undefined
    );
  }
}

const chatApi = new ChatApiConnector();
export default chatApi;