// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { PredefinedRole } from "common/enums";
import data from "data";
import { isPredefinedRolePermission } from "util/predefinedRoles";

export type GatedStatus = {
  type: 'preview' | 'attend';
  roles: Models.Community.Event['rolePermissions'];
} | null;

export async function isEventGated(
  event: Models.Community.Event,
): Promise<GatedStatus> {
  // Short-circuit if public or member can attend to avoid async fetch
  const publicCanRead = event.rolePermissions.some(rolePermission =>
    ((isPredefinedRolePermission(rolePermission, PredefinedRole.Public) || isPredefinedRolePermission(rolePermission, PredefinedRole.Member)) &&
    rolePermission.permissions.includes('EVENT_ATTEND'))
  );
  if (publicCanRead) return null;

  const myCommunities = await data.community.getOwnCommunities();
  const community = myCommunities.find(comm => comm.id === event.communityId);
  const ownRoleIds: string[] = [];

  const publicRoleId = event.rolePermissions.find(role => isPredefinedRolePermission(role, PredefinedRole.Public))?.roleId;
  if (publicRoleId) ownRoleIds.push(publicRoleId);
  if (community) {
    ownRoleIds.push(...community.myRoleIds);
    const memberRoleId = event.rolePermissions.find(role => isPredefinedRolePermission(role, PredefinedRole.Member))?.roleId;
    if (memberRoleId) ownRoleIds.push(memberRoleId);
  }

  const selfCanAttend = ownRoleIds.some(myRoleId => event.rolePermissions.some(rolePermission => rolePermission.roleId === myRoleId && rolePermission.permissions.includes('EVENT_ATTEND')));
  if (selfCanAttend) {
    return {
      type: 'attend',
      roles: event.rolePermissions.filter(rolePermission => ownRoleIds.includes(rolePermission.roleId) && rolePermission.permissions.includes('EVENT_ATTEND'))
    }
  } else {
    return {
      type: 'preview',
      roles: event.rolePermissions.filter(rolePermission => ownRoleIds.includes(rolePermission.roleId) && rolePermission.permissions.includes('EVENT_PREVIEW'))
    }
  }
}