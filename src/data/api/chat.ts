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
}

const chatApi = new ChatApiConnector();
export default chatApi;