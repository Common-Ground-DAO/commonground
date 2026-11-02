// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { type AuthenticationResponseJSON } from "@simplewebauthn/browser";

declare global {
    namespace API {
        namespace User {
            namespace getSignableSecret {
                type Request = undefined;
                type Response = string;
            }

            namespace verifyCaptcha {
                type Request = {
                    token: string;
                };
                type Response = boolean;
            }

            type SignableWalletData = {
                address: Common.Address;
                secret: string;
                siweMessage: string;
                type: "evm";
            }

            namespace clearLoginSession {
                type Request = undefined;
                type Response = void;
            }

            namespace login {
                type Request = {
                    type: "wallet";
                    device: {
                        publicKey: any;
                    };
                } | {
                    type: "device";
                    secret: string;
                    deviceId: string;
                    base64Signature: string;
                } | {
                    type: "password";
                    aliasOrEmail: string;
                    password: string;
                    device: {
                        publicKey: any;
                    };
                } | {
                    type: 'passkey';
                    authenticationResponse: AuthenticationResponseJSON;
                    device: {
                        publicKey: any;
                    };
                } | {
                    /** passkey-success: legacy CG ID (gateway) mode only */
                    type: 'twitter' | 'passkey-success' | 'farcaster';
                    device: {
                        publicKey: any;
                    };
                } | {
                    type: 'lukso';
                    device: {
                        publicKey: any;
                    };
                } | {
                    type: "verificationCode";
                    email: string;
                    code: string;
                    device: {
                        publicKey: any;
                    };
                };
                type Response = {
                    ownData: Models.User.OwnData;
                    deviceId: string;
                    webPushSubscription: Models.Notification.PushSubscription | null;
                    communities: Models.Community.DetailViewFromApi[];
                    chats: Models.Chat.ChatFromApi[];
                    /**
                     * servers before chat-sync may send a numeric string
                     * (uncast int8 count); clients coerce it with `Number()`
                     */
                    unreadNotificationCount: number;
                    /**
                     * the account must finish the account-security step before
                     * anything else works (User/getSecurityStatus); absent on
                     * older servers
                     */
                    securityStepRequired?: boolean;
                    /**
                     * epoch ms until which the session's last interactive
                     * authentication counts for sensitive actions (null: it
                     * does not); also after a silent device re-login
                     */
                    stepUpValidUntil?: number | null;
                };
            }

            namespace ensureSession {
                type Request = Record<string, never>;
                type Response = undefined;
            }

            /**
             * Signs the account out on every other device: their sessions
             * end and their device keys are deleted; this session and device
             * stay (step-up; docs/auth-identity §2)
             */
            namespace signOutOtherDevices {
                type Request = Record<string, never>;
                type Response = {
                    /** how many other devices were signed out */
                    devices: number;
                    /** their sessions end within a minute (not right away) */
                    delayed: boolean;
                };
            }

            namespace reauthenticate {
                type Request = {
                    type: 'passkey';
                    authenticationResponse: AuthenticationResponseJSON;
                } | {
                    type: 'password';
                    password: string;
                } | {
                    /** after a fresh User/prepareWalletAction of a login-enabled wallet */
                    type: 'wallet';
                };
                type Response = {
                    /** epoch ms until which sensitive actions are allowed */
                    validUntil: number;
                };
            }

            namespace requestSignupEmailCode {
                type Request = {
                    email: string;
                    /** the sign-up captcha; not needed for a resend to the same address */
                    recaptchaToken?: string;
                };
                type Response = void;
            }

            namespace verifySignupEmailCode {
                type Request = {
                    email: string;
                    code: string;
                };
                type Response = void;
            }

            namespace checkLoginStatus {
                type Request = undefined;
                type Response = {
                    userId: string | null;
                }
            }

            namespace logout {
                type Request = undefined;
                type Response = void;
            }

            namespace createUser {
                type Request = {
                    useTwitterCredentials?: boolean;
                    useLuksoCredentials?: boolean;
                    usePreparedWallet?: boolean;
                    usePreparedPasskey?: boolean;
                    usePreparedFarcaster?: boolean;
                    useEmailAndPassword?: {
                        email: string;
                        password: string;
                    };
                    useCgProfile?: Models.User.ProfileItemWithDetails & { type: 'cg', extraData: Models.User.UserAccountExtraData_CG };
                    displayAccount: Exclude<Models.User.ProfileItemType, 'bot'>;
                    /** not needed when the sign-up went through the email code (captcha solved there) */
                    recaptchaToken?: string;
                    device: {
                        publicKey: any;
                    };
                };
                type Response = login.Response;
            }

            namespace updateOwnData {
                type Request = Partial<Pick<Models.User.OwnData,
                    "communityOrder" |
                    "finishedTutorials" |
                    "newsletter" |
                    "weeklyNewsletter" |
                    "email" |
                    "displayAccount" |
                    "dmNotifications" |
                    "tags"
                >>;
                type Response = void;
            }

            namespace setOwnExtraDataField {
                type Request = {
                    key: "installedPWA";
                    value: boolean;
                };
                type Response = void;
            }

            namespace addUserAccount {
                type Request = {
                    type: Extract<Models.User.ProfileItemType, "cg">;
                    displayName: string;
                    description?: string;
                    links?: Common.Link[];
                    homepage?: string;
                } | {
                    type: Exclude<Models.User.ProfileItemType, "cg" | "bot">;
                };
                type Response = void;
            }

            namespace updateUserAccount {
                type Request = {
                    type: Extract<Models.User.ProfileItemType, "cg">;
                    displayName?: string;
                    description?: string;
                    links?: Common.Link[];
                    homepage?: string;
                    imageId?: undefined; // image is not allowed here, is set via files.uploadImage
                };
                type Response = void;
            }

            namespace removeUserAccount {
                type Request = {
                    type: Exclude<Models.User.ProfileItemType, "bot">;
                }
                type Response = void;
            }

            namespace prepareWalletAction {
                type Request = {
                    type: Extract<Models.Wallet.Type, "evm" | "cg_evm">;
                    signature: string;
                    data: Extract<SignableWalletData, { type: "evm" }>;
                };
                type Response = {
                    walletValid: boolean;
                    walletExists: boolean;
                    readyForLogin: boolean;
                    readyForCreation: boolean;
                    isOwnWallet: boolean;
                    isDeleted: boolean;
                    isOlderThan7Days: boolean;
                };
            }

            namespace addPreparedWallet {
                type Request = {
                    loginEnabled: boolean;
                    visibility: Models.Wallet.Visibility;
                };
                type Response = void;
            }

            namespace updateWallet {
                type Request = {
                    id: string;
                    loginEnabled?: boolean;
                    visibility?: Models.Wallet.Visibility;
                }
                type Response = void;
            }

            namespace deleteWallet {
                type Request = {
                    id: string;
                }
                type Response = void;
            }

            namespace getWallets {
                type Request = {
                    userId?: string;
                }
                type Response = Models.Wallet.Wallet[];
            }

            namespace getUserData {
                type Request = {
                    userIds: string[];
                }
                type Response = Models.User.Data[];
            }

            // Viewer-aware "people to discover". Authenticated only. Returns
            // lightweight ids + a suggestion reason; clients hydrate profiles
            // through getUserData. Ranking is a deterministic heuristic:
            // shared-community members > follow-of-follows > globally-popular
            // fallback, ordered by a composite score with a stable userId
            // tiebreaker so keyset pagination cannot duplicate/omit.
            namespace getSuggestedUsers {
                type SuggestionReasonType =
                    'sharedCommunity' |
                    'followedByFollowing' |
                    'popular';
                type SuggestionReason = {
                    type: SuggestionReasonType;
                    // Present for 'sharedCommunity' — always a community the
                    // viewer belongs to, so it reveals nothing the viewer's own
                    // membership doesn't already expose.
                    communityId?: string;
                    // shared-community count (sharedCommunity) or
                    // follow-of-follows count (followedByFollowing).
                    mutualCount?: number;
                };
                type SuggestedUser = {
                    userId: string;
                    reason: SuggestionReason;
                };
                type Request = {
                    limit: number; // 1..50, see validator
                    cursor?: string; // opaque keyset cursor from a prior nextCursor
                };
                type Response = {
                    users: SuggestedUser[];
                    nextCursor: string | null;
                };
            }

            namespace getUserProfileDetails {
                type Request = {
                    userId: string;
                }
                type Response = {
                    detailledProfiles: Models.User.ProfileItemWithDetails[];
                    wallets: Models.Wallet.ProfileWalletData[];
                }
            }

            namespace setOwnStatus {
                type Request = {
                    status: Models.User.OnlineStatus;
                }
                type Response = void;
            }

            namespace isCgProfileNameAvailable {
                type Request = {
                    displayName: string;
                }
                type Response = boolean;
            }

            namespace isEmailAvailable {
                type Request = {
                    email: string;
                }
                type Response = boolean;
            }

            namespace setPassword {
                type Request = {
                    password: string;
                }
                type Response = {
                    /** other devices signed out with a replaced password (0 for a first one) */
                    signedOutDevices: number;
                    /** their sessions end within a minute (not right away) */
                    signOutDelayed: boolean;
                };
            }

            namespace subscribeNewsletter {
                type Request = {
                    email: string;
                }
                type Response = void;
            }

            namespace unsubscribeNewsletter {
                type Request = {
                    email: string;
                }
                type Response = void;
            }

            namespace followUser {
                type Request = {
                    userId: string;
                }
                type Response = void;
            }

            namespace unfollowUser {
                type Request = {
                    userId: string;
                }
                type Response = void;
            }

            /* ARTICLES */

            namespace getArticleList {
                type Request = {
                    userId?: string;
                    followingOnly?: true;
                } & API.BaseArticle.getArticleListRequest;
                type Response = {
                    userArticle: Models.User.UserArticle;
                    article: Models.BaseArticle.Preview;
                }[];
            }

            namespace getArticleDetailView {
                type Request = {
                    userId: string;
                } & ({
                    articleId: string;
                } | {
                    url: string;
                });
                type Response = {
                    userArticle: Models.User.UserArticle;
                    article: Models.BaseArticle.DetailView;
                };
            }

            namespace createArticle {
                type Request = {
                    userArticle:
                    Omit<Models.User.UserArticle, "userId" | "updatedAt" | "articleId">;
                    article: Omit<Models.BaseArticle.DetailView, "creatorId" | "articleId" | "channelId" | "commentCount" | "latestCommentTimestamp">;
                };
                type Response = {
                    userArticle: Models.User.UserArticle;
                    article: Models.BaseArticle.DetailView;
                };
            }

            namespace updateArticle {
                type Request = {
                    userArticle:
                    Pick<Models.User.UserArticle, "articleId">
                    & Partial<Omit<Models.User.UserArticle, "updatedAt" | "userId">>;
                    article?: Partial<Omit<Models.BaseArticle.DetailView, "creatorId" | "channelId" | "commentCount" | "latestCommentTimestamp">>;
                };
                type Response = {
                    userArticle: Pick<Models.User.UserArticle, "updatedAt">
                };
            }

            namespace deleteArticle {
                type Request = Pick<Models.User.UserArticle, "articleId">;
                type Response = void;
            }

            namespace getFollowers {
                type Request = {
                    userId: string;
                    limit: number;
                    offset: number;
                };
                type Response = {
                    userId: string;
                    createdAt: string;
                }[];
            }

            namespace getFollowing {
                type Request = {
                    userId: string;
                    limit: number;
                    offset: number;
                };
                type Response = {
                    userId: string;
                    createdAt: string;
                }[];
            }

            namespace getFriends {
                type Request = {
                    userId: string;
                    limit: number;
                    offset: number;
                };
                type Response = {
                    userId: string;
                    createdAt: string;
                }[];
            }

            /* PREMIUM */
            namespace buyUserPremiumFeature {
                type Request = {
                    featureName: Models.User.PremiumFeatureName;
                    duration: 'month' | 'year' | 'upgrade';
                };
                type Response = void;
            }

            namespace setPremiumFeatureAutoRenew {
                type Request = {
                    featureName: Models.User.PremiumFeatureName;
                    autoRenew: Common.PremiumRenewal | null;
                }
                type Response = void;
            }

            /* COMMUNITIES */
            namespace getUserCommunityIds {
                type Request = {
                    userId: string;
                };
                type Response = string[];
            }

            namespace getTransactionData {
                type Request = undefined;
                type Response = Models.Premium.TransactionFromApi[];
            }

            namespace requestEmailVerification {
                type Request = {
                    email: string;
                };
                type Response = void;
            }

            namespace verifyEmail {
                type Request = {
                    email: string;
                    token: string;
                };
                type Response = void;
            }

            namespace sendOneTimePasswordForLogin {
                type Request = {
                    email: string;
                };
                type Response = void;
            }

            /** what the account-security step still needs (docs/auth-identity §11) */
            namespace getSecurityStatus {
                type Request = Record<string, never>;
                type Response = {
                    /** anything below is missing: only the step's endpoints work */
                    required: boolean;
                    /** no passkey here, no password and no sign-in wallet */
                    needsSignInMethod: boolean;
                    /** no verified email (only on an instance that sends mail) */
                    needsVerifiedEmail: boolean;
                    /** the password signed in but is shorter than the policy */
                    needsNewPassword: boolean;
                    email: string | null;
                    emailVerified: boolean;
                    hasPassword: boolean;
                    /** passkeys of this instance */
                    passkeys: number;
                    /** login-enabled wallets */
                    loginWallets: number;
                    /** an address a confirmation code was sent to and not yet confirmed */
                    pendingEmail?: string | null;
                    /**
                     * the session signed in (or came with a transfer link) recently
                     * enough to add what is missing; false: sign in again
                     */
                    recentSignIn?: boolean;
                };
            }

            /** a one-time link that signs the session's user in on the transfer target */
            namespace createTransferLink {
                type Request = {
                    /** a same-site path on the target to continue to */
                    nextPath?: string;
                };
                type Response = {
                    /** `<target>/transfer#<token>` */
                    url: string;
                    /** epoch ms */
                    expiresAt: number;
                };
            }

            namespace previewTransferLink {
                type Request = {
                    token: string;
                };
                type Response = {
                    userId: string;
                    displayName: string;
                    /** the unique handle (cg profile name), if the account has one */
                    username: string | null;
                    /** profile image of the displayed account */
                    imageId: string | null;
                    /** epoch ms */
                    expiresAt: number;
                };
            }

            namespace redeemTransferLink {
                type Request = {
                    token: string;
                    device: {
                        publicKey: any;
                    };
                };
                type Response = login.Response & {
                    /** where to continue (a same-site path), or null */
                    nextPath: string | null;
                };
            }
        }
    }
}

export { };
