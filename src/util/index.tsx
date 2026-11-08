// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import type { AccessLevel, AjaxResponse } from "common/types";
import { idRegex, itemUrlRegex } from "common/util";
import { createTranslator } from 'short-uuid';
import XIcon from '../components/atoms/icons/24/X.svg?react';
import OfficialIcon from "../components/atoms/icons/20/OfficialIcon.svg?react";
import FarcasterIcon from '../components/atoms/icons/24/Farcaster.svg?react';
import { Tooltip } from "components/atoms/Tooltip/Tooltip";
import ExternalIcon from "components/atoms/ExternalIcon/ExternalIcon";
import CrystalIcon from "../components/atoms/icons/misc/communitySettings/crystal.webp";
import CompassIcon from "../components/atoms/icons/misc/communitySettings/compass.webp";
import GoldStarIcon from "../components/atoms/icons/misc/communitySettings/goldstar.webp";
import SilverStarIcon from "../components/atoms/icons/misc/communitySettings/silverstar.webp";
import PaintbrushIcon from "../components/atoms/icons/misc/communitySettings/paintbrush.webp";
import TvIcon from "../components/atoms/icons/misc/communitySettings/tv.webp";
import GoldTvIcon from "../components/atoms/icons/misc/communitySettings/goldtv.webp";
import { MdWorkspacePremium } from "react-icons/md";
import dayjs from "dayjs";

const t = createTranslator();

export async function ajax<T>(method: "GET" | "PUT" | "POST" | "UPDATE", url: string, data?: string | FormData): Promise<AjaxResponse<T>> {
  try {
    const result = await new Promise<any>((resolve, reject) => {
      let rejected = false;
      const oReq = new XMLHttpRequest();
      oReq.responseType = "json";
      oReq.onreadystatechange = () => {
        if (oReq.readyState === 4) {
          if (oReq.status === 200) {
            resolve(oReq.response);
          } else {
            console.warn(`Unexpected oReq status: ${oReq.status.toString()}`, oReq);
            if (!rejected) {
              reject(new Error(`Unexpected status: ${oReq.status.toString()}`));
              rejected = true;
            }
          }
        }
      };
      oReq.onerror = (err) => {
        console.warn(`Error occurred in ajax request`, oReq.statusText, err);
        if (!rejected) {
          reject(err);
          rejected = true;
        }
      }
      oReq.open(method, url);
      oReq.setRequestHeader('Content-Type', 'application/json');
      oReq.setRequestHeader('Accept', 'application/json');
      oReq.withCredentials = true;
      oReq.send(data);
    });
    return result;
  } catch (e) {
    let error = 'An unknown error occurred';
    if (e instanceof Error) {
      error = e.message;
    }
    return {
      status: "ERROR",
      error
    };
  }
}

export function stringifyMetamaskError(e: unknown) {
  const errorCode: number | undefined = (e as any)?.code;
  const stringError: string | undefined = (e as any)?.data?.message;
  if (stringError && stringError.startsWith('VM Exception while processing transaction: revert ')) {
    return stringError.replace('VM Exception while processing transaction: revert ', '');
  }
  if (errorCode === 4001) {
    return 'Transaction cancelled by user';
  }
  return 'Unknown error';
}

export function getTruncatedId(userId: string) {
  userId = userId || '';
  return `${userId.slice(0, 4)}...${userId.slice(-4)}`;
}

