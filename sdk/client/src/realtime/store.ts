/**
 * Minimal normalized sync store.
 *
 * Hydrates from the login response (communities, chats, own user) and stays
 * current by applying cli* events. This is deliberately the *reference*
 * shape a native client's local database mirrors: communities → channels →
 * messages, plus own user, chats and coarse presence. It is not a cache
 * layer — no eviction, no persistence.
 */

import type { LoginResponse, OwnData, UserData } from "../auth/types.js";
import type { ApiMessage, Channel, Chat, CommunityDetailView } from "../social/types.js";
import type { RealtimeClient } from "./socket.js";
import type { ReceivedEvent } from "./socket.js";

export class SyncStore {
  ownUser: OwnData | null = null;
  readonly communities = new Map<string, CommunityDetailView>();
  readonly channels = new Map<string, Channel>();
  /** channelId → (messageId → message) */
  readonly messages = new Map<string, Map<string, ApiMessage>>();
  readonly chats = new Map<string, Chat>();
  /** coarse presence, from cliUserData */
  readonly users = new Map<string, Partial<UserData> & { id: string }>();
  unreadNotificationCount = 0;

  hydrateFromLogin(response: LoginResponse): void {
    this.ownUser = response.ownData;
    this.unreadNotificationCount = response.unreadNotificationCount;
    for (const community of response.communities as CommunityDetailView[]) {
      this.applyCommunity(community);
    }
    for (const chat of response.chats as Chat[]) {
      this.chats.set(chat.id, chat);
    }
  }

  /** Subscribe to a realtime client; returns the unsubscribe function. */
  attach(realtime: RealtimeClient): () => void {
    return realtime.onEvent((event) => this.apply(event));
  }

  channelMessages(channelId: string): ApiMessage[] {
    return [...(this.messages.get(channelId)?.values() ?? [])].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
  }

  seedMessages(channelId: string, batch: ApiMessage[]): void {
    const map = this.messages.get(channelId) ?? new Map<string, ApiMessage>();
    for (const message of batch) map.set(message.id, message);
    this.messages.set(channelId, map);
  }

  apply(event: ReceivedEvent): void {
    switch (event.type) {
      case "cliMessageEvent": {
        const { action, data } = event.payload as Extract<
          ReceivedEvent<"cliMessageEvent">["payload"],
          { action: string }
        >;
        if (action === "new") {
          const message = data as ApiMessage;
          this.seedMessages(message.channelId, [message]);
        } else if (action === "update") {
          const patch = data as Partial<ApiMessage> & { id: string; channelId: string };
          const existing = this.messages.get(patch.channelId)?.get(patch.id);
          if (existing) Object.assign(existing, patch);
        } else if (action === "delete") {
          const del = data as { channelId: string; deletedIds: string[] };
          const map = this.messages.get(del.channelId);
          for (const id of del.deletedIds) map?.delete(id);
        }
        break;
      }
      case "cliCommunityEvent": {
        const { action, data } = event.payload as { action: string; data: { id: string } };
        if (action === "new-or-full-update") {
          this.applyCommunity(data as unknown as CommunityDetailView);
        } else if (action === "update") {
          const existing = this.communities.get(data.id);
          if (existing) Object.assign(existing, data);
        } else if (action === "delete") {
          const community = this.communities.get(data.id);
          for (const channel of community?.channels ?? []) this.channels.delete(channel.channelId);
          this.communities.delete(data.id);
        }
        break;
      }
      case "cliChannelEvent": {
        const { action, data } = event.payload as {
          action: string;
          data: { communityId: string; channelId: string };
        };
        const community = this.communities.get(data.communityId);
        if (action === "new") {
          const channel = data as unknown as Channel;
          this.channels.set(channel.channelId, channel);
          community?.channels.push(channel);
        } else if (action === "update") {
          const existing = this.channels.get(data.channelId);
          if (existing) Object.assign(existing, data);
        } else if (action === "delete") {
          this.channels.delete(data.channelId);
          if (community) {
            community.channels = community.channels.filter((c) => c.channelId !== data.channelId);
          }
        }
        break;
      }
      case "cliChatEvent": {
        const { action, data } = event.payload as { action: string; data: { id: string } };
        if (action === "new") {
          this.chats.set(data.id, data as unknown as Chat);
        } else if (action === "update") {
          const existing = this.chats.get(data.id);
          if (existing) Object.assign(existing, data);
          else this.chats.set(data.id, data as unknown as Chat);
        } else if (action === "delete") {
          this.chats.delete(data.id);
        }
        break;
      }
      case "cliUserData": {
        const { data } = event.payload as { data: Partial<UserData> & { id: string } };
        const existing = this.users.get(data.id);
        this.users.set(data.id, existing ? { ...existing, ...data } : data);
        break;
      }
      case "cliUserOwnData": {
        const { data } = event.payload as { data: Partial<OwnData> };
        if (this.ownUser) Object.assign(this.ownUser, data);
        break;
      }
      case "cliNotificationEvent": {
        const { action } = event.payload as { action: string };
        if (action === "new") this.unreadNotificationCount += 1;
        else if (action === "allread") this.unreadNotificationCount = 0;
        break;
      }
      case "cliChannelLastRead": {
        const { channelId, lastRead } = event.payload as { channelId: string; lastRead: string };
        const channel = this.channels.get(channelId);
        if (channel) channel.lastRead = lastRead;
        break;
      }
      default:
        // Role/area/plugin/wallet/call/membership events are accepted but not
        // normalized yet — later phases extend this switch as tests demand.
        break;
    }
  }

  private applyCommunity(community: CommunityDetailView): void {
    this.communities.set(community.id, community);
    for (const channel of community.channels ?? []) {
      this.channels.set(channel.channelId, channel);
    }
  }
}
