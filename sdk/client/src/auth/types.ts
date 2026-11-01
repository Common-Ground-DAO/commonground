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
  /** the account must finish the account-security step first (getSecurityStatus) */
  securityStepRequired?: boolean;
  /** epoch ms until which the session's last interactive sign-in counts for sensitive actions, or null */
  stepUpValidUntil?: number | null;
}

/** API.User.getSecurityStatus.Response */
export interface SecurityStatus {
  required: boolean;
  needsSignInMethod: boolean;
  needsVerifiedEmail: boolean;
  needsNewPassword: boolean;
  email: string | null;
  emailVerified: boolean;
  hasPassword: boolean;
  passkeys: number;
  loginWallets: number;
  pendingEmail?: string | null;
  /** the session's sign-in is recent enough to add what is missing */
  recentSignIn?: boolean;
}

/** API.User.previewTransferLink.Response */
export interface TransferLinkPreview {
  userId: string;
  displayName: string;
  /** the unique handle (cg profile name), if the account has one */
  username: string | null;
  imageId: string | null;
  expiresAt: number;
}

export interface DeviceDescriptor {
  publicKey: DevicePublicJwk;
}

/**
 * POST /User/createUser request (cg profile path). The sign-in method is a
 * password (`useEmailAndPassword`) and/or the passkey registered during this
 * sign-up (`usePreparedPasskey`). On instances that send mail the address
 * must have been verified first (requestSignupEmailCode/verifySignupEmailCode).
 */
export interface CreateUserRequest {
  displayAccount: "cg";
  /**
   * The sign-up captcha. Not needed when the sign-up went through
   * requestSignupEmailCode, which checks the captcha itself.
   */
  recaptchaToken?: string;
  device: DeviceDescriptor;
  useEmailAndPassword?: { email: string; password: string };
  usePreparedPasskey?: boolean;
  useCgProfile: {
    type: "cg";
    displayName: string;
    imageId: string | null;
    extraData: CgProfileExtraData;
  };
}

// ---- passkeys (WebAuthn JSON as exchanged with the Passkey API) ------------

export type AuthenticatorTransport = "ble" | "cable" | "hybrid" | "internal" | "nfc" | "smart-card" | "usb";

export interface PasskeyCredentialDescriptor {
  id: string;
  type: "public-key";
  transports?: AuthenticatorTransport[];
}

/** Passkey/registrationOptions response (PublicKeyCredentialCreationOptionsJSON). */
export interface PasskeyCreationOptions {
  rp: { id?: string; name: string };
  user: { id: string; name: string; displayName: string };
  challenge: string;
  pubKeyCredParams: { type: "public-key"; alg: number }[];
  timeout?: number;
  excludeCredentials?: PasskeyCredentialDescriptor[];
  authenticatorSelection?: {
    residentKey?: string;
    requireResidentKey?: boolean;
    userVerification?: string;
    authenticatorAttachment?: string;
  };
  attestation?: string;
  extensions?: Record<string, unknown>;
}

/** Passkey/authenticationOptions response (PublicKeyCredentialRequestOptionsJSON). */
export interface PasskeyRequestOptions {
  challenge: string;
  rpId?: string;
  timeout?: number;
  allowCredentials?: PasskeyCredentialDescriptor[];
  userVerification?: string;
  extensions?: Record<string, unknown>;
}

/** RegistrationResponseJSON, as @simplewebauthn/browser produces it. */
export interface PasskeyRegistrationResponse {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment?: "platform" | "cross-platform";
  clientExtensionResults: Record<string, unknown>;
  response: {
    clientDataJSON: string;
    attestationObject: string;
    authenticatorData?: string;
    transports?: AuthenticatorTransport[];
    publicKeyAlgorithm?: number;
    publicKey?: string;
  };
}

/** AuthenticationResponseJSON, as @simplewebauthn/browser produces it. */
export interface PasskeyAuthenticationResponse {
  id: string;
  rawId: string;
  type: "public-key";
  authenticatorAttachment?: "platform" | "cross-platform";
  clientExtensionResults: Record<string, unknown>;
  response: {
    clientDataJSON: string;
    authenticatorData: string;
    signature: string;
    userHandle?: string;
  };
}

/** One credential of the session user on the instance's relying party. */
export interface PasskeyInfo {
  id: string;
  credentialID: string;
  /** WebAuthn user handle (base64url) the credential was created with */
  userHandle: string;
  name: string | null;
  credentialDeviceType: string;
  credentialBackedUp: boolean;
  transports?: AuthenticatorTransport[];
  createdAt: string;
  lastUsedAt: string | null;
}

export type PasskeyVerifyRegistrationResult =
  | { status: "attached"; passkeys: PasskeyInfo[] }
  | { status: "pending" };
