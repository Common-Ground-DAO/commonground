// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import Button from 'components/atoms/Button/Button';
import DeleteRoleModal from './DeleteRoleModal';
import OptionToggle from 'components/molecules/OptionToggle/OptionToggle';
import RoleAccessEditor from 'components/molecules/RoleAccessEditor/RoleAccessEditor';
import RolePhoto from 'components/molecules/RolePhoto/RolePhoto';
import { useContractData, useLoadedCommunityContext } from 'context/CommunityProvider';
import { StarIcon } from '@heroicons/react/20/solid';
import { PredefinedRole } from 'common/enums';
import { isPredefinedRole } from "util/predefinedRoles";

type Props = {
  currentRole: Models.Community.Role;
  setCurrentRole: React.Dispatch<React.SetStateAction<Models.Community.Role | undefined>>;
  onDeleteRole: () => void;
  lockEditing?: 'fullLock' | 'allowMember';
};

type PermissionToggleInfo = {
  title: string;
  description: string;
  permission: Common.CommunityPermission;
}

const adminPermissions: PermissionToggleInfo[] = [{
  title: 'Manage community',
  description: 'Change the name, description, links, and more',
  permission: 'COMMUNITY_MANAGE_INFO'
}, {
  title: 'Manage roles',
  description: 'Create, change, and assign roles',
  permission: 'COMMUNITY_MANAGE_ROLES'
}, {
  title: 'Manage channels',
  description: 'Create, edit, and delete areas and channels',
  permission: 'COMMUNITY_MANAGE_CHANNELS'
}, {
  title: 'Manage events',
  description: 'Create, edit, and delete communities events',
  permission: 'COMMUNITY_MANAGE_EVENTS'
}];

const moderatorPermissions: PermissionToggleInfo[] = [
  {
    title: 'Can mute and ban users',
    description: 'Can mute and ban users from the community',
    permission: 'COMMUNITY_MODERATE'
  },
  {
    title: 'Moderate calls',
    description: 'Can enter and moderate calls, can end calls',
    permission: 'WEBRTC_MODERATE'
  }, {
    title: 'Manage posts',
    description: 'Publish, edit and delete posts',
    permission: 'COMMUNITY_MANAGE_ARTICLES'
  }, {
    title: 'Manage events',
    description: 'Schedule, edit, and delete events',
    permission: 'COMMUNITY_MANAGE_EVENTS'
  }, {
    title: 'Manage user applications',
    description: 'Approve, reject and block users from joining the community',
    permission: 'COMMUNITY_MANAGE_USER_APPLICATIONS'
  }
];

const memberPermissions: PermissionToggleInfo[] = [
  {
    title: 'Can start basic calls',
    description: 'Start calls but not change access permissions - any member can join',
    permission: 'WEBRTC_CREATE'
  },
  {
    title: 'Can start advanced calls',
    description: 'Start calls with custom permissions for any role, must set at least one role the user has',
    permission: 'WEBRTC_CREATE_CUSTOM'
  }
];

export const allPermissions = [...memberPermissions, ...moderatorPermissions, ...adminPermissions];
export const permissionsPerStarNumber: Record<number, Common.CommunityPermission[]> = {
  1: ['WEBRTC_CREATE', 'WEBRTC_CREATE_CUSTOM'],
  2: ['COMMUNITY_MODERATE', 'WEBRTC_MODERATE', 'COMMUNITY_MANAGE_ARTICLES'],
  3: ['COMMUNITY_MANAGE_INFO', 'COMMUNITY_MANAGE_ROLES', 'COMMUNITY_MANAGE_CHANNELS']
};

