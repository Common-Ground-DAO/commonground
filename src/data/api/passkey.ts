// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import BaseApiConnector from "./baseConnector";

// Passkeys on this instance's own origin (srv/api/passkeys.ts). Not mounted on
// a legacy CG ID (gateway) instance.
class PasskeyApiConnector extends BaseApiConnector {
  constructor() {
    super('Passkey');
  }

  public async registrationOptions(data: API.Passkey.registrationOptions.Request): Promise<API.Passkey.registrationOptions.Response> {
    return await this.ajax<API.Passkey.registrationOptions.Response>("POST", "/registrationOptions", data);
  }

  public async verifyRegistration(data: API.Passkey.verifyRegistration.Request): Promise<API.Passkey.verifyRegistration.Response> {
    return await this.ajax<API.Passkey.verifyRegistration.Response>("POST", "/verifyRegistration", data);
  }

  public async authenticationOptions(data: API.Passkey.authenticationOptions.Request): Promise<API.Passkey.authenticationOptions.Response> {
    return await this.ajax<API.Passkey.authenticationOptions.Response>("POST", "/authenticationOptions", data);
  }

  public async list(): Promise<API.Passkey.list.Response> {
    return await this.ajax<API.Passkey.list.Response>("POST", "/list", {});
  }

  public async rename(data: API.Passkey.rename.Request): Promise<API.Passkey.rename.Response> {
    return await this.ajax<API.Passkey.rename.Response>("POST", "/rename", data);
  }

  public async remove(data: API.Passkey.remove.Request): Promise<API.Passkey.remove.Response> {
    return await this.ajax<API.Passkey.remove.Response>("POST", "/remove", data);
  }
}

const passkeyApi = new PasskeyApiConnector();
export default passkeyApi;
