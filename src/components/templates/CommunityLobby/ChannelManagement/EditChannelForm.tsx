// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback, useMemo, useState } from "react";
import data from "data";

import Button from "components/atoms/Button/Button";
import Modal from "components/atoms/Modal/Modal";
import TextAreaField from "components/molecules/inputs/TextAreaField/TextAreaField";
import TextInputField from "components/molecules/inputs/TextInputField/TextInputField";
import CloseIcon from 'components/atoms/icons/16/Close-1.svg?react';
import RolePermissionToggle, { PermissionType } from "components/molecules/RolePermissionToggle/RolePermissionToggle";

import { useLoadedCommunityContext } from "context/CommunityProvider";
import { PredefinedRole } from "common/enums";
import { rolePermissionPresets } from "common/presets";
import { useNavigationContext } from "components/SuspenseRouter/SuspenseRouter";
import { useSnackbarContext } from "context/SnackbarContext";
import FloatingSaveOptions from "../FloatingSaveOptions/FloatingSaveOptions";
import errors from "common/errors";

type Props = {
  communityId: string;
  areaId: string | undefined;
  channel: Models.Community.Channel | undefined;
  onFinish: (close?: boolean) => void;
  nextOrder: number;
}

export function toPermissionType(permissions: Common.ChannelPermission[]): PermissionType {
  if (permissions.includes('CHANNEL_MODERATE')) return 'moderate';
  else if (permissions.includes('CHANNEL_WRITE')) return 'full';
  else if (permissions.includes('CHANNEL_READ')) return 'read';
  else if (permissions.includes('CHANNEL_EXISTS')) return 'preview';
  else return 'none';
}

export function channelPermissionsToPermissionType(channelPermissions: Models.Community.CommunityChannelPermission[]): Record<string, PermissionType> {
  return channelPermissions.reduce((acc, permission) => {
    // Don't convert admin, we won't modify it and won't send it either
    if (permission.roleTitle === PredefinedRole.Admin) return acc;

    return {
      ...acc,
      [permission.roleId]: toPermissionType(permission.permissions)
    }
  }, {});
}

