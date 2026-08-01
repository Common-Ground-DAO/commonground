// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

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
            } | {
                type: "fuel";
                address: Common.FuelAddress;
                secret: string;
            } | {
                type: "aeternity";
                address: Common.AeternityAddress;
                secret: string;
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
                    unreadNotificationCount: number;
                };
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
                    recaptchaToken: string;
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
                    type: Exclude<Models.Wallet.Type, "contract_evm">;
                    signature: string;
                    data: SignableWalletData;
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
                type Response = void;
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
        }
    }
}

export { };
