// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import BaseApiConnector from "./baseConnector";

class BotApiConnector extends BaseApiConnector {
  constructor() {
    super('Bot');
  }

  public async listBots(data: API.Bot.listBots.Request): Promise<API.Bot.listBots.Response> {
    return await this.ajax<API.Bot.listBots.Response>(
      "POST",
      "/list",
      data,
    );
  }

  public async listCommunityBots(data: API.Bot.listCommunityBots.Request): Promise<API.Bot.listCommunityBots.Response> {
    return await this.ajax<API.Bot.listCommunityBots.Response>(
      "POST",
      "/listCommunityBots",
      data,
    );
  }

  public async createBot(data: API.Bot.createBot.Request): Promise<API.Bot.createBot.Response> {
    return await this.ajax<API.Bot.createBot.Response>(
      "POST",
      "/create",
      data,
    );
  }

  public async updateBot(data: API.Bot.updateBot.Request): Promise<API.Bot.updateBot.Response> {
    return await this.ajax<API.Bot.updateBot.Response>(
      "POST",
      "/update",
      data,
    );
  }

  public async disableBot(data: API.Bot.disableBot.Request): Promise<API.Bot.disableBot.Response> {
    return await this.ajax<API.Bot.disableBot.Response>(
      "POST",
      "/disable",
      data,
    );
  }

  public async installBot(data: API.Bot.installBot.Request): Promise<API.Bot.installBot.Response> {
    return await this.ajax<API.Bot.installBot.Response>(
      "POST",
      "/install",
      data,
    );
  }

  public async removeBot(data: API.Bot.removeBot.Request): Promise<API.Bot.removeBot.Response> {
    return await this.ajax<API.Bot.removeBot.Response>(
      "POST",
      "/remove",
      data,
    );
  }

  public async setBotRoles(data: API.Bot.setBotRoles.Request): Promise<API.Bot.setBotRoles.Response> {
    return await this.ajax<API.Bot.setBotRoles.Response>(
      "POST",
      "/setRoles",
      data,
    );
  }

  public async setAllowUserBots(data: API.Bot.setAllowUserBots.Request): Promise<API.Bot.setAllowUserBots.Response> {
    return await this.ajax<API.Bot.setAllowUserBots.Response>(
      "POST",
      "/setAllowUserBots",
      data,
    );
  }

  public async issueToken(data: API.Bot.issueToken.Request): Promise<API.Bot.issueToken.Response> {
    return await this.ajax<API.Bot.issueToken.Response>(
      "POST",
      "/tokens/issue",
      data,
    );
  }

  public async listTokens(data: API.Bot.listTokens.Request): Promise<API.Bot.listTokens.Response> {
    return await this.ajax<API.Bot.listTokens.Response>(
      "POST",
      "/tokens/list",
      data,
    );
  }

  public async revokeToken(data: API.Bot.revokeToken.Request): Promise<API.Bot.revokeToken.Response> {
    return await this.ajax<API.Bot.revokeToken.Response>(
      "POST",
      "/tokens/revoke",
      data,
    );
  }
}

export default new BotApiConnector();
