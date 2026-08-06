/**
 * Auth/user types mirrored from the server contract.
 * Sources: src/common/types/models/user.d.ts (OwnData/Data),
 * src/common/types/api/user.d.ts (login/createUser), validated request
 * shapes in srv/validators/api/user.ts. Mirrors carry the fields the SDK
 * and conformance suite rely on; servers may send more.
 */

import type { DevicePublicJwk } from "../identity/deviceKey.js";

export type OnlineStatus = "online" | "away" | "dnd" | "invisible" | "offline";
export type ProfileItemType = "twitter" | "lukso" | "cg" | "farcaster" | "bot";

export interface CgProfileExtraData {
  type: "cg";
  description: string;
  homepage: string;
  links: { url: string; text: string }[];
}

export interface ProfileItem {
  type: ProfileItemType;
  displayName?: string;
  imageId?: string | null;
  extraData?: unknown;
  [extra: string]: unknown;
}

/** Public profile card (Models.User.Data). No index signature: it would make
 * TS's Omit erase the named members (string index absorbs every key). */
export interface UserData {
  id: string;
  isBot: boolean;
  onlineStatus: OnlineStatus;
  isFollowed?: boolean;
  isFollower?: boolean;
  createdAt: string;
  updatedAt: string;
  bannerImageId: string | null;
  displayAccount: ProfileItemType;
  accounts: ProfileItem[];
  followingCount: number;
  followerCount: number;
  tags: string[] | null;
}

/** The logged-in user's own record (Models.User.OwnData). */
export interface OwnData extends Omit<UserData, "isFollowed" | "isFollower"> {
  communityOrder: string[];
  finishedTutorials: string[];
  newsletter: boolean;
  weeklyNewsletter: boolean;
  dmNotifications: boolean;
  email: string | null;
  emailVerified: boolean;
  trustScore: string;
  pointBalance: number;
  passkeys: unknown[];
  extraData: Record<string, unknown>;
}

/** API.User.login.Response — also the createUser response. */
export interface LoginResponse {
  ownData: OwnData;
  deviceId: string;
  webPushSubscription: unknown | null;
  communities: unknown[];
  chats: unknown[];
  unreadNotificationCount: number;
}

export interface DeviceDescriptor {
  publicKey: DevicePublicJwk;
}

/** POST /User/createUser request (email+password + cg profile path). */
export interface CreateUserRequest {
  displayAccount: "cg";
  recaptchaToken: string;
  device: DeviceDescriptor;
  useEmailAndPassword: { email: string; password: string };
  useCgProfile: {
    type: "cg";
    displayName: string;
    imageId: string | null;
    extraData: CgProfileExtraData;
  };
}
