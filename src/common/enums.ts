// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

export enum PredefinedRole {
  Admin = 'Admin',
  Member = 'Member',
  Public = 'Public',
}

/**
 * If you change the existing permission enums, there are some
 * crucial things to take care of:
 * 
 * - manually check the created typeorm migration, and
 *   make sure it does NOT drop and recreate the enum,
 *   but instead use (once per every value):
 *   ALTER TYPE <enum_name> ADD VALUE 'PERMISSION_NAME'
 *   While adding values is possible, removing isn't.
 * 
 * - make sure to give the new permission to at least
 *   every admin role
 * 
 * - update common/presets.ts and make sure the permission is
 *   correctly included in presets
 */
export enum CommunityPermission {
  COMMUNITY_MANAGE_INFO = "COMMUNITY_MANAGE_INFO",
  COMMUNITY_MANAGE_CHANNELS = "COMMUNITY_MANAGE_CHANNELS",
  COMMUNITY_MANAGE_ROLES = "COMMUNITY_MANAGE_ROLES",
  COMMUNITY_MANAGE_ARTICLES = "COMMUNITY_MANAGE_ARTICLES",
  COMMUNITY_MODERATE = "COMMUNITY_MODERATE",
  COMMUNITY_MANAGE_USER_APPLICATIONS = "COMMUNITY_MANAGE_USER_APPLICATIONS",

  WEBRTC_CREATE = "WEBRTC_CREATE",
  WEBRTC_CREATE_CUSTOM = "WEBRTC_CREATE_CUSTOM",
  WEBRTC_MODERATE = "WEBRTC_MODERATE",
  COMMUNITY_MANAGE_EVENTS = "COMMUNITY_MANAGE_EVENTS",
}

export enum ArticlePermission {
  ARTICLE_PREVIEW = "ARTICLE_PREVIEW",
  ARTICLE_READ = "ARTICLE_READ",
}

export enum ChannelPermission {
  CHANNEL_EXISTS = "CHANNEL_EXISTS",
  CHANNEL_READ = "CHANNEL_READ",
  CHANNEL_WRITE = "CHANNEL_WRITE",
  CHANNEL_MODERATE = "CHANNEL_MODERATE",
}

export enum CallPermission {
  CALL_EXISTS = "CALL_EXISTS",
  CALL_JOIN = "CALL_JOIN",
  CALL_MODERATE = "CALL_MODERATE",
  CHANNEL_READ = "CHANNEL_READ",
  CHANNEL_WRITE = "CHANNEL_WRITE",
  AUDIO_SEND = "AUDIO_SEND",
  VIDEO_SEND = "VIDEO_SEND",
  SHARE_SCREEN = "SHARE_SCREEN",
  PIN_FOR_EVERYONE = "PIN_FOR_EVERYONE",
  END_CALL_FOR_EVERYONE = "END_CALL_FOR_EVERYONE",
}

export enum WalletVisibility {
  PRIVATE = "private",
  FOLLOWED = "followed",
  PUBLIC = "public"
}

export enum WalletType {
  CG_EVM = "cg_evm",
  EVM = "evm",
  CONTRACT_EVM = "contract_evm",
}

export enum RoleType {
  PREDEFINED = "PREDEFINED",
  CUSTOM_MANUAL_ASSIGN = "CUSTOM_MANUAL_ASSIGN",
  CUSTOM_AUTO_ASSIGN = "CUSTOM_AUTO_ASSIGN",
}

export enum DurationOption {
  FIFTEENMIN = "15m",
  ONEDAY = "1d",
  ONEHOUR = "1h",
  ONEWEEK = "1w",
  PERMANENTLY = "permanently"
}

export enum UserBlockState {
  CHAT_MUTED = "CHAT_MUTED",
  BANNED = "BANNED",
}

export enum FileUploadType {
  userProfileImage = "userProfileImage",
  userBannerImage = "userBannerImage",
  articleImage = "articleImage", 
  articleContentImage = "articleContentImage", 
  channelAttachmentImage = "channelAttachmentImage",
  communityHeaderImage = "communityHeaderImage",
  communityLogoSmall = "communityLogoSmall",
  communityLogoLarge = "communityLogoLarge",
  roleImage = "roleImage",
  pluginAppstoreImage = "pluginAppstoreImage",
}

export enum NotificationType {
  FOLLOWER = 'Follower',
  MENTION = 'Mention',
  REPLY = 'Reply',
  BANSTATE = 'BanState',
  DM = 'DM',
  APPROVAL = 'Approval',
}

export enum OnlineStatusEnum {
  OFFLINE = 'offline',
  ONLINE = 'online',
  AWAY = 'away',
  DND = 'dnd',
  INVISIBLE ='invisible',
}

export enum ChannelPinTypeEnum {
  AUTOPIN = "autopin",
  PERMAPIN = "permapin",
  NEVER = "never",
}

export enum ChannelNotificationTypeEnum {
  WHILE_PINNED = "while_pinned",
  ALWAYS = "always",
  NEVER = "never",
}

export enum UserProfileTypeEnum {
  TWITTER = 'twitter',
  LUKSO = 'lukso',
  CG = 'cg',
  FARCASTER = 'farcaster',
  BOT = 'bot',
}

export enum BotOwnerType {
  COMMUNITY = 'community',
  USER = 'user',
  PLATFORM = 'platform',
}

export enum BotPlatformPresenceMode {
  ALL = 'all',
  SELECTED = 'selected',
}

export enum CallType {
  DEFAULT = 'default',
  BROADCAST = 'broadcast',
}

export enum CommunityPremiumFeatureName {
  BASIC = 'BASIC',
  PRO = 'PRO',
  ENTERPRISE = 'ENTERPRISE',
}

export enum PremiumRenewal {
  MONTH = 'MONTH',
  YEAR = 'YEAR',
}

export enum UserPremiumFeatureName {
  SUPPORTER_1 = 'SUPPORTER_1',
  SUPPORTER_2 = 'SUPPORTER_2',
}

export enum CommunityEventPermission {
  EVENT_PREVIEW = "EVENT_PREVIEW",
  EVENT_ATTEND = "EVENT_ATTEND",
  EVENT_MODERATE = "EVENT_MODERATE",
}

export enum CommunityEventType {
  CALL = "call",
  BROADCAST = "broadcast",
  REMINDER = "reminder",
  EXTERNAL = "external"
}

export enum CommunityApprovalState {
  PENDING = 'PENDING',
  APPROVED = 'APPROVED',
  DENIED = 'DENIED',
  BLOCKED = 'BLOCKED',
}

export enum PluginPermission {
  USER_ACCEPTED = 'USER_ACCEPTED',
  READ_TWITTER = 'READ_TWITTER',
  READ_LUKSO = 'READ_LUKSO',
  READ_FARCASTER = 'READ_FARCASTER',
  READ_EMAIL = 'READ_EMAIL',
  READ_FRIENDS = 'READ_FRIENDS',
  ALLOW_MICROPHONE = 'ALLOW_MICROPHONE',
  ALLOW_CAMERA = 'ALLOW_CAMERA',
}

export enum ReportType {
  ARTICLE = 'ARTICLE',
  PLUGIN = 'PLUGIN',
  COMMUNITY = 'COMMUNITY',
  USER = 'USER',
  MESSAGE = 'MESSAGE',
}
