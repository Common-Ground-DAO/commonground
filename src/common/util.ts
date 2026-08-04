// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import config from "./config";
import { createTranslator } from 'short-uuid';
import { UserPremiumFeatureName } from "./enums";
import errors from "./errors";
import dayjs from "dayjs";
import slugify from "slugify";

// mirrored in srv/validators/common.ts, change in both places
export const itemUrlRegex = /^[a-z0-9-]{3,50}$/i;
export const addressRegex = /^0x[a-f0-9]{40}$/i;

const t = createTranslator();

type GetUrlOptions = {
  type: 'home';
} | {
  type: 'chats';
} | {
  type: 'chat';
  chat: Pick<Models.Chat.Chat, "id">;
} | {
  type: 'notifications';
} | {
  type: 'notification';
  notification: Pick<Models.Notification.Notification, "id">;
} | {
  type: 'feed';
} | {
  type: 'browse-communities';
} | {
  type:
  'community-lobby' |
  'community-member-applications' |
  'community-members' |
  'community-roles' |
  'community-events' |
  'community-token' |
  'community-settings' |
  'community-settings-info' |
  'community-settings-areas-and-channels' |
  'community-settings-members' |
  'community-settings-bans' |
  'community-settings-roles' |
  'community-settings-upgrades' |
  'community-settings-token' |
  'community-settings-onboarding' |
  'community-settings-verify' |
  'community-settings-plugins' |
  'community-settings-bots' |
  'community-create-article';
  community: Pick<Models.Community.ListView, "url"> & Partial<Models.Community.ListView>;
} | {
  type: 'community-channel';
  community: Pick<Models.Community.ListView, "url"> & Partial<Models.Community.ListView>;
  channel: Pick<Models.Community.Channel, "channelId" | "url"> & Partial<Models.Community.Channel>;
} | {
  type: 'community-article' | 'community-article-edit';
  community: Pick<Models.Community.ListView, "url"> & Partial<Models.Community.ListView>;
  article: Pick<Models.BaseArticle.Preview, "articleId" | "title">;
} | {
  type: 'community-call';
  community: Pick<Models.Community.ListView, "url">;
  call: Pick<Models.Calls.Call, "id"> & Partial<Models.Calls.Call>;
} | {
  type: 'community-plugin';
  community: Pick<Models.Community.ListView, "url">;
  plugin: Pick<Models.Plugin.Plugin, "id">;
} | {
  type: 'event';
  community: Pick<Models.Community.ListView, "url">;
  event: Pick<Models.Community.Event, "id" | "url">;
} | {
  type: 'user';
  user: Pick<Models.User.Data, "id"> & Partial<Models.User.Data>;
} | {
  type: 'create-user-post';
} | {
  type: 'user-article';
  user: Pick<Models.User.Data, "id"> & Partial<Models.User.Data>;
  article: Pick<Models.BaseArticle.Preview, "articleId" | "title">;
} | {
  type: 'user-article-edit';
  user: Pick<Models.User.Data, "id"> & Partial<Models.User.Data>;
  article: Pick<Models.BaseArticle.Preview, "articleId" | "title">;
} | {
  type: 'profile-settings';
} | {
  type: 'profile-settings-account-and-wallets';
} | {
  type: 'profile-settings-calls';
} | {
  type: 'profile-settings-account';
} | {
  type: 'token';
} | {
  type: 'appstore';
} | {
  type: 'search';
} | {
  type: 'plugin-details';
  plugin: Pick<Models.Plugin.PluginListView, "pluginId">;
};