export function getDisplayName(userData: Pick<Models.User.Data, | 'displayAccount' | 'accounts' | 'id'>, hideIcon?: boolean, specificAccountType?: Models.User.ProfileItemType) {
  let currentAccount: Models.User.ProfileItem | undefined = undefined;
  let customDisplayName: React.JSX.Element | undefined = undefined;
  if (!!specificAccountType) {
    currentAccount = userData.accounts?.find(acc => acc.type === specificAccountType);
  }
  else {
    currentAccount = userData.accounts?.find(acc => acc.type === userData.displayAccount);
  }
  if (currentAccount?.type === 'lukso') {
    customDisplayName = <span className="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">
      {currentAccount.displayName.slice(0, currentAccount.displayName.length - 5)}
      <span className="cg-text-secondary">
        {currentAccount.displayName.slice(currentAccount.displayName.length - 5, currentAccount.displayName.length)}
      </span>
    </span>;
  }
  else {
    customDisplayName = <span className="flex-1 whitespace-nowrap overflow-hidden text-ellipsis">
      {currentAccount?.displayName || getTruncatedId(userData.id)}
    </span>;
  }
  if (hideIcon) {
    return customDisplayName;
  } else {
    return <span className="flex items-center gap-1 max-w-full">
      {currentAccount?.type === 'twitter' && <XIcon className="w-4 h-4" />}
      {currentAccount?.type === 'lukso' && <ExternalIcon type="universalProfile" className="w-4 h-4" />}
      {currentAccount?.type === 'farcaster' && <FarcasterIcon className="w-4 h-4" />}
      {customDisplayName}
    </span>;
  }
}

export const getTierIcon = (featureName: Models.Premium.TransactionFeatureName) => {
  switch (featureName) {
    case 'URL_CHANGE': return <img src={CrystalIcon} loading="lazy" alt="icon" className="p-2" />
    case 'VISIBILITY': return <img src={CompassIcon} loading="lazy" alt="icon" />
    case 'COSMETICS_1': return <img src={PaintbrushIcon} loading="lazy" alt="icon" />
    case 'TOKENS_ROLES_1': return <img src={SilverStarIcon} loading="lazy" alt="icon" />
    case 'TOKENS_ROLES_2': return <img src={GoldStarIcon} loading="lazy" alt="icon" style={{ transform: 'scale(1.3)' }} />
    case 'CALLS_1': return <img src={TvIcon} loading="lazy" alt="icon" />
    case 'CALLS_2': return <img src={GoldTvIcon} loading="lazy" alt="icon" />
    case 'BASIC': return <div className="flex items-center justify-center w-10 h-10"><MdWorkspacePremium className="w-6 h-6" color="rgb(164,164,164)" /></div>
    case 'PRO': return <div className="flex items-center justify-center w-10 h-10"><MdWorkspacePremium className="w-6 h-6" color="rgb(212,175,55)" /></div>
    case 'ENTERPRISE': return <div className="flex items-center justify-center w-10 h-10"><MdWorkspacePremium className="w-6 h-6" color="var(--colours-brand-700)" /></div>
  }
  return null;
}

export const getTierTitle = (featureName: Models.Premium.TransactionFeatureName | 'FREE') => {
  switch (featureName) {
    case 'URL_CHANGE': return 'Unique community URL (old)';
    case 'VISIBILITY': return 'Publish Community (old)';
    case 'COSMETICS_1': return 'Cosmetic Pack (old)';
    case 'TOKENS_ROLES_1': return 'Medium Roles & Tokens (old)';
    case 'TOKENS_ROLES_2': return 'Large Roles & Tokens (old)';
    case 'CALLS_1': return 'Medium Calls (old)';
    case 'CALLS_2': return 'Large Calls (old)';
    case 'FREE': return 'Free Tier';
    case 'BASIC': return 'Plus Tier';
    case 'PRO': return 'Pro Tier';
    case 'ENTERPRISE': return 'Elite Tier';
  }
}

export const getTierElementIcon = (featureName: Models.Premium.TransactionFeatureName, className?: string) => {
  switch (featureName) {
    case 'BASIC': return <MdWorkspacePremium color="rgb(164,164,164)" className={className} />
    case 'PRO': return <MdWorkspacePremium color="rgb(212,175,55)" className={className} />
    case 'ENTERPRISE': return <MdWorkspacePremium color="var(--colours-brand-700)" className={className} />
  }
  return null;
}

export const getTierElementTitle = (featureName: Models.Premium.TransactionFeatureName | 'FREE') => {
  switch (featureName) {
    case 'FREE': return 'Free';
    case 'BASIC': return 'Plus';
    case 'PRO': return 'Pro';
    case 'ENTERPRISE': return 'Elite';
  }
}

