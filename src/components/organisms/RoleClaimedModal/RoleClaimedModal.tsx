// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useMemo, useRef } from 'react';
import './RoleClaimedModal.css';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import RolePhoto from 'components/molecules/RolePhoto/RolePhoto';
import Button from 'components/atoms/Button/Button';
import { PermissionType } from 'components/molecules/RolePermissionToggle/RolePermissionToggle';
import { toPermissionType } from 'components/templates/CommunityLobby/ChannelManagement/EditChannelForm';
import { XMarkIcon } from '@heroicons/react/24/solid';
import RolePermissionList from 'components/molecules/RolePermissionList/RolePermissionList';
import confetti from 'canvas-confetti';
import data from 'data';
import SpinnerIcon from 'components/atoms/icons/16/Spinner.svg?react';
import { useLiveQuery } from 'dexie-react-hooks';

type Props = {
  role: Models.Community.Role;
  communityId: string;
  visible: boolean;
  onClose: () => void;
};


function calculateNewChannels(channels: readonly Models.Community.Channel[], ownRoles: readonly Models.Community.Role[], newRole: Models.Community.Role) {
  const result: {
    channel: Models.Community.Channel;
    permission: PermissionType;
  }[] = [];

  for (const channel of channels) {
    const newRolePermission = channel.rolePermissions.find(rolePermission => rolePermission.roleId === newRole.id);
    if (newRolePermission) {
      let newRolePermissionValues = newRolePermission?.permissions;
      for (const ownRole of ownRoles) {
        const ownRolePermission = channel.rolePermissions.find(rolePermission => rolePermission.roleId === ownRole.id);
        if (ownRolePermission && newRole.id !== ownRole.id) {
          newRolePermissionValues = newRolePermission.permissions.filter(permission => !ownRolePermission.permissions.includes(permission));
        }
      }
      const permission = toPermissionType(newRolePermissionValues);
      if (permission !== 'none') {
        result.push({ channel, permission });
      }
    }
  }

  return result;
}

function calculateNewPermissions(ownRoles: readonly Models.Community.Role[], newRole: Models.Community.Role) {
  return newRole.permissions.filter(permission => ownRoles.every(otherRole => otherRole.id === newRole.id || !otherRole.permissions.includes(permission)));
}

const ClaimedRoleModal: React.FC<Props> = (props) => {
  const { role, communityId, visible, onClose } = props;
  const canvasRef = useRef<HTMLCanvasElement>(null);

  const community = useLiveQuery(() => {
    if (visible) {
      return data.community.getCommunityDetailView(communityId);
    }
    return;
  }, [communityId, visible]);

  const channels = useLiveQuery(() => {
    if (visible) {
      return data.community.getChannels(communityId);
    }
    return;
  }, [communityId, visible]);

  const roles = useLiveQuery(() => {
    if (visible) {
      return data.community.getRoles(communityId);
    }
    return;
  }, [communityId, visible]);

  const ownRoles = useMemo(() => {
    return roles?.filter(role => community?.myRoleIds.includes(role.id));
  }, [community?.myRoleIds, roles]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas) {
      const createdConfetti = confetti.create(canvas, { resize: true });
      createdConfetti({
        spread: 180,
        origin: { y: 0.1 },
        startVelocity: 20,
      });
    }
  }, []);

  const newChannels = useMemo(() => {
    if (channels && ownRoles) return calculateNewChannels(channels, ownRoles, role);
  }, [channels, ownRoles, role]);

  const newPermissions = useMemo(() => {
    if (ownRoles) return calculateNewPermissions(ownRoles, role);
  }, [ownRoles, role]);

  return (<ScreenAwareModal
    customClassname='relative'
    isOpen={visible}
    onClose={onClose}
    hideHeader
  >
    <canvas ref={canvasRef} className='absolute w-full h-full top-0 left-0 cg-border-xxl pointer-events-none' />
    <Button
      className='absolute top-4 right-4 cg-circular'
      role='secondary'
      iconLeft={<XMarkIcon className='w-6 h-6' />}
      onClick={onClose}
    />
    <div className='flex flex-col items-center gap-4'>
      <RolePhoto
        roleId={role.id}
        communityId={role.communityId}
        imageId={role.imageId}
        small
      />
      <span className='cg-heading-2 cg-text-secondary'>You claimed <span className='cg-text-main'>{role.title}</span></span>
      {role.description && <span className='cg-text-lg-400'>{role.description}</span>}
      {newChannels && newPermissions ? <RolePermissionList
        title='You now have access to'
        channels={newChannels}
        permissions={newPermissions}
      /> : <div className='p-4 flex items-center justify-center'>
        <SpinnerIcon className='spinner' />
      </div>}
    </div>
  </ScreenAwareModal>);
}

export default React.memo(ClaimedRoleModal);