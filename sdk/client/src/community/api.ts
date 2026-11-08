/**
 * Community management — roles, areas, channels, moderation, events, tokens,
 * premium. The non-basic half of the Community domain (basic create/join/list
 * live in CommunityApi). Contract: srv/api/community.ts + srv/api/bots.ts
 * (setBotRoles/setAllowUserBots live under /Bot); validators
 * srv/validators/api/community.ts. All strict-validated; send real
 * numbers/booleans. Permission failures surface as NOT_ALLOWED.
 */

import type { HttpTransport } from "../transport/http.js";
import type {
  Area,
  AssignmentRules,
  CommunityChannelPermission,
  CommunityEvent,
  CommunityEventPermission,
  CommunityEventType,
  CommunityPermission,
  NotificationStateEntry,
  PendingApproval,
  Role,
  RoleType,
  UserBanState,
  UserBlockState,
} from "./types.js";

export interface CreateRoleOptions {
  communityId: string;
  title: string;
  type: RoleType;
  assignmentRules: AssignmentRules | null;
  permissions: CommunityPermission[];
  imageId?: string | null;
  description?: string | null;
}

export interface CreateChannelOptions {
  communityId: string;
  areaId: string;
  title: string;
  order: number;
  description?: string | null;
  emoji: string;
  url?: string | null;
  rolePermissions: CommunityChannelPermission[];
}

export interface CreateEventOptions {
  type: CommunityEventType;
  communityId: string;
  title: string;
  description?: string | null;
  duration: number;
  url?: string | null;
  imageId?: string | null;
  scheduleDate: string;
  rolePermissions: { roleId: string; roleTitle: string; permissions: CommunityEventPermission[] }[];
  externalUrl?: string | null;
  location?: string | null;
  callData?: { slots: number; stageSlots: number; audioOnly: boolean; hd: boolean };
}

export class CommunityAdminApi {
  constructor(private readonly transport: HttpTransport) {}

  // ---- Roles ----

  /** POST /Community/createRole (COMMUNITY_MANAGE_ROLES). Title can't be
   * "Admin"; type must be a CUSTOM_* (predefined roles aren't creatable). */
  async createRole(options: CreateRoleOptions): Promise<{ id: string }> {
    return this.transport.call("Community/createRole", {
      communityId: options.communityId,
      title: options.title,
      type: options.type,
      assignmentRules: options.assignmentRules,
      permissions: options.permissions,
      imageId: options.imageId ?? null,
      description: options.description ?? null,
    });
  }

  async updateRole(patch: Partial<Omit<Role, "updatedAt">> & { id: string; communityId: string }): Promise<void> {
    await this.transport.call("Community/updateRole", patch);
  }

  async deleteRole(id: string, communityId: string): Promise<void> {
    await this.transport.call("Community/deleteRole", { id, communityId });
  }

  async addUserToRoles(userId: string, communityId: string, roleIds: string[]): Promise<void> {
    await this.transport.call("Community/addUserToRoles", { userId, communityId, roleIds });
  }

  async removeUserFromRoles(userId: string, communityId: string, roleIds: string[]): Promise<void> {
    await this.transport.call("Community/removeUserFromRoles", { userId, communityId, roleIds });
  }

  /** POST /Community/claimRole — claim a CUSTOM_AUTO_ASSIGN role (free or a
   * token-gated one the onchain pass already marked eligible). Returns
   * whether the claim succeeded. */
  async claimRole(communityId: string, roleId: string): Promise<boolean> {
    return this.transport.call("Community/claimRole", { communityId, roleId });
  }

  /** POST /Community/checkCommunityRoleClaimability — onchain-evaluated;
   * fails fast with SERVICE_UNAVAILABLE on a blockchain-disabled instance. */
  async checkRoleClaimability(communityId: string): Promise<{ roleId: string; claimable: boolean }[]> {
    return this.transport.call("Community/checkCommunityRoleClaimability", { communityId });
  }

  // ---- Areas (channel groups) ----

  async createArea(communityId: string, title: string, order: number): Promise<void> {
    await this.transport.call("Community/createArea", { communityId, title, order });
  }

  async updateArea(patch: Partial<Omit<Area, "updatedAt">> & { id: string; communityId: string }): Promise<void> {
    await this.transport.call("Community/updateArea", patch);
  }

  async deleteArea(id: string, communityId: string): Promise<void> {
    await this.transport.call("Community/deleteArea", { id, communityId });
  }

  // ---- Channels ----

  async createChannel(options: CreateChannelOptions): Promise<void> {
    await this.transport.call("Community/createChannel", {
      communityId: options.communityId,
      areaId: options.areaId,
      title: options.title,
      order: options.order,
      description: options.description ?? "",
      emoji: options.emoji,
      url: options.url ?? null,
      rolePermissions: options.rolePermissions,
    });
  }

  async updateChannel(
    patch: { channelId: string; communityId: string } & Partial<{
      areaId: string;
      title: string;
      order: number;
      description: string | null;
      emoji: string;
      url: string | null;
      rolePermissions: CommunityChannelPermission[];
      pinnedMessageIds: string[];
    }>,
  ): Promise<void> {
    await this.transport.call("Community/updateChannel", patch);
  }

  async deleteChannel(channelId: string, communityId: string): Promise<void> {
    await this.transport.call("Community/deleteChannel", { channelId, communityId });
  }

  /** Per-user pin/notify preference for a channel. */
  async setChannelPinState(
    communityId: string,
    channelId: string,
    options: {
      pinType?: "autopin" | "permapin" | "never";
      notifyType?: "always" | "while_pinned" | "never";
      pinnedUntil?: string | null;
    },
  ): Promise<void> {
    await this.transport.call("Community/setChannelPinState", { communityId, channelId, ...options });
  }

