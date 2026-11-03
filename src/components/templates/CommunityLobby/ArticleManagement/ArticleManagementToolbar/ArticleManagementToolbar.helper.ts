// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { PredefinedRole } from "common/enums";
import { PermissionType } from "components/molecules/RolePermissionToggle/RolePermissionToggle";
import { isPredefinedRolePermission } from "util/predefinedRoles";

function toPermissionType(permissions: Common.ArticlePermission[]): PermissionType {
  if (permissions.includes('ARTICLE_READ')) return 'full';
  else if (permissions.includes('ARTICLE_PREVIEW')) return 'preview';
  else return 'none';
}

export function articlePermissionsToPermissionType(articlePermissions: Models.Community.CommunityArticlePermission[]): Record<string, PermissionType> {
  return articlePermissions.reduce((acc, permission) => {
    // Don't convert admin, we won't modify it and won't send it either
    if (isPredefinedRolePermission(permission, PredefinedRole.Admin)) return acc;

    return {
      ...acc,
      [permission.roleId]: toPermissionType(permission.permissions)
    }
  }, {});
}

export function checkIsPrivateArticle(articlePermissions: Models.Community.CommunityArticlePermission[]) {
  const publicCanRead = articlePermissions.find(permission => isPredefinedRolePermission(permission, PredefinedRole.Public))?.permissions.includes('ARTICLE_READ');

  return !publicCanRead
}

export function permissionTypeToArticlePermissions(
  roles: readonly Models.Community.Role[],
  permissions: Record<string, PermissionType>,
  defaultPermissions: Models.Community.CommunityArticlePermission[]
): Models.Community.CommunityArticlePermission[] {
  const articlePermissions = Object.keys(permissions).map(roleId => {
    const newPermissions: Common.ArticlePermission[] = [];
    if (permissions[roleId] === 'preview') newPermissions.push('ARTICLE_PREVIEW');
    else if (permissions[roleId] === 'full') newPermissions.push('ARTICLE_PREVIEW', 'ARTICLE_READ');

    const role = roles.find(role => role.id === roleId);

    return {
      roleId: roleId,
      roleTitle: role?.title || '',
      roleType: role?.type,
      permissions: newPermissions
    }
  });

  if (!checkIsPrivateArticle(articlePermissions)) {
    return defaultPermissions;
  } else {
    return articlePermissions;
  }
}