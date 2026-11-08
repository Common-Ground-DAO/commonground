// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import BaseApiConnector from 'data/api/baseConnector';

/**
 * The one call only the gateway's web app makes (docs/auth-identity §12):
 * a one-time link that signs the session's account in on the instance this
 * one moved to (User/createTransferLink, docs/auth-identity §11).
 */
class GatewayApiConnector extends BaseApiConnector {
  constructor() {
    super('User');
  }

  public async createTransferLink(data: API.User.createTransferLink.Request): Promise<API.User.createTransferLink.Response> {
    return await this.ajax<API.User.createTransferLink.Response>('POST', '/createTransferLink', data);
  }
}

const gatewayApi = new GatewayApiConnector();
export default gatewayApi;
