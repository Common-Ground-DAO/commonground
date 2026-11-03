// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { PredefinedRole, RoleType } from "common/enums";

/**
 * The predefined roles are told apart by type and title: a custom role may
 * carry the same title (from before the titles were reserved) and is an
 * ordinary role.
 */
export function isPredefinedRole(role: { title: string; type: Common.RoleType | RoleType }, title: PredefinedRole): boolean {
  return role.type === RoleType.PREDEFINED && role.title === title;
}

export function isPublicRole(role: { title: string; type: Common.RoleType | RoleType }): boolean {
  return isPredefinedRole(role, PredefinedRole.Public);
}

/**
 * The same for an entry of a role permission list (channel, article, event):
 * by `roleType` where the list carries it, by the title alone where it does
 * not (lists from older servers, lists the client builds itself).
 */
export function isPredefinedRolePermission(permission: { roleTitle: string; roleType?: Common.RoleType }, title: PredefinedRole): boolean {
  return permission.roleTitle === title
    && (permission.roleType === undefined || permission.roleType === RoleType.PREDEFINED);
}

export function isPublicRolePermission(permission: { roleTitle: string; roleType?: Common.RoleType }): boolean {
  return isPredefinedRolePermission(permission, PredefinedRole.Public);
}
