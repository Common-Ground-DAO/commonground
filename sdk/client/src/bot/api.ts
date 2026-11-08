/**
 * Bot management (session side) + the bot bearer client.
 *
 * Two halves of the bot story:
 *  - `BotManagementApi` — a logged-in USER creating/owning bots and issuing
 *    tokens (srv/api/bots.ts, POST /Bot/*, cookie-authed).
 *  - `BotClient` — a bot acting on its own behalf with a bearer token
 *    (srv/api/botV1.ts under /api/bot/v1/*, `Authorization: Bearer cgb_...`,
 *    NO cookie — the two are mutually exclusive server-side).
 *
 * A bot IS a user (is_bot), so once authenticated its realtime socket and
 * message sending are the same machinery the human SDK already speaks — which
 * is why bot coverage is a thin addition, not a parallel client.
 */

import { HttpTransport } from "../transport/http.js";
import { RealtimeClient, type RealtimeOptions } from "../realtime/socket.js";
import { MessageApi } from "../social/api.js";

export type BotOwnerType = "community" | "user" | "platform";

export interface CreateBotOptions {
  ownerType: BotOwnerType;
  /** required for user/community owners; omit for platform */
  ownerId?: string;
  /** cg display name, /^[a-z0-9_-]{3,30}$/i */
  username: string;
  description?: string;
  imageId?: string | null;
}

export interface BotView {
  /** the bot's user id — this is what tokens/messages key on */
  userId: string;
  deviceId: string;
  ownerType: BotOwnerType;
  ownerId: string | null;
  username: string;
  imageId: string | null;
  description: string | null;
  communityIds: string[];
  connectionStatus: "connected" | "offline";
  [extra: string]: unknown;
}

export interface IssuedToken {
  /** the raw `cgb_...` token — shown ONCE, store it now */
  token: string;
  tokenData: Record<string, unknown>;
}

/** Session-authenticated: a user managing the bots they own. */
export class BotManagementApi {
  constructor(private readonly transport: HttpTransport) {}

  /** POST /Bot/create — create a bot the caller owns. */
  async create(options: CreateBotOptions): Promise<BotView> {
    return this.transport.call("Bot/create", {
      ownerType: options.ownerType,
      ...(options.ownerId !== undefined ? { ownerId: options.ownerId } : {}),
      username: options.username,
      imageId: options.imageId ?? null,
      description: options.description ?? "",
    });
  }

  /** POST /Bot/tokens/issue → the raw token (shown once) + metadata. */
  async issueToken(botUserId: string, name: string | null = null): Promise<IssuedToken> {
    return this.transport.call("Bot/tokens/issue", { botUserId, name });
  }

  async listTokens(botUserId: string): Promise<unknown[]> {
    return this.transport.call("Bot/tokens/list", { botUserId });
  }

  async revokeToken(botUserId: string, tokenId: string): Promise<void> {
    await this.transport.call("Bot/tokens/revoke", { botUserId, tokenId });
  }

  async listBots(): Promise<BotView[]> {
    return this.transport.call("Bot/list");
  }

  /** POST /Bot/setBotRoles — grant a community bot roles (for channel
   * permissions like CHANNEL_WRITE). Caller must manage the community. */
  async setBotRoles(botUserId: string, communityId: string, roleIds: string[]): Promise<void> {
    await this.transport.call("Bot/setRoles", { botUserId, communityId, roleIds });
  }

  async disableBot(botUserId: string): Promise<void> {
    await this.transport.call("Bot/disable", { botUserId });
  }
}

export interface BotClientOptions {
  baseUrl: string;
  /** the `cgb_...` bearer token */
  token: string;
  fetch?: typeof fetch;
}

export interface BotIdentity {
  protocolVersion: string;
  userId: string;
  deviceId: string;
  tokenId: string;
}

/**
 * A bot acting on its own behalf. Bearer auth, the `/api/bot/v1` surface, no
 * cookie. Reuses the human message machinery for sending (a bot is a user).
 */
export class BotClient {
  readonly transport: HttpTransport;
  /** message send/edit/delete etc., via /api/bot/v1/messages/* */
  readonly messages: MessageApi;
  private readonly token: string;
  private readonly baseUrl: string;

  constructor(options: BotClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.token = options.token;
    this.transport = new HttpTransport({
      baseUrl: options.baseUrl,
      fetch: options.fetch,
      apiBasePath: "/api/bot/v1",
      useCookies: false,
      headers: { authorization: `Bearer ${options.token}` },
    });
    // botV1 mounts the message router under /messages.
    this.messages = new MessageApi(
      new HttpTransport({
        baseUrl: options.baseUrl,
        fetch: options.fetch,
        apiBasePath: "/api/bot/v1/messages",
        useCookies: false,
        headers: { authorization: `Bearer ${options.token}` },
      }),
    );
  }

  /** POST /api/bot/v1/whoami — the bot's own identity. */
  async whoami(): Promise<BotIdentity> {
    return this.transport.call("whoami");
  }

  /** POST /api/bot/v1/scopes/list — granted scopes for this token (paged). */
  async listScopes(options: { cursor?: string | null; limit?: number } = {}): Promise<unknown> {
    return this.transport.call("scopes/list", {
      cursor: options.cursor ?? null,
      limit: options.limit ?? 100,
    });
  }

  /**
   * Realtime as this bot: socket.io handshake auth `{token, protocolVersion}`.
   * The bot is auto-joined to its community/role rooms on connect.
   */
  realtime(options: Omit<RealtimeOptions, "botToken"> = {}): RealtimeClient {
    const socketTransport = new HttpTransport({ baseUrl: this.baseUrl, useCookies: false });
    return new RealtimeClient(socketTransport, { ...options, botToken: this.token });
  }
}
