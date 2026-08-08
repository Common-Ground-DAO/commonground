/**
 * Server→client realtime event catalog.
 *
 * Contract: srv/repositories/event.ts emits `io.to(rooms).emit(type, rest)` —
 * the socket.io event NAME is the `type` string and the payload object omits
 * `type`. The SDK router reassembles `{type, ...payload}`. Payload types
 * mirror src/common/types/events/*.d.ts; `buildId` is positional and handled
 * separately (srv/wsapi.ts emits it on every connection).
 *
 * The cliConnection* names that exist in the web app are client-synthesized,
 * never on the wire — deliberately absent here.
 */

import type { UserData, OwnData } from "../auth/types.js";
import type { ApiMessage, MessageAccess } from "../social/types.js";

interface Action<TAction extends string, TData> {
  action: TAction;
  data: TData;
}

/** Events.Message.Event — message create/edit/delete in a channel. */
export type CliMessageEvent =
  | Action<"new", ApiMessage & { communityId?: string; creatorIsBot: boolean }>
  | Action<
      "update",
      Pick<ApiMessage, "id" | "channelId" | "updatedAt"> & { communityId?: string } & Partial<
          Pick<ApiMessage, "body" | "attachments" | "parentMessageId" | "reactions">
        >
    >
  | Action<"delete", { communityId?: string; channelId: string; deletedIds: string[] }>;

export type CliCommunityEvent =
  | Action<"new-or-full-update", Record<string, unknown> & { id: string }>
  | Action<"update", Record<string, unknown> & { id: string; updatedAt: string }>
  | Action<"delete", { id: string }>;

export type CliChannelEvent =
  | Action<"new", Record<string, unknown> & { communityId: string; channelId: string }>
  | Action<"update", Record<string, unknown> & { communityId: string; channelId: string }>
  | Action<"delete", { communityId: string; channelId: string }>;

export type CliAreaEvent =
  | Action<"new", Record<string, unknown> & { id: string; communityId: string }>
  | Action<"update", Record<string, unknown> & { id: string; communityId: string }>
  | Action<"delete", { id: string; communityId: string }>;

export type CliRoleEvent =
  | Action<"new", Record<string, unknown> & { id: string; communityId: string }>
  | Action<"update", Record<string, unknown> & { id: string; communityId: string }>
  | Action<"delete", { id: string; communityId: string }>;

export type CliPluginEvent =
  | Action<"new" | "update" | "delete", Record<string, unknown>>
  | Action<"dataUpdate" | "dataDelete", Record<string, unknown>>;

export type CliMembershipEvent =
  | Action<"join" | "roles_added" | "roles_removed", { userId: string; communityId: string; roleIds: string[] }>
  | Action<"leave", { userId: string; communityId: string }>;

/** Flat (no action/data wrapper): the receiving user's own role set changed. */
export interface CliMyRolesEvent {
  communityId: string;
  rolesGained: string[];
  rolesLost: string[];
}

export type CliChatEvent =
  | Action<"new", Record<string, unknown> & { id: string; channelId: string }>
  | Action<"update", Record<string, unknown> & { id: string; channelId: string }>
  | Action<"delete", { id: string }>;

/** Flat: read-cursor sync across the user's own devices. */
export interface CliChannelLastRead {
  channelId: string;
  lastRead: string;
}

export type CliNotificationEvent =
  | Action<"new", Record<string, unknown> & { id: string }>
  | Action<"update", Record<string, unknown> & { id: string }>
  | Action<"allread", { updatedAt: string }>
  | Action<"delete", { id: string | string[] }>;

export interface CliUserData {
  data: Partial<UserData> & { id: string };
}

export interface CliUserOwnData {
  data: Partial<OwnData>;
}

export type CliWalletEvent =
  | Action<"new", Record<string, unknown> & { id: string }>
  | Action<"update", Record<string, unknown> & { id: string }>
  | Action<"delete", { id: string }>;

export type CliCallEvent =
  | Action<"new", Record<string, unknown> & { id: string; communityId: string }>
  | Action<"update", Record<string, unknown> & { id: string; communityId: string }>
  | Action<"delete", { id: string; communityId: string }>;

/**
 * Flat: ephemeral typing presence for a message context. The server keeps no
 * authoritative state — `isTyping:true` is (re)sent while composing and expires
 * on the receiver (apply a local timeout, ~6–7s); an explicit `isTyping:false`
 * arrives on stop/disconnect. `access` echoes the context so the indicator can
 * be routed to the right channel / chat / article.
 */
export interface CliTypingEvent {
  access: MessageAccess;
  userId: string;
  isTyping: boolean;
}

export type CliBotScopesEvent = Record<string, unknown>;

export interface CliCgIdSignResponse {
  frontendRequestId: string;
  data: { type: "registration" | "authentication"; success: boolean; error?: string };
}

/** Wire-event name → payload. The catalog the conformance suite proves. */
export interface ClientEventMap {
  cliMessageEvent: CliMessageEvent;
  cliCommunityEvent: CliCommunityEvent;
  cliChannelEvent: CliChannelEvent;
  cliAreaEvent: CliAreaEvent;
  cliRoleEvent: CliRoleEvent;
  cliPluginEvent: CliPluginEvent;
  cliMembershipEvent: CliMembershipEvent;
  cliMyRolesEvent: CliMyRolesEvent;
  cliChatEvent: CliChatEvent;
  cliChannelLastRead: CliChannelLastRead;
  cliNotificationEvent: CliNotificationEvent;
  cliUserData: CliUserData;
  cliUserOwnData: CliUserOwnData;
  cliWalletEvent: CliWalletEvent;
  cliCallEvent: CliCallEvent;
  cliTypingEvent: CliTypingEvent;
  cliBotScopesEvent: CliBotScopesEvent;
  cliCgIdSignResponse: CliCgIdSignResponse;
}

export type ClientEventName = keyof ClientEventMap;

export const CLIENT_EVENT_NAMES = [
  "cliMessageEvent",
  "cliCommunityEvent",
  "cliChannelEvent",
  "cliAreaEvent",
  "cliRoleEvent",
  "cliPluginEvent",
  "cliMembershipEvent",
  "cliMyRolesEvent",
  "cliChatEvent",
  "cliChannelLastRead",
  "cliNotificationEvent",
  "cliUserData",
  "cliUserOwnData",
  "cliWalletEvent",
  "cliCallEvent",
  "cliTypingEvent",
  "cliBotScopesEvent",
  "cliCgIdSignResponse",
] as const satisfies readonly ClientEventName[];
