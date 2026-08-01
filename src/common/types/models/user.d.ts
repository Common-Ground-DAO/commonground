// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Models {
  namespace User {
    type OnlineStatus = 'online' | 'away' | 'dnd' | 'invisible' | 'offline';
    type TutorialName = 'onboarding';
    type ProfileItemType = 'twitter' | 'lukso' | 'cg' | 'farcaster' | 'bot';
    type BotOwnerType = 'community' | 'user' | 'platform';
    type BotPlatformPresenceMode = 'all' | 'selected';
    type BotOwnerSummary =
      | { type: 'user'; id: string; username: string }
      | { type: 'community'; id: string; title: string }
      | { type: 'platform' };

    type PremiumFeatureName =
      'SUPPORTER_1' |
      'SUPPORTER_2';

    type PremiumFeature = {
      featureName: PremiumFeatureName;
      activeUntil: string;
      autoRenew?: Common.PremiumRenewal | null;
    };

    type ProfileItem = {
      type: ProfileItemType;
      displayName: string;
      imageId: string | null;
    };

    type ProfileItemWithDetails = ProfileItem & {
      extraData: UserAccountExtraData | null;
    };

    type UserAccountExtraData_CG = {
      type: "cg";
      description: string;
      homepage: string;
      links: Common.Link[];
    }

    type UserAccountExtraData_Lukso = {
      type: "lukso";
      upAddress: string;
    };

    type UserAccountExtraData_Farcaster = {
      type: "farcaster";
      fid: number;
      username: string;
      bio?: string;
      url?: string;
    }

    type UserAccountExtraData_Bot = {
      type: "bot";
      description: string | null;
    }

    type UserAccountData_Lukso = {
      type: "lukso";
      id: string;
    };

    type UserAccountData_Twitter = {
      type: "twitter";
      id: string;
      refreshToken: string;
      accessToken: string;
      followingCount: number;
      followersCount: number;
    };

    type UserAccountData_Farcaster = {
      type: "farcaster";
      id: string;
      address: Common.Address;
    };

    type UserAccountData = UserAccountData_Twitter | UserAccountData_Lukso | UserAccountData_Farcaster;
    type UserAccountExtraData = UserAccountExtraData_CG | UserAccountExtraData_Lukso | UserAccountExtraData_Farcaster | UserAccountExtraData_Bot;

    type Data = {
      id: string;
      isBot: boolean;
      botOwner?: BotOwnerSummary | null;
      onlineStatus: OnlineStatus;
      isFollowed: boolean;
      isFollower: boolean;
      createdAt: string;
      updatedAt: string;
      bannerImageId: string | null;
      displayAccount: ProfileItemType;
      accounts: ProfileItem[];
      premiumFeatures: PremiumFeature[];
      followingCount: number;
      followerCount: number;
      tags: string[] | null;
    };

    type UserProfileDetails = {
      detailledProfiles: ProfileItemWithDetails[];
      wallets: Models.Wallet.ProfileWalletData[];
    };

    type ExtraData = {
      // these fields can be set through setOwnExtraDataField
      installedPWA?: boolean;

      // these fields cannot be set through setOwnExtraDataField
      usesMobileDevice?: boolean;
      usesDesktopDevice?: boolean;
      kycLivenessSuccess?: boolean;
      kycFullSuccess?: boolean;
      kycCgTokensaleSuccess?: boolean;
      kycRejectReason?: string;
      desktopPushWorking?: boolean;
      mobilePushWorking?: boolean;
    };

    type OwnData = Omit<Data, "isFollowed" | "isFollower" | "accounts"> & {
      passkeys: Models.Passkey.Data[];
      communityOrder: string[];
      finishedTutorials: TutorialName[];
      newsletter: boolean;
      weeklyNewsletter: boolean;
      dmNotifications: boolean;
      email: string | null;
      password?: never;
      features: Models.User.UserFeatures;
      pointBalance: number;
      trustScore: string;
      emailVerified: boolean;
      accounts: ProfileItemWithDetails[];
      extraData: ExtraData;
    };

    type UserArticle = {
      userId: string;
      articleId: string;
      url: string | null;
      published: string | null;
      updatedAt: string;
    };

    type DataStore = {
      [id: string]: ListView | DetailView;
    };

    type UserFeatures = {
      twittedInvite?: boolean;
    };

    type PlatformBan = {
      reason: any;
    };
  }
}
