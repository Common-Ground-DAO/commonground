/**
 * CommonGroundClient — the SDK entry point.
 *
 * One client instance = one (instance origin, identity) pair. Modules hang
 * off it as lazy namespaces; everything speaks pure HTTP/WS through the
 * shared transport (no browser APIs anywhere — that's the design rule that
 * makes this the reference for native clients).
 */

import { HttpTransport, type HttpTransportOptions } from "./transport/http.js";
import { fetchInstanceConfig, type InstanceConfig } from "./instance.js";
import { AuthApi } from "./auth/api.js";

export interface CommonGroundClientOptions extends HttpTransportOptions {}

export class CommonGroundClient {
  readonly transport: HttpTransport;
  readonly auth: AuthApi;

  constructor(options: CommonGroundClientOptions) {
    this.transport = new HttpTransport(options);
    this.auth = new AuthApi(this.transport);
  }

  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  /** `GET /Instance/config` — the instance's public identity/capabilities. */
  async getInstanceConfig(): Promise<InstanceConfig> {
    return fetchInstanceConfig(this.transport);
  }
}
