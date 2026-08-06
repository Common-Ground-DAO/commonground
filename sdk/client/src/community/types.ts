/**
 * Community management types mirrored from the server contract.
 * Sources: src/common/types/models/community.d.ts, api/community.d.ts;
 * validators srv/validators/api/community.ts; enums src/common/enums.ts.
 */

export type CommunityPermission =
  | "COMMUNITY_MANAGE_INFO"
  | "COMMUNITY_MANAGE_CHANNELS"
  | "COMMUNITY_MANAGE_ROLES"
  | "COMMUNITY_MANAGE_ARTICLES"
  | "COMMUNITY_MODERATE"
  | "COMMUNITY_MANAGE_USER_APPLICATIONS"
  | "WEBRTC_CREATE"
  | "WEBRTC_CREATE_CUSTOM"
  | "WEBRTC_MODERATE"
  | "COMMUNITY_MANAGE_EVENTS";

export type ChannelPermission = "CHANNEL_EXISTS" | "CHANNEL_READ" | "CHANNEL_WRITE" | "CHANNEL_MODERATE";
export type ArticlePermission = "ARTICLE_PREVIEW" | "ARTICLE_READ";
export type CommunityEventPermission = "EVENT_PREVIEW" | "EVENT_ATTEND" | "EVENT_MODERATE";
export type CallPermission =
  | "CALL_EXISTS" | "CALL_JOIN" | "CALL_MODERATE" | "CHANNEL_READ" | "CHANNEL_WRITE"
  | "AUDIO_SEND" | "VIDEO_SEND" | "SHARE_SCREEN" | "PIN_FOR_EVERYONE" | "END_CALL_FOR_EVERYONE";

export type RoleType = "PREDEFINED" | "CUSTOM_MANUAL_ASSIGN" | "CUSTOM_AUTO_ASSIGN";
export type UserBlockState = "CHAT_MUTED" | "BANNED";
export type CommunityApprovalState = "PENDING" | "APPROVED" | "DENIED" | "BLOCKED";
export type CommunityEventType = "call" | "broadcast" | "reminder" | "external";

/** Token-gating rule referencing a registered contract (from ContractApi). */
export type GatingRule =
  | { type: "ERC20"; contractId: string; amount: `${number}` }
  | { type: "ERC721"; contractId: string; amount: `${number}` }
  | { type: "ERC1155"; contractId: string; tokenId: `${number}`; amount: `${number}` }
  | { type: "LSP7"; contractId: string; amount: `${number}` }
  | { type: "LSP8"; contractId: string; amount: `${number}` };

export type AccessRules =
  | { rule1: GatingRule }
  | { rule1: GatingRule; rule2: GatingRule; logic: "and" | "or" };

export type AssignmentRules = { type: "free" } | { type: "token"; rules: AccessRules };

export interface Role {
  id: string;
  communityId: string;
  title: string;
  type: RoleType;
  assignmentRules: AssignmentRules | null;
  updatedAt: string;
  permissions: CommunityPermission[];
  imageId: string | null;
  description: string | null;
}

export interface Area {
  id: string;
  communityId: string;
  title: string;
  order: number;
  updatedAt: string;
}

export interface CommunityChannelPermission {
  roleId: string;
  roleTitle: string;
  permissions: ChannelPermission[];
}

export interface UserBanState {
  userId: string;
  blockState: UserBlockState;
  blockStateUntil: string | null;
  blockStateUpdatedAt: string | null;
}

export interface PendingApproval {
  communityId: string;
  userId: string;
  questionnaireAnswers: unknown[] | null;
  approvalState: CommunityApprovalState;
}

export interface CommunityEvent {
  id: string;
  type: CommunityEventType;
  communityId: string;
  eventCreator: string;
  url: string | null;
  title: string;
  description: unknown;
  externalUrl: string | null;
  location: string | null;
  scheduleDate: string;
  duration: number;
  createdAt: string;
  updatedAt: string;
  deletedAt: string | null;
  callId: string | null;
  imageId: string | null;
  rolePermissions: { roleId: string; roleTitle: string; permissions: CommunityEventPermission[] }[];
  participantIds: string[];
  participantCount: number;
  isSelfAttending: boolean;
}

/** Per-user community notification preferences. */
export interface NotificationStateEntry {
  communityId: string;
  notifyMentions: boolean;
  notifyReplies: boolean;
  notifyPosts: boolean;
  notifyEvents: boolean;
  notifyCalls: boolean;
}
