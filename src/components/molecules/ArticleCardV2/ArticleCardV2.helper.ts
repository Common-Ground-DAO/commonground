// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { PredefinedRole } from "common/enums";
import data from "data";
import dayjs, { Dayjs } from "dayjs";
import { isPredefinedRolePermission } from "util/predefinedRoles";

export function isRecentUnread(date: Dayjs, isDraft: boolean, isRead: boolean) {
  return dayjs().diff(date, 'days') <= 7 && !isRead && !isDraft;
}

export function calculateArticleAgeString(cardDate: dayjs.Dayjs) {
  const now = dayjs();
  const sameYear = now.year() === cardDate.year();
  
  if (cardDate.isAfter(now)) {
    return `Scheduled for ${cardDate.format(`HH:mm ${sameYear ? 'MMM DD' : 'MMM DD, YYYY'}`)}`;
  }

  if (now.diff(cardDate, 'days') >= 7) {
    const sameYear = now.year() === cardDate.year();
    return cardDate.format(sameYear ? 'MMM DD' : 'MMM DD, YYYY');
  }
  const diffDays = now.diff(cardDate, 'days');
  const diffHours = now.diff(cardDate, 'hours');
  const diffMinutes = now.diff(cardDate, 'minutes');

  if (diffDays > 0) return `${diffDays}d ago`;
  if (diffHours > 0) return `${diffHours}h ago`;
  if (diffMinutes > 0) return `${diffMinutes}m ago`;

  return `${now.diff(cardDate, 'seconds')}s ago`;
}

export type GatedFooterStatus = {
  type: 'preview' | 'read';
  roles: Models.Community.CommunityArticlePermission[];
} | null;

export async function isArticleGated(
  communityArticle: Models.Community.CommunityArticle,
): Promise<GatedFooterStatus> {
  // Short-circuit if public can read to avoid async fetch
  const publicCanRead = communityArticle.rolePermissions.some(rolePermission => isPredefinedRolePermission(rolePermission, PredefinedRole.Public) && rolePermission.permissions.includes('ARTICLE_READ'));
  if (publicCanRead) return null;

  const myCommunities = await data.community.getOwnCommunities();
  const community = myCommunities.find(comm => comm.id === communityArticle.communityId);
  const ownRoleIds: string[] = [];
  
  const publicRoleId = communityArticle.rolePermissions.find(role => isPredefinedRolePermission(role, PredefinedRole.Public))?.roleId;
  if (publicRoleId) ownRoleIds.push(publicRoleId);
  if (community) {
    ownRoleIds.push(...community.myRoleIds);
    const memberRoleId = communityArticle.rolePermissions.find(role => isPredefinedRolePermission(role, PredefinedRole.Member))?.roleId;
    if (memberRoleId) ownRoleIds.push(memberRoleId);  
  }

  const selfCanRead = ownRoleIds.some(myRoleId => communityArticle.rolePermissions.some(rolePermission => rolePermission.roleId === myRoleId && rolePermission.permissions.includes('ARTICLE_READ')));
  if (selfCanRead) {
    return {
      type: 'read',
      roles: communityArticle.rolePermissions.filter(rolePermission => ownRoleIds.includes(rolePermission.roleId) && rolePermission.permissions.includes('ARTICLE_READ'))
    }
  } else {
    return {
      type: 'preview',
      roles: communityArticle.rolePermissions.filter(rolePermission => ownRoleIds.includes(rolePermission.roleId) && rolePermission.permissions.includes('ARTICLE_PREVIEW'))
    }
  }
}