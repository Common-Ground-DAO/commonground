// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Common {
  type Address = `0x${string}`;

  type FuelAddress = `fuel${string}`;

  type AeternityAddress = `ak_${string}`;

  type PremiumRenewal = 'MONTH' | 'YEAR';

  type Link = {
    url: string;
    text: string;
  };

  type FractalData = {
    approvedAt: number;
    validUntil: number;
    address: Address;
    fractalId: string;
    proof: string;
  };

  type File = {
    objectId: string;
    data: ImageMetadata;
  };

  type ImageMetadata = {
    mimeType: `image/${string}`;
    fileName?: string;
    size: {
      width: number;
      height: number;
    };
  };

  type DeviceInfo = {
    webPushConfirmed?: boolean;
    webPushConfirmationCode?: string;
    deviceOS: string;
    deviceBrowser: string;
  };

  namespace Content {
    type MediaSize =
      'small' |
      'medium' |
      'large';

    type Text = {
      type: 'text';
      value: string;
      bold?: true;
      italic?: true;
      className?: string;
      divClassname?: string;
    };
    type Tag = {
      type: 'tag';
      value: string;
      bold?: true;
      italic?: true;
    };
    type Ticker = {
      type: 'ticker';
      value: string;
      bold?: true;
      italic?: true;
    };
    type Link = {
      type: 'link';
      value: string;
      bold?: true;
      italic?: true;
    };
    type RichTextLink = {
      type: 'richTextLink';
      value: string;
      url: string;
      bold?: true;
      italic?: true;
      className?: string;
    };
    type Newline = {
      type: 'newline'
    };
    type Mention = {
      type: 'mention';
      userId: string;
      alias?: string;
    };
    type Header = {
      type: 'header';
      value: Text[];
    };
    type ArticleType =
      "article" |
      "announcement" |
      "guide";
    type ArticleImage = {
      type: 'articleImage';
      imageId: string;
      largeImageId: string;
      caption: string;
      size: MediaSize;
    };
    type ArticleEmbed = {
      type: 'articleEmbed';
      embedId: string;
      size: MediaSize;
    };

    type DurationOption =
      "15m" |
      "1h" |
      "1d" |
      "1w" |
      "permanently";

    type WarnReason =
      "Behavior" |
      "Off-topic" |
      "Language" |
      "Spam" |
      "Breaking rules";
    type ModerationSpecial = {
      type: 'special';
      userId: string;
    } & ({
      action: 'warn';
      reason: WarnReason;
    } | {
      action: 'mute' | 'banned';
      duration: DurationOption;
    });

  };

  type CommunityPermission =
    "COMMUNITY_MANAGE_INFO" |
    "COMMUNITY_MANAGE_CHANNELS" |
    "COMMUNITY_MANAGE_ROLES" |
    "COMMUNITY_MANAGE_ARTICLES" |
    "COMMUNITY_MANAGE_USER_APPLICATIONS" |
    "COMMUNITY_MODERATE" |

    "WEBRTC_CREATE" |
    "WEBRTC_CREATE_CUSTOM" |
    "WEBRTC_MODERATE" |

    "COMMUNITY_MANAGE_EVENTS";

  type ArticlePermission =
    "ARTICLE_PREVIEW" |
    "ARTICLE_READ";

  type ChannelPermission =
    "CHANNEL_EXISTS" |
    "CHANNEL_READ" |
    "CHANNEL_WRITE" |
    "CHANNEL_MODERATE";

  type CallPermission =
    "CALL_EXISTS" |
    "CALL_JOIN" |
    "CALL_MODERATE" |
    "CHANNEL_READ" |
    "CHANNEL_WRITE" |
    "AUDIO_SEND" |
    "VIDEO_SEND" |
    "SHARE_SCREEN" |
    "PIN_FOR_EVERYONE" |
    "END_CALL_FOR_EVERYONE";

  type RoleType =
    "PREDEFINED" |
    "CUSTOM_MANUAL_ASSIGN" |
    "CUSTOM_AUTO_ASSIGN";

  type ServiceWorkerState =
    "none" |
    "pending" |
    "installing" |
    "installed" |
    "updating" |
    "updated" |
    "active" |
    "error";

  type WebSocketState =
    "disconnected" |
    "connecting" |
    "connected" |
    "version-update";

  type TabState =
    'unknown' |
    'active' |
    'active-throttled' |
    'passive' |
    'passive-throttled';

  type LoginState =
    "pending" |
    "anonymous" |
    "loggingin" |
    "loggedin" |
    "loggingout";

  type VisibilityState =
    "visible" |
    "hidden";

  type OnlineState =
    "online" |
    "offline";

  type TagFrequencyData = {
    [tag: string]: number;
  };

  type CallType =
    "broadcast" |
    "default";

  type CommunityEventPermission =
    "EVENT_PREVIEW" |
    "EVENT_ATTEND" |
    "EVENT_MODERATE";
}