const RoleEditor: React.FC<Props> = (props) => {
  const { community } = useLoadedCommunityContext();
  const { currentRole, setCurrentRole, onDeleteRole, lockEditing } = props;
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const isAdmin = isPredefinedRole(currentRole, PredefinedRole.Admin);

  const contractIds = useMemo(() => {
    return community.tokens.map(token => token.contractId);
  }, [community.tokens]);
  const contractData = useContractData(contractIds);

  const togglePermission = useCallback((permission: Common.CommunityPermission) => {
    setCurrentRole(oldRole => {
      if (!oldRole) return oldRole;
      if (oldRole.permissions.includes(permission)) {
        return {
          ...oldRole,
          permissions: oldRole.permissions.filter(perm => perm !== permission)
        };
      } else {
        return {
          ...oldRole,
          permissions: [...oldRole.permissions, permission]
        };
      }
    });
  }, [setCurrentRole]);

  return (
    <div className='flex flex-col gap-8'>
      <div className='flex flex-col gap-4'>
        <span className='roles-management-title'>General</span>
        <div className='roles-management-role-editor-container'>
          <div className='flex justify-center'>
            <RolePhoto
              communityId={community.id}
              imageId={currentRole.imageId}
              setImageId={(imageId: string | null) => setCurrentRole(oldRole => oldRole ? ({ ...oldRole, imageId }) : undefined)}
              roleId={currentRole.id}
              editMode
            />
          </div>
          <TextInputField
            value={currentRole.title}
            onChange={(value) => setCurrentRole(oldRole => oldRole ? ({ ...oldRole, title: value }) : undefined)}
            label='Role name'
            disabled={!!lockEditing}
          />

          <TextInputField
            value={currentRole.description || ''}
            onChange={(value) => setCurrentRole(oldRole => oldRole ? ({ ...oldRole, description: value }) : undefined)}
            label={`Who is this role for${currentRole.assignmentRules?.type === 'token' ? ' and how to get it' : ''}?`}
            placeholder='Role description'
          />
        </div>
      </div>
      <div className='flex flex-col gap-4'>
        {!lockEditing && <div className='flex flex-col gap-2'>
          <span className='roles-management-title'>Role Requirements</span>
          <RoleAccessEditor
            assignmentRules={currentRole.assignmentRules}
            setAssignmentRules={(assignmentRules) => setCurrentRole(oldRole => oldRole ? ({ ...oldRole, assignmentRules }) : undefined)}
            lockEditing={!!lockEditing}
            community={community}
            contractData={contractData}
          />
        </div>}

        <span className='roles-management-title'>Role Permissions</span>
        <div className='roles-management-role-editor-container'>
          <div className='roles-management-subtitle'>
            <div className='cg-text-secondary flex items-center'>
              <StarIcon className='w-5 h-5' />
            </div>
            <span>Member level Permissions</span>
          </div>
          {memberPermissions.map(permission =>
            <PermissionToggle
              key={permission.permission}
              permission={permission.permission}
              title={permission.title}
              description={permission.description}
              isToggled={currentRole.permissions.includes(permission.permission)}
              togglePermission={togglePermission}
              disabled={lockEditing === 'fullLock'}
            />
          )}
        </div>
        <div className='roles-management-role-editor-container'>
          <div className='roles-management-subtitle'>
            <div className='cg-text-secondary flex items-center'>
              <StarIcon className='w-5 h-5' />
              <StarIcon className='w-5 h-5' />
            </div>
            <span>Moderator level Permissions</span>
          </div>
          {moderatorPermissions.map(permission =>
            <PermissionToggle
              key={permission.permission}
              permission={permission.permission}
              title={permission.title}
              description={permission.description}
              isToggled={currentRole.permissions.includes(permission.permission)}
              togglePermission={togglePermission}
              disabled={!!lockEditing}
            />
          )}
        </div>

        {isAdmin && <div className='roles-management-role-editor-container'>
          <div className='roles-management-subtitle'>
            <div className='cg-text-secondary flex items-center'>
              <StarIcon className='w-5 h-5' />
              <StarIcon className='w-5 h-5' />
              <StarIcon className='w-5 h-5' />
            </div>
            <span>Admin level Permissions</span>
          </div>
          {adminPermissions.map(permission =>
            <PermissionToggle
              key={permission.permission}
              permission={permission.permission}
              title={permission.title}
              description={permission.description}
              isToggled={currentRole.permissions.includes(permission.permission)}
              togglePermission={togglePermission}
              disabled={!!lockEditing}
            />
          )}
        </div>}
      </div>
      <div className='flex items-center justify-center py-4'>
        <Button
          className='w-full'
          role='destructive'
          text="Delete role"
          onClick={() => setShowDeleteModal(true)}
          disabled={!!lockEditing}
        />
        <DeleteRoleModal
          visible={showDeleteModal}
          onCancel={() => setShowDeleteModal(false)}
          onDeleteModal={() => {
            setShowDeleteModal(false);
            onDeleteRole();
          }}
          numUsers={0} // FIXME: Use proper number
        />
      </div>
    </div>
  )
}

type PermissionToggleProps = {
  title: string;
  description: string;
  isToggled: boolean;
  permission: Common.CommunityPermission;
  togglePermission: (permission: Common.CommunityPermission) => void;
  disabled?: boolean;
};

const PermissionToggle: React.FC<PermissionToggleProps> = (props) => {
  const { title, description, isToggled, permission, togglePermission, disabled } = props;

  return <OptionToggle
    title={title}
    description={description}
    isToggled={isToggled}
    onToggle={() => togglePermission(permission)}
    disabled={disabled}
  />
};

export default React.memo(RoleEditor);