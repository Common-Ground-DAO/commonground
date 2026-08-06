/**
 * Communities, channels, messages, DMs, follows — the social REST surface.
 *
 * Contract: srv/api/community.ts, srv/api/messages.ts, srv/api/chats.ts,
 * srv/api/user.ts (follow endpoints); request shapes from
 * srv/validators/api/{community,message,chat,user}.ts. Everything is
 * POST-RPC in the standard envelope. Message ids are CLIENT-generated
 * (crypto.randomUUID), message history is timestamp-cursor paginated.
 */

import { randomUUID } from "node:crypto";
import type { HttpTransport } from "../transport/http.js";
import type {
  ApiMessage,
  Chat,
  CommunityDetailView,
  CommunityListView,
  MessageAccess,
  MessageAttachment,
  MessageBody,
} from "./types.js";

export interface CreateCommunityOptions {
  title: string;
  shortDescription?: string;
  description?: string;
  tags?: string[];
}

export class CommunityApi {
  constructor(private readonly transport: HttpTransport) {}

  /** POST /Community/createCommunity — server auto-creates a default area,
   * channel and role set; the creator becomes a member. */
  async create(options: CreateCommunityOptions): Promise<CommunityDetailView> {
    return this.transport.call("Community/createCommunity", {
      title: options.title,
      logoSmallId: null,
      logoLargeId: null,
      headerImageId: null,
      shortDescription: options.shortDescription ?? "",
      description: options.description ?? "",
      links: [],
      tags: options.tags ?? [],
    });
  }

  /** POST /Community/joinCommunity — null response = pending approval. */
  async join(id: string): Promise<CommunityDetailView | null> {
    return this.transport.call("Community/joinCommunity", { id });
  }

  async leave(id: string): Promise<CommunityDetailView> {
    return this.transport.call("Community/leaveCommunity", { id });
  }

  async getDetailView(idOrUrl: { id: string } | { url: string }): Promise<CommunityDetailView> {
    return this.transport.call("Community/getCommunityDetailView", idOrUrl);
  }

  async getByIds(ids: string[]): Promise<CommunityListView[]> {
    return this.transport.call("Community/getCommunitiesById", { ids });
  }

  async list(options: {
    offset?: number;
    sort?: "new" | "popular";
    tags?: string[];
    limit?: number;
    search?: string;
  } = {}): Promise<CommunityListView[]> {
    return this.transport.call("Community/getCommunityList", {
      offset: options.offset ?? 0,
      sort: options.sort ?? "new",
      tags: options.tags ?? [],
      ...(options.limit !== undefined ? { limit: options.limit } : {}),
      ...(options.search !== undefined ? { search: options.search } : {}),
    });
  }
}

export interface SendMessageOptions {
  access: MessageAccess;
  body: MessageBody;
  parentMessageId?: string | null;
  attachments?: MessageAttachment[];
  /** client-generated message id; default randomUUID() */
  id?: string;
}

export class MessageApi {
  constructor(private readonly transport: HttpTransport) {}

  /** POST /Message/createMessage — the client supplies the message id. */
  async send(options: SendMessageOptions): Promise<ApiMessage> {
    return this.transport.call("Message/createMessage", {
      id: options.id ?? randomUUID(),
      access: options.access,
      body: options.body,
      parentMessageId: options.parentMessageId ?? null,
      attachments: options.attachments ?? [],
    });
  }

  /** POST /Message/editMessage → { editedAt, attachments? }. */
  async edit(
    access: MessageAccess,
    id: string,
    changes: { body?: MessageBody; attachments?: MessageAttachment[]; parentMessageId?: string | null },
  ): Promise<{ editedAt: string; attachments?: MessageAttachment[] }> {
    return this.transport.call("Message/editMessage", { access, id, ...changes });
  }

  /** POST /Message/deleteMessage (creatorId: whose message it is). */
  async delete(access: MessageAccess, messageId: string, creatorId: string): Promise<void> {
    await this.transport.call("Message/deleteMessage", { access, messageId, creatorId });
  }

  /**
   * POST /Message/loadMessages — timestamp-cursor pagination: latest page =
   * {createdBefore: nowISO}; older = {createdBefore: oldest.createdAt}.
   */
  async load(
    access: MessageAccess,
    cursor: { order?: "ASC" | "DESC"; createdBefore?: string; createdAfter?: string } = {},
  ): Promise<ApiMessage[]> {
    return this.transport.call("Message/loadMessages", { access, ...cursor });
  }

  async byIds(access: MessageAccess, messageIds: string[]): Promise<ApiMessage[]> {
    return this.transport.call("Message/messagesById", { access, messageIds });
  }

  /** POST /Message/loadUpdates — delta re-sync for a cached window. */
  async loadUpdates(
    access: MessageAccess,
    window: { createdStart: string; createdEnd: string; updatedAfter: string },
  ): Promise<{ updated: ApiMessage[]; deleted: string[] }> {
    return this.transport.call("Message/loadUpdates", { access, ...window });
  }

  async setReaction(access: MessageAccess, messageId: string, reaction: string): Promise<void> {
    await this.transport.call("Message/setReaction", { access, messageId, reaction });
  }

  async unsetReaction(access: MessageAccess, messageId: string): Promise<void> {
    await this.transport.call("Message/unsetReaction", { access, messageId });
  }

  /** POST /Message/setChannelLastRead — read cursor (fires cliChannelLastRead
   * to the user's other devices). */
  async setChannelLastRead(access: MessageAccess, lastRead: string): Promise<void> {
    await this.transport.call("Message/setChannelLastRead", { access, lastRead });
  }
}

export class ChatApi {
  constructor(private readonly transport: HttpTransport) {}

  /** POST /Chat/startChat — requires MUTUAL follow between the two users. */
  async start(otherUserId: string): Promise<Chat> {
    return this.transport.call("Chat/startChat", { otherUserId });
  }

  async close(chatId: string): Promise<void> {
    await this.transport.call("Chat/closeChat", { chatId });
  }

  async list(): Promise<Chat[]> {
    return this.transport.call("Chat/getChats");
  }
}

export class SocialGraphApi {
  constructor(private readonly transport: HttpTransport) {}

  async follow(userId: string): Promise<void> {
    await this.transport.call("User/followUser", { userId });
  }

  async unfollow(userId: string): Promise<void> {
    await this.transport.call("User/unfollowUser", { userId });
  }

  async getUserData(userIds: string[]): Promise<unknown[]> {
    return this.transport.call("User/getUserData", { userIds });
  }

  async getUserCommunityIds(userId: string): Promise<string[]> {
    return this.transport.call("User/getUserCommunityIds", { userId });
  }
}