export function getDisplayNameString(userData: Pick<Models.User.Data, 'displayAccount' | 'accounts' | 'id'>) {
  return userData.accounts?.find(acc => acc.type === userData.displayAccount)?.displayName || getTruncatedId(userData.id);
}

export function getCommunityDisplayName(community: Pick<Models.Community.ListView, 'title' | 'official' | 'premium'>, iconClassName = 'w-5 h-5', noIcon?: boolean) {
  let premiumIcon: React.JSX.Element | undefined = undefined;
  if (!noIcon && !!community.premium && dayjs(community.premium.activeUntil).isAfter(dayjs())) {
    const tier = community.premium.featureName;
    premiumIcon = <Tooltip
      offset={8}
      triggerContent={getTierElementIcon(tier, iconClassName)!}
      triggerClassName="flex items-center"
      tooltipContent={getTierElementTitle(tier)! + ' Community'}
      placement="top"
      allowPropagation
    />;
  }

  return <div className='flex items-center overflow-hidden gap-1'>
    <span className="whitespace-nowrap overflow-hidden text-ellipsis">{community.title}</span>
    {premiumIcon}
    {!noIcon && community.official && <Tooltip
      offset={8}
      triggerContent={<OfficialIcon className={iconClassName} />}
      triggerClassName="flex items-center"
      tooltipContent="Official Community"
      placement="top"
      allowPropagation
    />}
    {/* {!community.official && community.nftId && <Tooltip
      offset={8}
      triggerContent={<VerifiedIcon className='w-4 h-4 cg-text-secondary' />}
      triggerClassName="flex items-center"
      tooltipContent="Verified Community"
      placement="top"
      allowPropagation
    />} */}
  </div>
}

export function getChannelDisplayName(channelName: string) {
  return channelName;
}

export function parseIdOrUrl(param: string) {
  let m = param.match(idRegex);
  if (!!m) {
    return { uuid: t.toUUID(m[1]) };
  }
  m = param.match(itemUrlRegex);
  if (!!m) {
    return { url: param };
  }
  throw new Error("Neither valid url nor valid short-uuid")
}

export function getOnlineStatusName(status: Models.User.OnlineStatus | 'offline') {
  switch (status) {
    case 'online':
      return 'Online';
    case 'away':
      return 'Away';
    case 'dnd':
      return 'Busy';
    case 'invisible':
      return 'Invisible';
    case 'offline':
      return 'Offline';
    default:
      console.error(`Unknown online status: ${status}`);
      return '';
  }
}

export function getRoleDisplayName(accessLevel: AccessLevel) {
  return accessLevel.charAt(0).toUpperCase() + accessLevel.slice(1);
}

export function getUserExternalLink(detailedProfiles: Models.User.ProfileItemWithDetails[], accountType: Omit<Models.User.ProfileItemType, 'cg'>) {
  const acc = detailedProfiles.find(acc => acc.type === accountType);
  if (!acc) return null;
  if (acc.extraData?.type === 'lukso') {
    return `https://universalprofile.cloud/${acc.extraData?.upAddress}`;
  } else if (acc.extraData?.type === 'farcaster') {
    return `https://warpcast.com/${acc.extraData.username}`;
  } else if (acc.type === 'twitter') {
    return normalizeTwitterLink(acc.displayName);
  }
}

const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export function randomString(length: number = 20) {
  let str = '';
  for (let i = 0; i < length; i++) {
    str += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return str;
}

export function debounce<T extends Function>(cb: T, wait = 20) {
  let h: NodeJS.Timeout;
  let callable = (...args: any) => {
    clearTimeout(h);
    h = setTimeout(() => cb(...args), wait);
  };
  return (callable as any) as T;
}

export function normalizeTwitterLink(link: string): string {
  const regexp = new RegExp("https?://(www\\.)?x\\.com");
  if (regexp.test(link)) {
    return link;
  } else {
    return `https://x.com/${link}`;
  }
};