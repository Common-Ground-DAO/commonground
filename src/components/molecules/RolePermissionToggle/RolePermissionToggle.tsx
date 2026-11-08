// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo } from 'react'
import { PredefinedRole, RoleType } from 'common/enums';
import RolePermissionToggleUnit from 'components/atoms/RolePermissionToggleUnit/RolePermissionToggleUnit';

import './RolePermissionToggle.css';
import { isPredefinedRole } from "util/predefinedRoles";

export type PermissionType = 'none' | 'preview' | 'read' | 'full' | 'moderate';

type Props = {
  availablePermissions: PermissionType[];
  title?: string;
  subtitle?: string;
  roles: readonly Models.Community.Role[];
  rolesPermissions: { [id: string]: PermissionType };
  setRolesPermissions: React.Dispatch<React.SetStateAction<{ [id: string]: PermissionType }>>;
};

const RolePermissionToggle: React.FC<Props> = (props) => {
  const { title, subtitle, availablePermissions, roles, rolesPermissions, setRolesPermissions } = props;
  const [publicRole, memberRole, customRoles] = useMemo(() => {
    return [
      roles.find(role => isPredefinedRole(role, PredefinedRole.Public)),
      roles.find(role => isPredefinedRole(role, PredefinedRole.Member)),
      roles.filter(role => role.type !== RoleType.PREDEFINED)
    ];
  }, [roles]);

  return (
    <div className='flex flex-col gap-4 w-full'>
      <div className='flex flex-col'>
        {title && <span className='cg-text-lg-500 cg-text-main'>{title}</span>}
        {subtitle && <span className='cg-text-md-400 cg-text-secondary'>{subtitle}</span>}
      </div>
      <div className='cg-separator' />
      <RolePermissionToggleUnit
        role={{ title: 'Set for everyone' } as any}
        availablePermissions={availablePermissions}
        selectedPermission='none'
        setRolesPermissions={setRolesPermissions}
        forcedTriggerTitle='Select'
        forcedSetRolesPermissions={(permission) => {
          const modifiedRolesPermissions = customRoles.reduce((acc, role) => ({ ...acc, [role.id]: permission }), {} as { [id: string]: PermissionType });
          if (publicRole) modifiedRolesPermissions[publicRole.id] = permission;
          if (memberRole) modifiedRolesPermissions[memberRole.id] = permission;
          setRolesPermissions(old => ({
            ...old,
            ...modifiedRolesPermissions
          }));
        }}
      />
      <div className='flex flex-col gap-1'>
        <span className='role-permission-section-title'>Fixed roles</span>
        {publicRole && <RolePermissionToggleUnit
          availablePermissions={availablePermissions}
          selectedPermission={rolesPermissions[publicRole.id]}
          setRolesPermissions={setRolesPermissions}
          role={publicRole}
        />}
        {memberRole && <RolePermissionToggleUnit
          availablePermissions={availablePermissions}
          selectedPermission={rolesPermissions[memberRole.id]}
          setRolesPermissions={setRolesPermissions}
          role={memberRole}
        />}
      </div>
      <div className='cg-separator' />
      {customRoles.length > 0 && <div className='flex flex-col gap-1'>
        <span className='role-permission-section-title'>Custom roles</span>
        {customRoles.map(role => <RolePermissionToggleUnit
          key={role.id}
          availablePermissions={availablePermissions}
          selectedPermission={rolesPermissions[role.id]}
          setRolesPermissions={setRolesPermissions}
          role={role}
        />)}
      </div>}
    </div>
  )
}

export default RolePermissionToggle