function permissionTypeToChannelPermissions(
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

function channelHasCustomPermissions(channelPermissions: Models.Community.CommunityChannelPermission[]) {
  for (const key of Object.keys(rolePermissionPresets.Channel) as (keyof typeof rolePermissionPresets["Channel"])[]) {
    const preset = new Set(rolePermissionPresets.Channel[key]) as Set<Common.ChannelPermission>;
    const p = channelPermissions.find(cp => cp.roleTitle === key);
    if (!!p) {
      if (preset.size !== p.permissions.length || p.permissions.some(perm => !preset.has(perm))) {
        return true;
      }
    }
    else if (key === "Admin") {
      console.error("Channel does not have permissions for Admin, this is a bug", channelPermissions);
    }
    else if (key === "Member" || key === "Public") {
      return true;
    }
  }
  return false;
}

const emptyChannel: Models.Community.Channel = Object.freeze({
  communityId: '',
  channelId: '',
  areaId: null,
  title: '',
  url: null,
  order: 0,
  description: '',
  emoji: '💬',
  updatedAt: '',
  rolePermissions: [],
  lastRead: new Date().toISOString(),
  lastMessageDate: null,
  unread: 0,
  pinType: null,
  notifyType: null,
  pinnedMessageIds: null,
  pinnedUntil: null,
});

export default function EditChannelForm(props: Props) {
  const { channel, onFinish, communityId, areaId, nextOrder } = props;
  const isEditing = !!channel;
  const { roles, channels } = useLoadedCommunityContext();
  const { showSnackbar } = useSnackbarContext();
  const { isDirty, setDirty } = useNavigationContext();

  const defaultPermission = useMemo(() => {
    return [
      {
        roleId: roles.find(role => role.title === PredefinedRole.Public)?.id,
        roleTitle: PredefinedRole.Public,
        permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ']
      },
      {
        roleId: roles.find(role => role.title === PredefinedRole.Member)?.id,
        roleTitle: PredefinedRole.Member,
        permissions: ['CHANNEL_EXISTS', 'CHANNEL_READ', 'CHANNEL_WRITE']
      },
    ] as Models.Community.CommunityChannelPermission[];
  }, [roles]);

  const [currentChannel, setCurrentChannel] = useState<Models.Community.Channel>(channel || emptyChannel);
  const [showDeleteConfirmation, setShowDeleteConfirmation] = useState<boolean>(false);
  const [rolesPermissions, setRolesPermissions] = useState<Record<string, PermissionType>>(
    isEditing ? channelPermissionsToPermissionType(channel.rolePermissions) : channelPermissionsToPermissionType(defaultPermission)
  );
  const setCurrentChannelWDirty: React.Dispatch<React.SetStateAction<Models.Community.Channel>> = useCallback(action => {
    setCurrentChannel(action);
    setDirty(true);
  }, [setDirty]);

  const setRolesPermissionsWDirty: React.Dispatch<React.SetStateAction<Record<string, PermissionType>>> = useCallback(action => {
    setRolesPermissions(action);
    setDirty(true);
  }, [setDirty]);

  const handleSaveChannel = useCallback(async () => {
    if (!isDirty) {
      onFinish();
    } if (isEditing) {
      try {
        await data.community.updateChannel(currentChannel.communityId, currentChannel.channelId, {
          title: currentChannel.title,
          description: currentChannel.description,
          emoji: currentChannel.emoji || '💬',
          rolePermissions: permissionTypeToChannelPermissions(roles, rolesPermissions, defaultPermission),
          url: currentChannel.url || null,
        });
        showSnackbar({ type: 'info', text: 'Channel updated' });
        onFinish();
      } catch (err) {
        if (err instanceof Error && err.message === errors.server.DUPLICATE_KEY) {
          const existingChannel = channels.find(ch => ch.url === currentChannel.url);
          showSnackbar({ type: 'warning', text: 'Channel url already exists' + (existingChannel ? ` on channel "${existingChannel.title}"` : '') });
        } else {
          console.error(err);
        }
      }
    } else if (areaId) {
      try {
        await data.community.createChannel({
          title: currentChannel.title,
          description: currentChannel.description,
          emoji: currentChannel.emoji,
          communityId: communityId,
          areaId: areaId,
          url: currentChannel.url || null,
          order: nextOrder,
          rolePermissions: permissionTypeToChannelPermissions(roles, rolesPermissions, defaultPermission),
        });
        showSnackbar({ type: 'info', text: 'Channel created' });
        onFinish();
      } catch (err) {
        console.error(err);
      }
    }
  }, [areaId, communityId, currentChannel.channelId, currentChannel.communityId, currentChannel.description, currentChannel.emoji, currentChannel.title, currentChannel.url, defaultPermission, isDirty, isEditing, nextOrder, onFinish, roles, rolesPermissions, showSnackbar]);

  const handleDeleteChannel = useCallback(async () => {
    if (isEditing) {
      try {
        await data.community.deleteChannel(currentChannel.communityId, currentChannel.channelId);
        showSnackbar({ type: 'info', text: 'Channel deleted' });
        setShowDeleteConfirmation(false);
        onFinish(true);
      } catch (err) {
        console.error(err);
      }
    }
  }, [currentChannel.channelId, currentChannel.communityId, isEditing, onFinish, showSnackbar]);

  return (
    <>
      <div className={"flex flex-col gap-8" + (isDirty ? ' pb-20' : '')}>
        <div className="flex flex-col gap-4">
          <span className='section-title'>General</span>
          <div className="form-container cg-content-stack">
            <TextInputField
              label="Channel name"
              showEmojiButton={true}
              currentEmoji={currentChannel.emoji || '💬'}
              onEmojiPicked={(emoji) => setCurrentChannelWDirty(oldChannel => ({ ...oldChannel, emoji }))}
              value={currentChannel.title}
              onChange={(title) => setCurrentChannelWDirty(oldChannel => ({ ...oldChannel, title }))}
              placeholder="What should the channel be called?"
            />
            <TextInputField
              label="Channel url"
              value={currentChannel.url || ''}
              onChange={(url) => setCurrentChannelWDirty(oldChannel => ({ ...oldChannel, url }))}
              placeholder="Navigation URL for this channel"
            />
            <TextAreaField
              label="Channel description"
              value={currentChannel.description || ''}
              onChange={(description) => setCurrentChannelWDirty(oldChannel => ({ ...oldChannel, description }))}
              placeholder="What is this channel about?"
            />
          </div>
        </div>
        <div className='flex flex-col gap-4' >
          <span className='section-title'>Permissions</span>
          <div className='form-container cg-content-stack'>
            <RolePermissionToggle
              title="Set permissions for this channel"
              availablePermissions={['none', 'preview', 'read', 'full', 'moderate']}
              roles={roles}
              rolesPermissions={rolesPermissions}
              setRolesPermissions={setRolesPermissionsWDirty}
            />
          </div>
        </div>
        {isEditing && <Button
          className='w-full'
          role='destructive'
          text="Delete channel"
          onClick={() => setShowDeleteConfirmation(true)}
        />}
        {isDirty && <FloatingSaveOptions onSave={handleSaveChannel} />}
      </div>
      {showDeleteConfirmation && isEditing && (
        <Modal
          headerText={`Delete ${currentChannel.title}`}
          close={() => setShowDeleteConfirmation(false)}
        >
          <div className="modal-inner">
            <p>Are you sure you want to delete {currentChannel.title}?</p>
            <div className="btnList justify-end align-center mt-6">
              <Button
                onClick={() => setShowDeleteConfirmation(false)}
                text="Cancel"
                role="secondary"
              />
              <Button
                onClick={handleDeleteChannel}
                iconLeft={<CloseIcon />}
                text="Delete channel"
                role="destructive"
              />
            </div>
          </div>
        </Modal>
      )}
    </>
  )
}