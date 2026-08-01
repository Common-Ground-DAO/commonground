// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import BaseApiConnector from "./baseConnector";

class AccountsApiConnector extends BaseApiConnector {
  constructor() {
    super('Accounts');
  }

  public async farcasterVerifyLogin(data: API.Accounts.Farcaster.verifyLogin.Request): Promise<API.Accounts.Farcaster.verifyLogin.Response> {
    return await this.ajax<API.Accounts.Farcaster.verifyLogin.Response>(
      "POST",
      '/Farcaster/verifyLogin',
      data,
    );
  }
}

const accountsApi = new AccountsApiConnector();
export default accountsApi;