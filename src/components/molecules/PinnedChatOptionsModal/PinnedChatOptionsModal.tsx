// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo, useState } from 'react'
import './PinnedChatOptionsModal.css';
import BookmarkAddIcon from '../../atoms/icons/20/BookmarkAdd.svg?react';
import { ArrowUpRightIcon, BellAlertIcon } from '@heroicons/react/20/solid';
import data from 'data';
import Button from 'components/atoms/Button/Button';
import { channelPermissionsToPermissionType } from 'components/templates/CommunityLobby/ChannelManagement/EditChannelForm';
import RolePermissionUnit from 'components/atoms/RolePermissionUnit/RolePermissionUnit';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import { PredefinedRole } from 'common/enums';
import AnimatedContainerVertical from 'components/atoms/AnimatedContainerVertical/AnimatedContainerVertical';
import AnimatedTabPage from 'components/atoms/AnimatedTabPage/AnimatedTabPage';
import AnimatedTabPageContainer from 'components/atoms/AnimatedTabPage/AnimatedTabPageContainer';
import { PermissionType } from '../RolePermissionToggle/RolePermissionToggle';
import UserSettingsButton from '../UserSettingsButton/UserSettingsButton';
import CheckboxBase from 'components/atoms/CheckboxBase/CheckboxBase';

type Props = {
  channel: Models.Community.Channel;
  goToAdminPanel: () => void;
}

const screenOrder = {
  general: 1,
  permissions: 2
};

const PinnedChatOptionsModal: React.FC<Props> = (props) => {
  const { channel, goToAdminPanel } = props;

  const [selectedTab, setSelectedTab] = useState<'general' | 'permissions'>('general');
  const [pinType, _setPinType] = useState(channel.pinType || 'autopin');
  const [notifyType, _setNotifyType] = useState<Models.Community.ChannelNotifyType>(channel.notifyType || 'while_pinned');
  const { ownRoles } = useLoadedCommunityContext();
  const channelPermissions = useMemo(() => channelPermissionsToPermissionType(channel.rolePermissions), [channel.rolePermissions]);
  const isAdmin = !!ownRoles.find(role => role.title === PredefinedRole.Admin);

  const setPinType = useCallback(async (value: Models.Community.ChannelPinType) => {
    data.community.setChannelPinState({
      channelId: channel.channelId,
      communityId: channel.communityId,
      pinType: value,
    }).then(() => {
      _setPinType(value);
    });
  }, [channel.channelId, channel.communityId]);

  const setNotifyType = useCallback(async (value: Models.Community.ChannelNotifyType) => {
    data.community.setChannelPinState({
      channelId: channel.channelId,
      communityId: channel.communityId,
      notifyType: value,
    }).then(() => {
      _setNotifyType(value);
    });
  }, [channel.channelId, channel.communityId]);

  const renderPinOptions = () => (<>
    <div className='flex flex-col self-stretch'>
      <div className='flex items-center gap-2 h-12 cg-text-main'>
        <BookmarkAddIcon className='w-5 h-5' />
        <span className='cg-text-lg-500'>Pin Chat</span>
      </div>
      <div className='flex flex-col gap-1.5 items-center self-stretch pl-6'>
        <UserSettingsButton
          text='Automatically when writing a message for 24h'
          className='w-full'
          active={pinType === 'autopin'}
          onClick={() => setPinType('autopin')}
          rightElement={<CheckboxBase size='normal' type='radio' checked={pinType === 'autopin'} />}
        />
        <UserSettingsButton
          text='Always'
          className='w-full'
          active={pinType === 'permapin'}
          onClick={() => setPinType('permapin')}
          rightElement={<CheckboxBase size='normal' type='radio' checked={pinType === 'permapin'} />}
        />
        <UserSettingsButton
          text='Never'
          className='w-full'
          active={pinType === 'never'}
          onClick={() => setPinType('never')}
          rightElement={<CheckboxBase size='normal' type='radio' checked={pinType === 'never'} />}
        />
      </div>
    </div>
    <div className='flex flex-col self-stretch'>
      <div className='flex items-center gap-2 h-12 cg-text-main'>
        <BellAlertIcon className='w-5 h-5' />
        <span className='cg-text-lg-500'>Get push notifications</span>
      </div>
      <div className='flex flex-col gap-1.5 items-center self-stretch pl-6'>
        <UserSettingsButton
          text='While Pinned'
          className='w-full'
          active={notifyType === 'while_pinned'}
          onClick={() => setNotifyType('while_pinned')}
          rightElement={<CheckboxBase size='normal' type='radio' checked={notifyType === 'while_pinned'} />}
        />
        <UserSettingsButton
          text='Always'
          className='w-full'
          active={notifyType === 'always'}
          onClick={() => setNotifyType('always')}
          rightElement={<CheckboxBase size='normal' type='radio' checked={notifyType === 'always'} />}
        />
        <UserSettingsButton
          text='Never'
          className='w-full'
          active={notifyType === 'never'}
          onClick={() => setNotifyType('never')}
          rightElement={<CheckboxBase size='normal' type='radio' checked={notifyType === 'never'} />}
        />
      </div>
    </div>
  </>);

  return (<div className='pinned-chat-options-modal'>
    <div className='flex p-1 self-stretch'>
      <span className='flex py-2 cg-text-main cg-heading-3'>Chat Settings</span>
    </div>
    <div className='flex gap-2 self-start'>
      <Button
        role='chip'
        text='General'
        className={selectedTab === 'general' ? 'active' : ''}
        onClick={() => setSelectedTab('general')}
      />
      <Button
        role='chip'
        text={<div className='flex gap-1'>
          <span>Access</span>
          <span className={selectedTab === 'permissions' ? 'cg-text-main' : 'cg-text-secondary'}>{Object.keys(channelPermissions).length}</span>
        </div>}
        className={selectedTab === 'permissions' ? 'active' : ''}
        onClick={() => setSelectedTab('permissions')}
      />
    </div>
    <AnimatedContainerVertical>
      <AnimatedTabPageContainer currentScreen={selectedTab} screenOrder={screenOrder}>
        <AnimatedTabPage visible={selectedTab === 'general'} className='flex flex-col gap-4 w-full'>
          {renderPinOptions()}
        </AnimatedTabPage>
        <AnimatedTabPage visible={selectedTab === 'permissions'} className='flex flex-col gap-4 w-full'>
          <OptionsPermissionView
            isAdmin={isAdmin}
            permissions={channelPermissions}
            goToAdminPanel={goToAdminPanel}
          />
        </AnimatedTabPage>
      </AnimatedTabPageContainer>
    </AnimatedContainerVertical>
  </div>);
}