  // ---- Moderation / membership admin ----

  /** POST /Community/setUserBlockState (COMMUNITY_MODERATE). blockState null
   * clears the block. */
  async setUserBlockState(
    userId: string,
    communityId: string,
    blockState: UserBlockState | null,
    until: string | null = null,
  ): Promise<void> {
    await this.transport.call("Community/setUserBlockState", { userId, communityId, blockState, until });
  }

  async getBannedUsers(
    communityId: string,
    options: { limit?: number; before?: string } = {},
  ): Promise<UserBanState[]> {
    return this.transport.call("Community/getBannedUsers", { communityId, ...options });
  }

  async getPendingJoinApprovals(communityId: string): Promise<PendingApproval[]> {
    return this.transport.call("Community/getPendingJoinApprovals", { communityId });
  }

  async setPendingJoinApproval(
    communityId: string,
    userId: string,
    approvalState: "PENDING" | "APPROVED" | "DENIED" | "BLOCKED",
    message?: string,
  ): Promise<void> {
    await this.transport.call("Community/setPendingJoinApproval", {
      communityId,
      userId,
      approvalState,
      ...(message !== undefined ? { message } : {}),
    });
  }

  async getCommunityPassword(communityId: string): Promise<{ password: string | null }> {
    return this.transport.call("Community/getCommunityPassword", { communityId });
  }

  async verifyCommunityPassword(communityId: string, password: string): Promise<{ valid: boolean }> {
    return this.transport.call("Community/verifyCommunityPassword", { communityId, password });
  }

  // ---- Notification / newsletter ----

  async updateNotificationState(data: NotificationStateEntry[]): Promise<void> {
    await this.transport.call("Community/updateNotificationState", { data });
  }

  async subscribeToNewsletter(communityIds: string[]): Promise<void> {
    await this.transport.call("Community/subscribeToCommunityNewsletter", { communityIds });
  }

  async unsubscribeFromNewsletter(communityIds: string[]): Promise<void> {
    await this.transport.call("Community/unsubscribeFromCommunityNewsletter", { communityIds });
  }

  // ---- Events / scheduled calls ----

  /** POST /Community/createCommunityEvent (COMMUNITY_MANAGE_EVENTS). For
   * call/broadcast types the server provisions a scheduled call. */
  async createEvent(options: CreateEventOptions): Promise<CommunityEvent> {
    return this.transport.call("Community/createCommunityEvent", {
      type: options.type,
      communityId: options.communityId,
      title: options.title,
      description: options.description ?? null,
      duration: options.duration,
      url: options.url ?? null,
      imageId: options.imageId ?? null,
      scheduleDate: options.scheduleDate,
      rolePermissions: options.rolePermissions,
      externalUrl: options.externalUrl ?? null,
      location: options.location ?? null,
      ...(options.callData ? { callData: options.callData } : {}),
    });
  }

  async deleteEvent(eventId: string, communityId: string): Promise<void> {
    await this.transport.call("Community/deleteCommunityEvent", { eventId, communityId });
  }

  async getEvents(communityId: string): Promise<CommunityEvent[]> {
    return this.transport.call("Community/getEventList", { communityId });
  }

  /**
   * POST /Community/getMyEvents — the caller's own upcoming events across all
   * their communities, newest-first. Cursor pagination: pass both fields from
   * the last returned item to fetch the next page; `beforeId` is the tiebreaker
   * for events that share a `scheduleDate`. The default (both null) is the first
   * page.
   */
  async getMyEvents(
    cursor: { scheduledBefore: string | null; beforeId: string | null } = {
      scheduledBefore: null,
      beforeId: null,
    },
  ): Promise<CommunityEvent[]> {
    return this.transport.call("Community/getMyEvents", {
      scheduledBefore: cursor.scheduledBefore,
      beforeId: cursor.beforeId,
    });
  }

  /**
   * POST /Community/getUpcomingEvents — a discovery feed of upcoming events,
   * oldest-first, from `verified` communities or the ones the caller is a member
   * of (`following`). Ascending cursor pagination: pass `{ scheduledAfter,
   * afterId }` from the last returned item; `afterId` is the same-`scheduleDate`
   * tiebreaker.
   */
  async getUpcomingEvents(
    options: {
      type: "verified" | "following";
      scheduledAfter?: string | null;
      afterId?: string | null;
      tags?: string[] | null;
      anyTags?: string[] | null;
    },
  ): Promise<CommunityEvent[]> {
    return this.transport.call("Community/getUpcomingEvents", {
      type: options.type,
      scheduledAfter: options.scheduledAfter ?? null,
      afterId: options.afterId ?? null,
      tags: options.tags ?? null,
      anyTags: options.anyTags ?? null,
    });
  }

  async getEventParticipants(eventId: string): Promise<string[]> {
    return this.transport.call("Community/getEventParticipants", { eventId });
  }

  async addEventParticipant(eventId: string): Promise<void> {
    await this.transport.call("Community/addEventParticipant", { eventId });
  }

  async removeEventParticipant(eventId: string): Promise<void> {
    await this.transport.call("Community/removeEventParticipant", { eventId });
  }

  // ---- Tokens ----

  async addCommunityToken(communityId: string, contractId: string, order: number): Promise<void> {
    await this.transport.call("Community/addCommunityToken", { communityId, contractId, order });
  }

  async removeCommunityToken(communityId: string, contractId: string): Promise<void> {
    await this.transport.call("Community/removeCommunityToken", { communityId, contractId });
  }
}
