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
import { ChatApi, CommunityApi, MessageApi, SocialGraphApi } from "./social/api.js";
import { FileApi } from "./files/api.js";
import { NotificationApi } from "./notifications/api.js";
import { ProfileApi } from "./profile/api.js";
import { CallApi } from "./calls/api.js";
import { BotManagementApi } from "./bot/api.js";
import { RealtimeClient, type RealtimeOptions } from "./realtime/socket.js";
import { SyncStore } from "./realtime/store.js";

export interface CommonGroundClientOptions extends HttpTransportOptions {}

export class CommonGroundClient {
  readonly transport: HttpTransport;
  readonly auth: AuthApi;
  readonly communities: CommunityApi;
  readonly messages: MessageApi;
  readonly chats: ChatApi;
  readonly social: SocialGraphApi;
  readonly files: FileApi;
  readonly notifications: NotificationApi;
  readonly profile: ProfileApi;
  readonly calls: CallApi;
  /** Session-side bot management (create/own bots, issue tokens). */
  readonly bots: BotManagementApi;

  constructor(options: CommonGroundClientOptions) {
    this.transport = new HttpTransport(options);
    this.auth = new AuthApi(this.transport);
    this.communities = new CommunityApi(this.transport);
    this.messages = new MessageApi(this.transport);
    this.chats = new ChatApi(this.transport);
    this.social = new SocialGraphApi(this.transport);
    this.files = new FileApi(this.transport);
    this.notifications = new NotificationApi(this.transport);
    this.profile = new ProfileApi(this.transport);
    this.calls = new CallApi(this.transport);
    this.bots = new BotManagementApi(this.transport);
  }

  /** New realtime connection sharing this client's session cookie. */
  realtime(options: RealtimeOptions = {}): RealtimeClient {
    return new RealtimeClient(this.transport, options);
  }

  /** New empty sync store (hydrate from a login response, attach realtime). */
  store(): SyncStore {
    return new SyncStore();
  }

  get baseUrl(): string {
    return this.transport.baseUrl;
  }

  /** `GET /Instance/config` — the instance's public identity/capabilities. */
  async getInstanceConfig(): Promise<InstanceConfig> {
    return fetchInstanceConfig(this.transport);
  }
}