type OptionsPermissionViewProps = {
  permissions: Record<string, PermissionType>;
  isAdmin?: boolean;
  goToAdminPanel?: () => void;
};

export const OptionsPermissionView: React.FC<OptionsPermissionViewProps> = (props) => {
  const { roles } = useLoadedCommunityContext();
  const { permissions, isAdmin, goToAdminPanel } = props;

  const publicRole = roles.find(role => role.title === PredefinedRole.Public);
  const memberRole = roles.find(role => role.title === PredefinedRole.Member);
  const filteredRoles = roles.filter(role => ![PredefinedRole.Public, PredefinedRole.Member, PredefinedRole.Admin].includes(role.title as any));

  return <>
    <div className='flex flex-col w-full'>
      {publicRole && permissions[publicRole.id] && <div className='flex items-center justify-between gap-5 py-1'>
        <span className='cg-text-lg-500 cg-text-main'>Guests</span>
        <RolePermissionUnit permissionType={permissions[publicRole.id]} />
      </div>}
      {memberRole && permissions[memberRole.id] && <div className='flex items-center justify-between gap-5 py-1'>
        <span className='cg-text-lg-500 cg-text-main'>Members</span>
        <RolePermissionUnit permissionType={permissions[memberRole.id]} />
      </div>}

      {Object.keys(permissions).map(roleId => {
        const role = filteredRoles.find(role => role.id === roleId);
        if (!role) return null;

        let title = role.title;
        if (title === PredefinedRole.Public) title = 'Guests';
        else if (title === PredefinedRole.Member) title = 'Members';

        return <div className='flex items-center justify-between gap-5 py-1' key={roleId}>
          <span className='cg-text-lg-500 cg-text-main'>{role?.title}</span>
          <RolePermissionUnit permissionType={permissions[roleId]} />
        </div>;
      })}
    </div>
    {isAdmin && <Button
      onClick={goToAdminPanel}
      className='w-full'
      role='secondary'
      text='Admin Panel'
      iconRight={<ArrowUpRightIcon className='w-5 h-5' />}
    />}
  </>
}


export default PinnedChatOptionsModal;