// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare global {
    namespace API {
        namespace Community {
            namespace getCommunityList {
                type Request = {
                    offset: number;
                    sort: Models.Community.ListViewSortingType;
                    tags: string[];
                    limit?: number;
                    search?: string;
                }
                type Response = Models.Community.ListView[];
            }

            namespace getCommunitiesById {
                type Request = {
                    ids: string[];
                }
                type Response = Models.Community.ListView[];
            }

            namespace getCommunityDetailView {
                type Request = {
                    id: string;
                } | {
                    url: string;
                };
                type Response = Models.Community.DetailViewFromApi;
            }

            namespace joinCommunity {
                type Request = {
                    id: string;
                    questionnaireAnswers?: Models.Community.QuestionnaireAnswer[];
                    password?: string;
                }
                type Response = Models.Community.DetailViewFromApi | null;
            }

            namespace leaveCommunity {
                type Request = {
                    id: string;
                }
                type Response = Models.Community.DetailViewFromApi;
            }

            namespace setUserBlockState {
                type Request = {
                    userId: string;
                    communityId: string;
                    until: string | null;
                    blockState: Models.Community.UserBlockState | null;
                }
                type Response = void;
            }

            namespace getMemberList {
                type Request = {
                    communityId: string;
                    offset: number;
                    limit: number;
                    search?: string;
                    roleId?: string;
                }
                type Response = Models.Community.MemberList;
            }


            namespace getChannelMemberList {
                type Request = {
                    communityId: string;
                    channelId: string;
                    offset: number;
                    limit: number;
                    search?: string;
                    startsWithSearch?: boolean;
                }
                type Response = Models.Community.ChannelMemberList;
            }

            namespace getMemberNewsletterCount {
                type Request = {
                    communityId: string;
                    roleIds: string[];
                }
                type Response = {
                    count: number;
                };
            }

            namespace getUserCommunityRoleIds {
                type Request = {
                    userId: string;
                    communityId: string;
                }
                type Response = string[];
            }

            /* COMMUNITY */

            namespace createCommunity {
                type Request = Omit<Models.Community.DetailView,
                    "id" |
                    "createdAt" |
                    "updatedAt" |
                    "myRoleIds" |
                    "url" |
                    "memberCount" |
                    "blockState" |
                    "creatorId" |
                    "official" |
                    "tokens" |
                    "premium" |
                    "allowUserBots" |
                    "enablePersonalNewsletter" |
                    "pointBalance" |
                    "plugins">;
                type Response = Models.Community.DetailViewFromApi;
            }

            namespace updateCommunity {
                type Request =
                    Partial<Omit<Models.Community.DetailView,
                        "id" |
                        "createdAt" |
                        "updatedAt" |
                        "myRoleIds" |
                        "url" |
                        "memberCount" |
                        "blockState" |
                        "allowUserBots" |
                        "official">>
                    & Pick<Models.Community.DetailView, "id">;
                type Response = void;
            }

            /* AREA */

            namespace createArea {
                type Request = Omit<Models.Community.Area, "id" | "updatedAt">;
                type Response = void;
            }

            namespace updateArea {
                type Request =
                    Partial<Omit<Models.Community.Area, "updatedAt">>
                    & Pick<Models.Community.Area, "id" | "communityId">;
                type Response = void;
            }

            namespace deleteArea {
                type Request = Pick<Models.Community.Area, "id" | "communityId">;
                type Response = void;
            }

            /* CHANNEL */

            namespace createChannel {
                type Request = Omit<Models.Community.Channel, "channelId" | "updatedAt" | "unread" | "lastRead" | "lastMessageDate" | "pinType" | "notifyType" | "pinnedUntil" | "pinnedMessageIds">;
                type Response = void;
            }

            namespace updateChannel {
                type Request =
                    Partial<Omit<Models.Community.Channel, "unread" | "updatedAt" | "unread" | "lastRead" | "pinType" | "notifyType" | "pinnedUntil">>
                    & Pick<Models.Community.Channel, "channelId" | "communityId">;
                type Response = void;
            }

            namespace deleteChannel {
                type Request = Pick<Models.Community.Channel, "channelId" | "communityId">;
                type Response = void;
            }

            /* ROLE */

            namespace createRole {
                type Request = Omit<Models.Community.Role, "id" | "updatedAt" | "airdropConfig">;
                type Response = Pick<Models.Community.Role, "id">;
            }

            namespace updateRole {
                type Request =
                    Partial<Omit<Models.Community.Role, "updatedAt">>
                    & Pick<Models.Community.Role, "id" | "communityId">;
                type Response = void;
            }

            namespace deleteRole {
                type Request = Pick<Models.Community.Role, "id" | "communityId">;
                type Response = void;
            }

            namespace checkCommunityRoleClaimability {
                type Request = {
                    communityId: string;
                };
                type Response = {
                    roleId: string;
                    claimable: boolean;
                }[];
            }

            namespace claimRole {
                type Request = {
                    communityId: string;
                    roleId: string;
                };
                type Response = boolean;
            }

            namespace addUserToRoles {
                type Request = {
                    userId: Models.User.Data["id"];
                    communityId: Models.Community.Role["communityId"];
                    roleIds: Models.Community.Role["id"][];
                };
                type Response = void;
            }

            namespace removeUserFromRoles {
                type Request = {
                    userId: Models.User.Data["id"];
                    communityId: Models.Community.Role["communityId"];
                    roleIds: Models.Community.Role["id"][];
                };
                type Response = void;
            }

            /* TOKENS */

            namespace addCommunityToken {
                type Request = {
                    communityId: string;
                    contractId: string;
                    order: number;
                };
                type Response = void;
            }

            namespace removeCommunityToken {
                type Request = {
                    communityId: string;
                    contractId: string;
                };
                type Response = void;
            }

            /* PREMIUM */

            namespace givePointsToCommunity {
                type Request = {
                    communityId: string;
                    amount: number;
                };
                type Response = void;
            }

            namespace buyCommunityPremiumFeature {
                type Request = {
                    communityId: string;
                    featureName: Models.Community.PremiumName;
                    duration: 'month' | 'year' | 'upgrade';
                } | {
                    communityId: string;
                    featureName: "URL_CHANGE";
                    url: string;
                };
                type Response = void;
            }

            namespace setPremiumFeatureAutoRenew {
                type Request = {
                    communityId: string;
                    featureName: Models.Community.PremiumName;
                    autoRenew: Common.PremiumRenewal | null;
                };
                type Response = void;
            }


            /* ONBOARDING */
            namespace getCommunityPassword {
                type Request = {
                    communityId: string;
                };
                type Response = {
                    password: string | null;
                };
            }

            namespace verifyCommunityPassword {
                type Request = {
                    communityId: string;
                    password: string;
                };
                type Response = {
                    valid: boolean;
                };
            }

            namespace setOnboardingOptions {
                type Request = {
                    communityId: string;
                    onboardingOptions: Models.Community.OnboardingOptions;
                    password: string | null;
                };
                type Response = void;
            }

            namespace getPendingJoinApprovals {
                type Request = {
                    communityId: string;
                };
                type Response = Models.Community.PendingApproval[];
            }

            namespace setAllPendingJoinApprovals {
                type Request = {
                    communityId: string;
                    approvalState: 'PENDING' | 'APPROVED' | 'DENIED' | 'BLOCKED';
                };
                type Response = void;
            }

            namespace setPendingJoinApproval {
                type Request = {
                    communityId: string;
                    userId: string;
                    approvalState: 'PENDING' | 'APPROVED' | 'DENIED' | 'BLOCKED';
                    message?: string;
                };
                type Response = void;
            }

            namespace getBannedUsers {
                type Request = {
                    communityId: string;
                    limit?: number;
                    before?: string;
                };
                type Response = Models.Community.UserBanState[];
            }

            /* ARTICLES */

            namespace getArticleList {
                type Request = {
                    communityId?: string;
                    tags?: string[];
                    anyTags?: string[];
                } & API.BaseArticle.getArticleListRequest;
                type Response = {
                    communityArticle: Models.Community.CommunityArticle;
                    article: Models.BaseArticle.Preview;
                }[];
            }

            namespace getArticleDetailView {
                type Request = {
                    communityId: string;
                } & ({
                    articleId: string;
                } | {
                    url: string;
                });
                type Response = {
                    communityArticle: Models.Community.CommunityArticle;
                    article: Models.BaseArticle.DetailView;
                };
            }

            namespace createArticle {
                type Request = {
                    communityArticle:
                    Pick<Models.Community.CommunityArticle, "communityId">
                    & Omit<Models.Community.CommunityArticle, "updatedAt" | "articleId" | "sentAsNewsletter" | "markAsNewsletter">
                    & { sentAsNewsletter?: undefined; markAsNewsletter?: undefined; };
                    article:
                    Omit<Models.BaseArticle.DetailView, "articleId" | "creatorId" | "channelId" | "commentCount" | "latestCommentTimestamp">;
                };
                type Response = {
                    communityArticle: Models.Community.CommunityArticle;
                    article: Models.BaseArticle.DetailView;
                };
            }

            namespace updateArticle {
                type Request = {
                    communityArticle:
                    Pick<Models.Community.CommunityArticle, "communityId" | "articleId">
                    & Partial<Omit<Models.Community.CommunityArticle, "updatedAt" | "sentAsNewsletter" | "markAsNewsletter">>
                    & { sentAsNewsletter?: undefined; markAsNewsletter?: undefined };
                    article?:
                    Pick<Models.BaseArticle.DetailView, "articleId">
                    & Partial<Omit<Models.BaseArticle.DetailView, "creatorId" | "channelId" | "commentCount" | "latestCommentTimestamp">>;
                };
                type Response = void;
            }

            namespace deleteArticle {
                type Request = Pick<Models.Community.CommunityArticle, "communityId" | "articleId">;
                type Response = void;
            }

            namespace setChannelPinState {
                type Request = {
                    communityId: string;
                    channelId: string;
                    pinnedUntil?: string | null;
                    pinType?: Models.Community.ChannelPinType;
                    notifyType?: Models.Community.ChannelNotifyType;
                };
                type Response = void;
            }

            namespace sendArticleAsEmail {
                type Request = {
                    communityId: string;
                    articleId: string;
                };
                type Response = void;
            }

            /* EVENTS */
            namespace getEventList {
                type Request = {
                    communityId: string;
                };
                type Response = Models.Community.Event[];
            }

            namespace getMyEvents {
                type Request = {
                    scheduledBefore: string | null;
                    beforeId: string | null;
                };
                type Response = Models.Community.Event[];
            }

            namespace getUpcomingEvents {
                type Request = {
                    scheduledAfter: string | null;
                    afterId: string | null;
                    anyTags: string[] | null;
                    tags: string[] | null;
                    type: 'verified' | 'following';
                };
                type Response = Models.Community.Event[];
            }

            namespace getEvent {
                type Request = {
                    id: string;
                } | {
                    url: string;
                };
                type Response = Models.Community.Event;
            }

            namespace createCommunityEvent {
                type Request = Pick<Models.Community.Event,
                    "type" |
                    "communityId" |
                    "title" |
                    "duration" |
                    "url" |
                    "imageId" |
                    "scheduleDate" |
                    "rolePermissions" |
                    "externalUrl" |
                    "location"
                > & {
                    description: string | null;
                    callData?: {
                        slots: number;
                        stageSlots: number;
                        hd: boolean;
                        audioOnly: boolean;
                    }
                };
                type Response = Models.Community.Event;
            }

            namespace updateCommunityEvent {
                type Request = Pick<Models.Community.Event,
                    "id" |
                    "type" |
                    "title" |
                    "duration" |
                    "imageId" |
                    "scheduleDate" |
                    "rolePermissions" |
                    "externalUrl" |
                    "location"
                > & {
                    description: string | null;
                    callData?: {
                        slots: number;
                        stageSlots: number;
                        hd: boolean;
                        audioOnly: boolean;
                    }
                };
                type Response = Models.Community.Event;
            }

            namespace deleteCommunityEvent {
                type Request = {
                    eventId: string;
                    communityId: string;
                };
                type Response = void;
            }

            namespace getEventParticipants {
                type Request = {
                    eventId: string;
                };
                type Response = string[];
            }

            namespace addEventParticipant {
                type Request = {
                    eventId: string;
                };
                type Response = void;
            }

            namespace addEventParticipantByCallId {
                type Request = {
                    callId: string;
                };
                type Response = void;
            }

            namespace removeEventParticipant {
                type Request = {
                    eventId: string;
                };
                type Response = void;
            }

            /* CALLS */
            namespace getCall {
                type Request = {
                    id: string;
                    communityId: string;
                };
                type Response = {
                    id: string;
                    channelId: string;
                    startedAt: string;
                    updatedAt: string;
                    callType: Common.CallType;
                    communityId: string;
                    callServerId: string;
                    callCreator: string;
                    slots: number;
                    stageSlots: number;
                    highQuality: boolean;
                    audioOnly: boolean;
                };
            }

            namespace getCallParticipantEvents {
                type Request = {
                    callId: string;
                };
                type Response = {
                    events: {
                        eventType: 'join' | 'leave';
                        userId: string;
                        timestamp: string;
                    }[];
                };
            }

            namespace startCall {
                type Request = {
                    communityId: string;
                    title: string;
                    description: string | null;
                    rolePermissions?: {
                        roleId: string;
                        permissions: Common.CallPermission[];
                    }[];
                    callType: Common.CallType;
                    callCreator: string;
                    slots: number;
                    stageSlots: number;
                    hd: boolean;
                    audioOnly: boolean;
                };
                type Response = Models.Calls.Call;
            }

            namespace updateCall {
                type Request = {
                    id: string;
                    communityId: string;
                    title: string;
                    description: string | null;
                    rolePermissions?: {
                        roleId: string;
                        permissions: Common.CallPermission[];
                    }[];
                    callType: Common.CallType;
                    slots: number;
                    stageSlots: number;
                    hd: boolean;
                    audioOnly: boolean;
                };
                type Response = void;
            }

            namespace startScheduledCall {
                type Request = {
                    communityEventId: string;
                };
                type Response = Models.Calls.Call;
            }

            namespace getCurrentCalls {
                type Request = {
                    offset: number;
                };
                type Response = Models.Calls.Call[];
            }

            /* GENERAL */

            namespace getTagFrequencyData {
                type Request = undefined;
                type Response = Common.TagFrequencyData;
            }

            namespace getTransactionData {
                type Request = {
                    communityId: string;
                };
                type Response = Models.Premium.TransactionFromApi[];
            }

            namespace getCommunityCount {
                type Request = {
                    channel: string;
                }
                type Response = {
                    count: number;
                };
            }

            namespace updateNotificationState {
                type Request = {
                    data: {
                        communityId: string;
                        notifyMentions: boolean;
                        notifyReplies: boolean;
                        notifyPosts: boolean;
                        notifyEvents: boolean;
                        notifyCalls: boolean;
                    }[];
                }
                type Response = void;
            }

            namespace subscribeToCommunityNewsletter {
                type Request = {
                    communityIds: string[];
                }
                type Response = void;
            }

            namespace unsubscribeFromCommunityNewsletter {
                type Request = {
                    communityIds: string[];
                }
                type Response = void;
            }

            namespace getLatestArticleSentAsNewsletterDate {
                type Request = {
                    communityId: string;
                }
                type Response = string | null;
            }

            namespace getNewsletterHistory {
                type Request = {
                    communityId: string;
                    timeframe: '30days' | '90days' | '1year';
                };
                type Response = {
                    entries: Models.Community.NewsletterHistory[];
                };
            }

            namespace getAirdropClaimHistory {
                type Request = {
                    communityId: string;
                    roleId: string;
                };
                type Response = {
                    claimData: {
                        userId: string;
                        claimedAt: string;
                    }[];
                };
            }

            namespace getAirdropCommunities {
                type Request = {
                    status: 'ongoing' | 'finished';
                };
                type Response = {
                    community: Models.Community.ListView;
                    role: Models.Community.Role;
                    userAirdropData: Models.Community.UserAirdropData | null;
                    airdropUserCount: number;
                }[];
            }

            namespace Wizard {
                namespace getWizardData {
                    type Request = {
                        wizardId: string;
                    };
                    type Response = {
                        wizardData: Models.Wizard.Wizard;
                        userData?: Models.Wizard.WizardUserData;
                    };
                }

                namespace consumeReferralCode {
                    type Request = {
                        code: string;
                        wizardId: string;
                    };
                    type Response = void;
                }

                namespace wizardVerifyCode {
                    type Request = {
                        wizardId: string;
                        code: string;
                    };
                    type Response = boolean;
                }

                namespace wizardVerifyWallet {
                    type Request = {
                        wizardId: string;
                        data: any;
                    };
                    type Response = Models.Wizard.WizardStep;
                }

                namespace wizardFinished {
                    type Request = {
                        wizardId: string;
                        tryResult: "success" | "failure";
                    };
                    type Response = void;
                }

                namespace claimInvestmentTransaction {
                    type Request = {
                        wizardId: string;
                        txHash: string;
                    };
                    type Response = {
                        success: boolean;
                        message?: string;
                        newInvestmentAmount?: string;
                    };
                }

                namespace getMyReferralCodes {
                    type Request = {
                        wizardId: string;
                    };
                    type Response = {
                        referralCodes: {
                            code: string;
                            used: boolean;
                        }[];
                    };
                }

                namespace setWizardStepData {
                    type Request = {
                        wizardId: string;
                        stepId: number;
                        value: Models.Wizard.WizardStepData & { serverTimestamp?: never };
                    };
                    type Response = Models.Wizard.WizardUserData;
                }

                namespace getInvestmentTargetBeneficiaryBalance {
                    type Request = {
                        target: Models.Wizard.ValidInvestmentTarget;
                    };
                    type Response = {
                        balance: string;
                    };
                }

                namespace getInvestmentTargetPersonalContribution {
                    type Request = {
                        target: Models.Wizard.ValidInvestmentTarget;
                    };
                    type Response = {
                        contribution: string;
                    };
                }
            }
        }
    }
}

export { };
