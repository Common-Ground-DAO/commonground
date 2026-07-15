// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import BaseApiConnector from "./baseConnector";

class StakingApiConnector extends BaseApiConnector {
  constructor() {
    super('Staking');
  }

  public async getConfig(): Promise<API.Staking.getConfig.Response> {
    return await this.ajax<API.Staking.getConfig.Response>("POST", "/getConfig", undefined);
  }

  public async getPositions(): Promise<API.Staking.getPositions.Response> {
    return await this.ajax<API.Staking.getPositions.Response>("POST", "/getPositions", undefined);
  }
}

export default new StakingApiConnector();
