// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import type { PermissionType } from "components/molecules/RolePermissionToggle/RolePermissionToggle";
import { rolePermissionPresets } from "common/presets";
import { PredefinedRole } from "common/enums";
import { isPredefinedRolePermission } from "util/predefinedRoles";

export function permissionTypeToChannelPermissions(
  roles: readonly Models.Community.Role[],
  permissions: Record<string, PermissionType>,
  defaultPermissions: Models.Community.CommunityChannelPermission[]
): Models.Community.CommunityChannelPermission[] {
  const channelPermissions = Object.keys(permissions).map(roleId => {
    if (permissions[roleId] === 'none') return null;

    const newPermissions: Common.ChannelPermission[] = ['CHANNEL_EXISTS'];
    if (permissions[roleId] === 'read') newPermissions.push('CHANNEL_READ');
    else if (permissions[roleId] === 'full') newPermissions.push('CHANNEL_READ', 'CHANNEL_WRITE');
    else if (permissions[roleId] === 'moderate') newPermissions.push('CHANNEL_READ', 'CHANNEL_WRITE', 'CHANNEL_MODERATE');

    const role = roles.find(role => role.id === roleId);

    return {
      roleId: roleId,
      roleTitle: role?.title || '',
      roleType: role?.type,
      permissions: newPermissions
    }
  });

  const filteredPermissions = channelPermissions.filter(p => !!p) as Models.Community.CommunityChannelPermission[];

  if (!channelHasCustomPermissions(filteredPermissions)) {
    return defaultPermissions;
  } else {
    return filteredPermissions;
  }
}

/**
 * Whether the form's permissions differ from the channel presets. Admin is
 * normally absent: `channelPermissionsToPermissionType` drops it on purpose
 * (the form neither edits nor sends it, the server keeps Admin's access), so a
 * missing Admin entry counts as "matches the preset".
 */
export function channelHasCustomPermissions(channelPermissions: Models.Community.CommunityChannelPermission[]) {
  for (const key of Object.keys(rolePermissionPresets.Channel) as (keyof typeof rolePermissionPresets["Channel"])[]) {
    const preset = new Set(rolePermissionPresets.Channel[key]) as Set<Common.ChannelPermission>;
    const p = channelPermissions.find(cp => isPredefinedRolePermission(cp, key as PredefinedRole));
    if (!!p) {
      if (preset.size !== p.permissions.length || p.permissions.some(perm => !preset.has(perm))) {
        return true;
      }
    }
    else if (key === "Member" || key === "Public") {
      return true;
    }
  }
  return false;
}
