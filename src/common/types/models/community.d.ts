// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Models {
  namespace Community {
    type ListViewSortingType = 'new' | 'popular';
    type UserBlockState = 'CHAT_MUTED' | 'BANNED';
    type ChannelPinType = 'autopin' | 'permapin' | 'never';
    type ChannelNotifyType = 'while_pinned' | 'always' | 'never';

    type GatingRuleERC20 = {
      type: 'ERC20';
      contractId: string;
      amount: `${number}`;
    };
    
    type GatingRuleERC721 = {
      type: 'ERC721';
      contractId: string;
      amount: `${number}`;
    };
    
    type GatingRuleERC1155 = {
      type: 'ERC1155';
      contractId: string;
      tokenId: `${number}`;
      amount: `${number}`;
    };

    type GatingRuleLSP7 = {
      type: 'LSP7';
      contractId: string;
      amount: `${number}`;
    };

    type GatingRuleLSP8 = {
      type: 'LSP8';
      contractId: string;
      amount: `${number}`;
    };
    
    type GatingRule = GatingRuleERC20 | GatingRuleERC721 | GatingRuleERC1155 | GatingRuleLSP7 | GatingRuleLSP8;

    type AccessRules = {
      rule1: GatingRule;
    } | {
      rule1: GatingRule;
      rule2: GatingRule;
      logic: "and"|"or";
    };

    type AssignmentRules = {
      type: 'free';
    } | {
      type: "token";
      rules: AccessRules;
    };

    type CommunityChannelPermission = {
      roleId: string;
      roleTitle: string;
      permissions: Common.ChannelPermission[];
    };

    type Channel = {
      communityId: string;
      channelId: string;
      areaId: string | null;
      title: string;
      url: string | null;
      order: number;
      description: string | null;
      emoji: string | null;
      updatedAt: string;
      unread?: number;
      lastRead: string;
      lastMessageDate: string | null;
      pinnedMessageIds: string[] | null;
      rolePermissions: CommunityChannelPermission[];
      pinType: ChannelPinType | null;
      notifyType: ChannelNotifyType | null;
      pinnedUntil: string | null;
    };

    type Area = {
      id: string;
      communityId: string;
      title: string;
      order: number;
      updatedAt: string;
    };

    type Role = {
      id: string;
      communityId: string;
      title: string;
      type: Common.RoleType;
      assignmentRules: AssignmentRules | null;
      updatedAt: string;
      permissions: Common.CommunityPermission[];
      imageId: string | null;
      description: string | null;
      airdropConfig: RoleAirdropConfig | null;
    };

    type CommunityArticlePermission = {
      roleId: string;
      roleTitle: string;
      permissions: Common.ArticlePermission[];
    };

    type CommunityArticle = {
      communityId: string;
      articleId: string;
      url: string | null;
      published: string | null;
      updatedAt: string;
      rolePermissions: CommunityArticlePermission[];
      sentAsNewsletter: string | null;
      markAsNewsletter: boolean;
    };

    type NewsletterHistory = {
      id: string;
      title: string;
      creatorId: string;
      markAsNewsletter: boolean;
      sentAsNewsletter: string | null;
      url: string | null;
    }

    type CommunityToken = {
      contractId: string;
      order: number;
    };

    type PremiumName =
      'BASIC' |
      'PRO' |
      'ENTERPRISE';

    type Premium = {
      featureName: PremiumName;
      activeUntil: string;
      autoRenew: Common.PremiumRenewal | null;
    };

    type PremiumConfig = {
      MONTHLY_PRICE: number;
      ROLE_LIMIT: number;
      TOKEN_LIMIT: number;
      CALL_HD: number;
      CALL_STANDARD: number;
      CALL_AUDIO: number;
      BROADCASTERS_SLOTS: number;
      BROADCAST_HD: number;
      BROADCAST_STANDARD: number;
      BROADCAST_AUDIO: number;
    };

    type ListView = {
      id: string;
      url: string;
      title: string;
      logoSmallId: string | null;
      logoLargeId: string | null;
      headerImageId: string | null;
      shortDescription: string;
      memberCount: number;
      tags: string[];
      official: boolean;
      allowUserBots: boolean;
      createdAt: string;
      updatedAt: string;
      premium: Premium | null;
      calls?: never;
      channels?: never;
      areas?: never;
      roles?: never;
    };

    type DetailView = ListView & {
      description: string;
      logoLargeId: string | null;
      links: Common.Link[];
      creatorId: string;
      myRoleIds: string[];
      tokens: CommunityToken[];
      pointBalance: number;
      blockState: {
        state: UserBlockState | null;
        until: string | null;
      };
      notificationState?: {
        notifyMentions: boolean;
        notifyReplies: boolean;
        notifyPosts: boolean;
        notifyEvents: boolean;
        notifyCalls: boolean;
      }
      onboardingOptions?: OnboardingOptions;
      myApplicationStatus?: 'PENDING' | 'APPROVED' | 'DENIED' | 'BLOCKED';
      myNewsletterEnabled?: boolean;
      membersPendingApproval?: number;
      enablePersonalNewsletter: boolean;
      plugins: Models.Plugin.Plugin[];
    };

    type DetailViewFromApi = Omit<DetailView, "calls" | "channels" | "areas" | "roles"> & {
      calls: Models.Calls.Call[];
      channels: Channel[];
      areas: Area[];
      roles: Role[];
    };

    type ChannelMemberList = {
      count: number;
      adminCount: number;
      moderatorCount: number;
      writerCount: number;
      readerCount: number;
      offlineCount: number;
      admin: ([string, string[]])[];
      moderator: ([string, string[]])[];
      writer: ([string, string[]])[];
      reader: ([string, string[]])[];
      offline: ([string, string[]])[];
    };

    type MemberList = {
      totalCount: number;
      resultCount: number;
      roles: ([string, number])[];
      online: ([string, string[]])[];
      offline: ([string, string[]])[];
    };

    type EventType = "call" | "broadcast" | "reminder" | "external";

    type EventPermission = {
      roleId: string;
      roleTitle: string;
      permissions: Common.CommunityEventPermission[];
    };

    type Event = {
      id: string;
      type: EventType;
      communityId: string;
      eventCreator: string;
      url: string | null;
      title: string;
      description: Models.BaseArticle.ContentV2;
      externalUrl: string | null;
      location: string | null;
      scheduleDate: string;
      duration: number;
      createdAt: string;
      deletedAt: string | null;
      updatedAt: string;
      callId: string | null;
      imageId: string | null;
      rolePermissions: EventPermission[];
      participantIds: string[];
      participantCount: number;
      isSelfAttending: boolean;
    };

    type OnboardingOptionsQuestion = {
      question: string;
      type: 'text' | 'multi-choice' | 'multi-select';
      options: string[];
    }

    type OnboardingOptions = {
      manuallyApprove?: {
        enabled?: boolean;
        email?: string;
      };
      customWelcome?: {
        enabled?: boolean;
        welcomeString?: string;
        rules?: string[];
      };
      questionnaire?: {
        enabled?: boolean;
        questions?: OnboardingOptionsQuestion[];
      };
      requirements?: {
        enabled?: boolean;
        minAccountTimeEnabled?: boolean;
        minAccountTimeDays?: number;
        universalProfileEnabled?: boolean;
        xProfileEnabled?: boolean;
      };
      passwordProtected?: {
        enabled?: boolean;
      }
    }

    type QuestionnaireAnswer = Pick<Models.Community.OnboardingOptionsQuestion, 'type' | 'question'> & {
      answer: string[];
    }

    type UserBanState = {
      userId: string;
      blockState: UserBlockState;
      blockStateUntil: string | null;
      blockStateUpdatedAt: string | null;
    }

    type PendingApproval = {
      communityId: string;
      userId: string;
      questionnaireAnswers: QuestionnaireAnswer[] | null;
      approvalState: 'PENDING' | 'APPROVED' | 'DENIED' | 'BLOCKED';
    }

    type AirdropInfo = {
      type: 'cg_blue';
    }

    type RoleAirdropConfig = {
      airdropInfo: AirdropInfo;
      functionParameters: {
        a: string;
        b: string;
        c: string;
        k: string;
      };
      style: {
        strokeColor: string;
        fillColor: string;
        progressFillColor: string;
        progressIndicatorColor: string;
        gridLineColor: string;
      };
      endDate: string;
      milestones: {
        users: number;
        text: string;
        bonusPercent?: number;
      }[];
      maximumUsers: number;
      airdropExecuted?: boolean;
    };

    type UserAirdropData = {
      amount: string;
      claimedAt: string;
      totalUsers: number;
      position: number;
      airdropInfo: AirdropInfo;
    }
  }
}