const Helper: Record<GetUrlOptions['type'], (options: any) => string> = {
  'home': (options: GetUrlOptions & { type: 'home' }) => {
    return '/';
  },
  'chats': (options: GetUrlOptions & { type: 'chats' }) => {
    return `/${config.URL_CHATS}/`;
  },
  'chat': (options: GetUrlOptions & { type: 'chat' }) => {
    return `/${config.URL_CHATS}/${t.fromUUID(options.chat.id)}/`;
  },
  'notifications': (options: GetUrlOptions & { type: 'notifications' }) => {
    return `/${config.URL_NOTIFICATIONS}/`;
  },
  'notification': (options: GetUrlOptions & { type: 'notification' }) => {
    return `/${config.URL_NOTIFICATIONS}/${t.fromUUID(options.notification.id)}/`;
  },
  'feed': (options: GetUrlOptions & { type: 'feed' }) => {
    return `/${config.URL_FEED}/`;
  },
  'browse-communities': (options: GetUrlOptions & { type: 'browse-communities' }) => {
    return `/${config.URL_BROWSE_COMMUNITIES}/`;
  },
  'community-lobby': (options: GetUrlOptions & { type: 'community-lobby' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/`;
  },
  'community-events': (options: GetUrlOptions & { type: 'community-events' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/events/`;
  },
  'community-token': (options: GetUrlOptions & { type: 'community-token' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/token/`;
  },
  'community-member-applications': (options: GetUrlOptions & { type: 'community-member-applications' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/member-applications/`;
  },
  'community-members': (options: GetUrlOptions & { type: 'community-members' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/members/`;
  },
  'community-roles': (options: GetUrlOptions & { type: 'community-roles' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/roles/`;
  },
  'community-settings': (options: GetUrlOptions & { type: 'community-settings' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/settings/`;
  },
  'community-settings-info': (options: GetUrlOptions & { type: 'community-settings-info' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/settings/info/`;
  },
  'community-settings-areas-and-channels': (options: GetUrlOptions & { type: 'community-settings-areas-and-channels' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/settings/areas-and-channels/`;
  },
  'community-settings-members': (options: GetUrlOptions & { type: 'community-settings-members' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/settings/members/`;
  },
  'community-settings-bans': (options: GetUrlOptions & { type: 'community-settings-bans' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/settings/manage-bans/`;
  },
  'community-settings-roles': (options: GetUrlOptions & { type: 'community-settings-roles' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/settings/roles/`;
  },
  'community-settings-upgrades': (options: GetUrlOptions & { type: 'community-settings-upgrades' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/settings/upgrades/`;
  },
  'community-settings-token': (options: GetUrlOptions & { type: 'community-settings-token' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/settings/token/`;
  },
  'community-settings-onboarding': (options: GetUrlOptions & { type: 'community-settings-onboarding' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/settings/onboarding/`;
  },
  'community-settings-plugins': (options: GetUrlOptions & { type: 'community-settings-plugins' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/settings/plugins/`;
  },
  'community-settings-bots': (options: GetUrlOptions & { type: 'community-settings-bots' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/settings/bots/`;
  },
  'community-settings-verify': (options: GetUrlOptions & { type: 'community-settings-verify' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/settings/verify/`;
  },
  'community-create-article': (options: GetUrlOptions & { type: 'community-create-article' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/create/${config.URL_ARTICLE}/`;
  },
  'community-channel': (options: GetUrlOptions & { type: 'community-channel' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/${config.URL_CHANNEL}/${options.channel.url || `~${t.fromUUID(options.channel.channelId)}`}/`;
  },
  'community-article': (options: GetUrlOptions & { type: 'community-article' }) => {
    const uri = articleDataToUri(options.article.title, options.article.articleId);
    return `/${config.URL_COMMUNITY}/${options.community.url}/${config.URL_ARTICLE}/${uri}/`;
  },
  'community-article-edit': (options: GetUrlOptions & { type: 'community-article-edit' }) => {
    const uri = articleDataToUri(options.article.title, options.article.articleId);
    return `/${config.URL_COMMUNITY}/${options.community.url}/${config.URL_ARTICLE}/${uri}/edit/`;
  },
  'community-call': (options: GetUrlOptions & { type: 'community-call' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/${config.URL_CALL}/${t.fromUUID(options.call.id)}/`;
  },
  'community-plugin': (options: GetUrlOptions & { type: 'community-plugin' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/plugin/${options.plugin.id}/`;
  },
  'event': (options: GetUrlOptions & { type: 'event' }) => {
    return `/${config.URL_COMMUNITY}/${options.community.url}/${config.URL_EVENT}/${options.event.url || `~${t.fromUUID(options.event.id)}`}/`;
  },
  'user': (options: GetUrlOptions & { type: 'user' }) => {
    return `/${config.URL_USER}/~${t.fromUUID(options.user.id)}/`;
  },
  'create-user-post': (options: GetUrlOptions & { type: 'create-user-post' }) => {
    return `/create-user-post`;
  },
  'user-article': (options: GetUrlOptions & { type: 'user-article' }) => {
    const uri = articleDataToUri(options.article.title, options.article.articleId);
    return `/${config.URL_USER}/~${t.fromUUID(options.user.id)}/${config.URL_ARTICLE}/${uri}/`;
  },
  'user-article-edit': (options: GetUrlOptions & { type: 'user-article-edit' }) => {
    const uri = articleDataToUri(options.article.title, options.article.articleId);
    return `/${config.URL_USER}/~${t.fromUUID(options.user.id)}/${config.URL_ARTICLE}/${uri}/edit/`;
  },
  'profile-settings': (options: GetUrlOptions & { type: 'profile-settings' }) => {
    return `/profile/settings/`;
  },
  'profile-settings-account-and-wallets': (options: GetUrlOptions & { type: 'profile-settings-account-and-wallets' }) => {
    return `/profile/settings/account-and-wallets/`;
  },
  'profile-settings-calls': (options: GetUrlOptions & { type: 'profile-settings-calls' }) => {
    return `/profile/settings/calls/`;
  },
  'profile-settings-account': (options: GetUrlOptions & { type: 'profile-settings-account' }) => {
    return `/profile/settings/account/`;
  },
  'token': (options: GetUrlOptions & { type: 'token' }) => {
    return `/token/`;
  },
  'appstore': (options: GetUrlOptions & { type: 'appstore' }) => {
    return `/store/`;
  },
  'search': (options: GetUrlOptions & { type: 'search' }) => {
    return `/search/`;
  },
  'plugin-details': (options: GetUrlOptions & { type: 'plugin-details' }) => {
    return `/store/${options.plugin.pluginId}/`;
  },
};

function articleDataToUri(title: string, articleId: string) {
  const slices = slugify(title, {
    lower: true,
    strict: true,
  }).split('-').filter(Boolean).map(encodeURIComponent);
  slices.push(t.fromUUID(articleId));
  return slices.join('-');
}

export const idRegex = /^~([a-z0-9]{22})$/i;

export function getUrl(options: GetUrlOptions) {
  if (Helper[options.type]) return Helper[options.type](options);
  throw new Error("Unknown URL type");
}

export function calculateSupporterUpgradeCost(
  currentFeatures: {
    featureName: UserPremiumFeatureName;
    activeUntil: string;
  }[],
  featureName: Models.User.PremiumFeatureName,
  showLog?: boolean
) {
  const now = new Date();

  switch (featureName) {
    case UserPremiumFeatureName.SUPPORTER_1:
      throw new Error(errors.server.INVALID_REQUEST);

    case UserPremiumFeatureName.SUPPORTER_2:
      let replacedFeatureName: UserPremiumFeatureName;
      let monthlyPrice = 0;
      if (featureName === UserPremiumFeatureName.SUPPORTER_2) {
        replacedFeatureName = UserPremiumFeatureName.SUPPORTER_1;
        monthlyPrice = config.PREMIUM.USER_SUPPORTER_2.MONTHLY_PRICE - config.PREMIUM.USER_SUPPORTER_1.MONTHLY_PRICE;
      }
      else {
        throw new Error(errors.server.INVALID_REQUEST);
      }
      if (monthlyPrice <= 0) {
        console.error("Monthly price of upgrade is <= 0, this is wrong - investigate!");
        throw new Error(errors.server.UNKNOWN);
      }

      const current = currentFeatures.find(f => f.featureName === replacedFeatureName);
      const activeUntil = !!current ? new Date(current.activeUntil) : null;
      if (!current || activeUntil === null || activeUntil <= now) {
        throw new Error(errors.server.INVALID_REQUEST);
      }

      const msDiff = activeUntil.getTime() - now.getTime();
      const daysDiff = msDiff / (1000 * 60 * 60 * 24);
      const price = Math.floor((monthlyPrice / 30) * daysDiff);
      if (showLog) {
        console.log(`Upgrade for ${daysDiff.toFixed(3)} days, tier ${replacedFeatureName} to ${featureName}, total price: ${price}`);
      }

      return {
        price,
        replacedFeatureName
      };
  }

  throw new Error(errors.server.INVALID_REQUEST);
}

export function calculateCommunityUpgradeCost(
  currentFeature: {
    featureName: Models.Community.PremiumName;
    activeUntil: string;
  },
  newFeatureName: Models.Community.PremiumName,
  showLog?: boolean
) {
  if (
    currentFeature.featureName === newFeatureName ||
    newFeatureName === 'BASIC' ||
    currentFeature.featureName === 'ENTERPRISE'
  ) {
    throw new Error(errors.server.INVALID_REQUEST);
  };

  const currentFeatureData =
    currentFeature.featureName === 'BASIC' ? config.PREMIUM.COMMUNITY_BASIC :
    currentFeature.featureName === 'PRO' ? config.PREMIUM.COMMUNITY_PRO :
    null;
  const newFeatureData =
    newFeatureName === 'PRO' ? config.PREMIUM.COMMUNITY_PRO :
    newFeatureName === 'ENTERPRISE' ? config.PREMIUM.COMMUNITY_ENTERPRISE :
    null;

  if (!currentFeatureData || !newFeatureData) {
    throw new Error(errors.server.INVALID_REQUEST);
  };

  const msDiff = dayjs(currentFeature.activeUntil).diff(dayjs());
  const monthsDiff = msDiff / (30 * 1000 * 60 * 60 * 24);
  const isYearly = monthsDiff > 1;
  const priceFactor = isYearly ? (100 - config.PREMIUM.YEARLY_DISCOUNT_PERCENT) / 100 : 1;

  if (monthsDiff < 0) {
    console.error("Months difference is < 0, this is wrong - investigate!");
    throw new Error(errors.server.UNKNOWN);
  }

  const reduction = monthsDiff * currentFeatureData.MONTHLY_PRICE * priceFactor;
  const price = Math.round((monthsDiff * newFeatureData.MONTHLY_PRICE * priceFactor) - reduction);
  if (price < 0) {
    console.error("Monthly price of upgrade is < 0, this is wrong - investigate!");
    throw new Error(errors.server.UNKNOWN);
  }
  if (showLog) console.log(`Upgrade for ${monthsDiff.toFixed(3)} months, tier ${currentFeature.featureName} to ${newFeatureName}, total price: ${price}`);
  return price;
}

export function checkCommunityRequirements(
  requirements: NonNullable<Models.Community.OnboardingOptions['requirements']>,
  user: Pick<Models.User.Data, 'createdAt' | 'accounts'>
) {
  if (!requirements.enabled) return null;

  const failedRequirements: ('accTime' | 'universalProfile' | 'xAcc')[] = [];
  if (requirements.minAccountTimeEnabled && requirements.minAccountTimeDays) {
    const now = dayjs();
    const userCreated = dayjs(user.createdAt);
    if (now.isBefore(userCreated.add(requirements.minAccountTimeDays, 'day'))) {
      failedRequirements.push('accTime');
    }
  }

  if (requirements.universalProfileEnabled) {
    if (!user.accounts.some(acc => acc.type === 'lukso')) {
      failedRequirements.push('universalProfile');
    }
  }

  if (requirements.xProfileEnabled) {
    if (!user.accounts.some(acc => acc.type === 'twitter')) {
      failedRequirements.push('xAcc');
    }
  }

  if (failedRequirements.length > 0) return {failedRequirements};
  return null;
}

const icsTemplate = `BEGIN:VCALENDAR
PRODID:CommonGround
VERSION:2.0
BEGIN:VEVENT
SUMMARY:$title
DTSTART:$timeStart
DTEND:$timeEnd
DTSTAMP:$timeStart
UID:$uid
DESCRIPTION:$description
LOCATION:$url
ORGANIZER;CN=$communityName:mailto:events-no-reply@app.cg
END:VEVENT
END:VCALENDAR`;

export function dayJsToUrlFormat(time: dayjs.Dayjs) {
  // return time.toISOString();
  return time.utc().format('YYYYMMDDTHHmmss[Z]');
}

export function generateEventICSFile(baseUrl: string, community: Pick<Models.Community.ListView, "title" | "id" | "url">, event: Models.Community.Event) {
  const eventUrl = `${baseUrl}${getUrl({ type: 'event', community, event })}`;

  return icsTemplate
    .replaceAll('$title', event.title)
    .replaceAll('$timeStart', dayJsToUrlFormat(dayjs(event.scheduleDate)))
    .replaceAll('$timeEnd', dayJsToUrlFormat(dayjs(event.scheduleDate).add(event.duration, 'minutes')))
    .replaceAll('$uid', event.id)
    .replaceAll('$description', encodeURI(`To see more details: ${eventUrl}`))
    .replaceAll('$url', encodeURI(eventUrl))
    .replaceAll('$communityName', community.title);
}

const letters = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

export function getRandomReadableString(len: number) {
    let s = "";
    while (len > 0) {
        len--;
        s = s + letters[Math.floor(Math.random() * letters.length)];
    }
    return s;
}
