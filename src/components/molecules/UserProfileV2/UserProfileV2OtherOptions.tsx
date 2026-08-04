// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { CaretLeft, ChatTeardrop, DotsThreeCircle, Gavel, Link, UserCircleMinus, UserCirclePlus, UserRectangle } from '@phosphor-icons/react';
import { PredefinedRole } from 'common/enums';
import { getUrl } from 'common/util';
import Button from 'components/atoms/Button/Button';
import CheckboxBase from 'components/atoms/CheckboxBase/CheckboxBase';
import ListItem from 'components/atoms/ListItem/ListItem';
import { PopoverHandle } from 'components/atoms/Tooltip/Tooltip';
import { useCommunityModerationContext } from 'context/CommunityModerationContext';
import { useSafeCommunityContext } from 'context/CommunityProvider';
import { useChats } from 'context/OwnDataProvider';
import communityApi from 'data/api/community';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom';
import Dropdown from '../Dropdown/Dropdown';
import { useUserSettingsContext } from 'context/UserSettingsProvider';
import { useCopiedToClipboardContext } from 'context/CopiedToClipboardDialogContext';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import { useWindowSizeContext } from 'context/WindowSizeProvider';

type Props = {
  user: Omit<Models.User.Data, 'isFollowed' | 'isFollower'>;
  isSelf: boolean;
  isFollower: boolean;
  isFollowed: boolean;
  addAccountsDropdownRef: React.RefObject<PopoverHandle | null>;
  toggleFollow: () => void;
  showEditControls?: boolean;
  channelId?: string;
  hoveredMessageId?: string;
  showDeleteMsgButton?: boolean;
  otherSettingsOpen?: boolean;
  lockModal: ((lock: boolean) => void) | undefined;
  enableAdminOptions?: boolean;
};

const UserProfileV2OtherOptions: React.FC<Props> = (props) => {
  const {
    isSelf,
    user,
    showEditControls,
    addAccountsDropdownRef,
    toggleFollow,
    channelId,
    showDeleteMsgButton,
    hoveredMessageId,
    otherSettingsOpen,
    enableAdminOptions
  } = props;
  const navigate = useNavigate();
  const { isMobile } = useWindowSizeContext();
  const { navigateToChatOrCreateNewChat } = useChats();
  const { setIsOpen } = useUserSettingsContext();
  const { warnUser, muteUser, banUser, deleteMessage } = useCommunityModerationContext();
  const commContext = useSafeCommunityContext();
  const { triggerCopiedToClipboardDialog } = useCopiedToClipboardContext();
  const canManageRoles = commContext.state === 'loaded' && commContext.communityPermissions.has('COMMUNITY_MANAGE_ROLES');
  const canModerate = commContext.state === 'loaded' && commContext.communityPermissions.has('COMMUNITY_MODERATE');
  const isInChannel = !!channelId;
  const selfRef = useRef<PopoverHandle>(null);
  const [modifyingAdminRoleId, setModifyingAdminRoleId] = useState<string | null>(null);
  const [isAdminRoleModalAdding, setIsAdminRoleModalAdding] = useState(false);

  const [actionsState, setActionsState] = useState<'default' | 'roles' | 'warn' | 'mute' | 'ban'>('default');

  useEffect(() => {
    if (otherSettingsOpen) selfRef.current?.open();
  }, [otherSettingsOpen]);

  const onDeletePost = useCallback(() => {
    if (hoveredMessageId && channelId) {
      deleteMessage(hoveredMessageId, user.id, channelId);
    }
  }, [channelId, deleteMessage, hoveredMessageId, user.id]);

  const onWarnReasonChange = useCallback((newValue: Common.Content.WarnReason) => {
    if (newValue && channelId) {
      warnUser(newValue, user.id, channelId);
    }
  },[channelId, user, warnUser])

  const onMuteDurationChange = useCallback((newValue: Common.Content.DurationOption) => {
    if (newValue && channelId) {
      muteUser(newValue, user.id, channelId);
    }
  }, [channelId, muteUser, user.id]);

  const onBanDurationChange = useCallback((newValue: Common.Content.DurationOption) => {
    if (newValue) {
      banUser(newValue, user.id, channelId);
    }
  }, [banUser, channelId, user.id]);

  const dropdownActions = useMemo(() => {
    if (actionsState === 'roles') {
      return [
        <ListItem
          className='cg-text-secondary'
          icon={<CaretLeft className='w-4 h-4' />}
          key='Back'
          title='Back'
          onClick={() => setActionsState('default')}
        />,
        <UserProfileRoles
          key='profile-users-id'
          userId={props.user.id}
          onModifyAdminRole={(roleId, isAdding) => {
            setIsAdminRoleModalAdding(isAdding);
            setModifyingAdminRoleId(roleId);
          }}
        />
      ]
    }

    if (actionsState === 'warn') {
      return [
        <ListItem
          className='cg-text-secondary'
          icon={<CaretLeft className='w-4 h-4' />}
          key='Back'
          title='Back'
          onClick={() => setActionsState('default')}
        />,
        <UserProfileWarn key='profile-warn' onWarnReasonChange={onWarnReasonChange} />
      ]
    }

    if (actionsState === 'ban' || actionsState === 'mute') {
      return [
        <ListItem
          className='cg-text-secondary'
          icon={<CaretLeft className='w-4 h-4' />}
          key='Back'
          title='Back'
          onClick={() => setActionsState('default')}
        />,
        <UserProfileMuteBan key='profile-warn' onMuteOrBan={actionsState === 'ban' ? onBanDurationChange : onMuteDurationChange} />
      ]
    }

    const result = [<ListItem
      key='visit'
      title='Visit profile'
      iconRight={<UserRectangle className='w-5 h-5' weight='duotone' />}
      onClick={() => {
        navigate(getUrl({type: 'user', user }));
        setIsOpen(false);
      }}
    />, <ListItem
    key='copy link'
    title='Copy link'
    iconRight={<Link className='w-5 h-5' weight='duotone' />}
    onClick={() => {
      triggerCopiedToClipboardDialog(`${window.location.origin}/${getUrl({type: 'user', user })}`);
      setIsOpen(false);
    }}
  />];

    if (isSelf && showEditControls) {
      result.push(<ListItem
        key='addnewprofile'
        title='Add new profile'
        iconRight={<UserCirclePlus className='w-5 h-5' weight='duotone' />}
        onClick={() => addAccountsDropdownRef.current?.open()}
      />);
    }

    if (!isSelf && !user.isBot) {
      result.push(
        <ListItem
          key='follow'
          title={props.isFollowed ? 'Unfollow' : 'Follow'}
          iconRight={props.isFollowed ? <UserCircleMinus className='w-5 h-5' weight='duotone' /> : <UserCirclePlus className='w-5 h-5' weight='duotone' />}
          onClick={toggleFollow}
        />,
        <ListItem
          key='message'
          title='Message'
          iconRight={<ChatTeardrop className='w-5 h-5' weight='duotone' />}
          onClick={() => navigateToChatOrCreateNewChat(props.user.id)}
          disabled={!props.isFollowed || !props.isFollower}
        />
      );
    }

    if (enableAdminOptions && canManageRoles) {
      result.push(<ListItem
        className='cg-bg-subtle cg-text-warning'
        key='Manage Roles'
        title='Manage Roles'
        iconRight={<Gavel weight='duotone' className='w-5 h-5' />}
        onClick={() => setActionsState('roles')}
      />)
    }

    if (enableAdminOptions && canModerate) {
      if (isInChannel) {
        result.push(<ListItem
          className='cg-bg-subtle cg-text-warning'
          key='Warn'
          title='Warn'
          iconRight={<Gavel weight='duotone' className='w-5 h-5' />}
          onClick={() => setActionsState('warn')}
        />, <ListItem
          className='cg-bg-subtle cg-text-warning'
          key='Mute'
          title='Mute'
          iconRight={<Gavel weight='duotone' className='w-5 h-5' />}
          onClick={() => setActionsState('mute')}
        />)
      }
      result.push(<ListItem
        className='cg-bg-subtle cg-text-warning'
        key='Ban'
        title='Ban'
        iconRight={<Gavel weight='duotone' className='w-5 h-5' />}
        onClick={() => setActionsState('ban')}
      />);
      if (showDeleteMsgButton && isInChannel) {
        result.push(<ListItem
          className='cg-bg-subtle cg-text-warning'
          key='Delete Message'
          title='Delete Message'
          iconRight={<Gavel weight='duotone' className='w-5 h-5' />}
          onClick={onDeletePost}
        />);
      }
    }

    return result;
  }, [actionsState, addAccountsDropdownRef, canManageRoles, canModerate, enableAdminOptions, isInChannel, isSelf, navigate, navigateToChatOrCreateNewChat, onBanDurationChange, onDeletePost, onMuteDurationChange, onWarnReasonChange, props.isFollowed, props.isFollower, props.user.id, setIsOpen, showDeleteMsgButton, showEditControls, toggleFollow, triggerCopiedToClipboardDialog, user]);

  return (<>
    <ScreenAwareModal
      hideHeader
      isOpen={modifyingAdminRoleId !== null}
      onClose={() => setModifyingAdminRoleId(null)}
    >
      <div className={`flex flex-col gap-4${isMobile ? ' pt-4 px-4 pb-8' : ''}`}>
        <div className='flex flex-col gap-2'>
          <h3>{isAdminRoleModalAdding ? 'Give Admin role to this user?' : 'Remove Admin role from this user?'}</h3>
          <p>{isAdminRoleModalAdding ? 'Giving Admin to this user will grant them full control of the community. Are you sure?' : `Are you sure you want to remove the Admin role from ${isSelf ? 'yourself? This change can only be undone by another Admin' : 'this user?'}`}</p>
        </div>
        <div className='flex justify-end gap-2'>
          <Button
            role='borderless'
            text={'Cancel'}
            onClick={() => setModifyingAdminRoleId(null)}
          />
          <Button
            role='primary'
            text={'Confirm'}
            onClick={async () => {
              if (isAdminRoleModalAdding) {
                await communityApi.addUserToRoles({
                  userId: user.id,
                  communityId: commContext.state === 'loaded' ? commContext.community.id : '',
                  roleIds: [modifyingAdminRoleId || '']
                })
              } else {
                await communityApi.removeUserFromRoles({
                  userId: user.id,
                  communityId: commContext.state === 'loaded' ? commContext.community.id : '',
                  roleIds: [modifyingAdminRoleId || '']
                })
              }
              setModifyingAdminRoleId(null);
            }}
          />
        </div>
      </div>
    </ScreenAwareModal>
    <Dropdown
      onOpen={() => props.lockModal?.(true)}
      onClose={() => props.lockModal?.(false)}
      ref={selfRef}
      closeOnToggleOrLeave
      placement='bottom-end'
      domChildOfTrigger={false}
      triggerContent={<Button
        role='chip'
        iconLeft={<DotsThreeCircle weight='duotone' className='w-5 h-5' />}
        className='cg-circular h-9 w-9'
      />}
      items={dropdownActions}
    />
  </>);
}

const UserProfileRoles: React.FC<{
  userId: string;
  onModifyAdminRole: (roleId: string, isAdding: boolean) => void;
}> = ({ userId, onModifyAdminRole }) => {
  const [userRoleIds, setUserRoleIds] = React.useState<string[]>([]);
  const commContext = useSafeCommunityContext();

  useEffect(() => {
    if (commContext.state !== 'loaded') return;
    communityApi.getUserCommunityRoleIds({
      userId: userId,
      communityId: commContext.community.id
    }).then(res => {
      setUserRoleIds(res);
    }).catch(err => {
      setUserRoleIds([]);
      console.log(err);
    });
  }, [commContext, userId]);

  if (commContext.state !== 'loaded') return null;

  return <>
    {commContext.roles.map(role => {
      const hasRole = userRoleIds.includes(role.id) || false;
      const canModify = !role.assignmentRules && role.title !== PredefinedRole.Public && role.title !== PredefinedRole.Member;

      return <ListItem
        key={role.id}
        title={role.title}
        onClick={async () => {
          if (canModify) {
            if (role.title === PredefinedRole.Admin) {
              onModifyAdminRole(role.id, !hasRole);
              return;
            }


            if (hasRole) {
              await communityApi.removeUserFromRoles({
                userId: userId,
                communityId: commContext.community.id,
                roleIds: [role.id]
              }).then(() => {
                setUserRoleIds(userRoleIds.filter(id => id !== role.id));
              });
            } else {
              await communityApi.addUserToRoles({
                userId: userId,
                communityId: commContext.community.id,
                roleIds: [role.id]
              }).then(() => {
                setUserRoleIds([...userRoleIds, role.id]);
              });
            }
          }
        }}
        iconRight={canModify ? <CheckboxBase type='checkbox' checked={userRoleIds?.includes(role.id) || false} size='small' /> : undefined}
      />
    })}
  </>
}

const warnTypes: Common.Content.WarnReason[] = [
  "Behavior",
  "Off-topic",
  "Language",
  "Spam",
  "Breaking rules"
];

const UserProfileWarn: React.FC<{ onWarnReasonChange?: (reason: Common.Content.WarnReason) => void }> = ({ onWarnReasonChange }) => {
  return (<>
    {warnTypes.map(warn =>
      <ListItem
        key={warn}
        title={warn}
        onClick={() => onWarnReasonChange?.(warn)}
      />
    )}
  </>);
}

const durations: Common.Content.DurationOption[] = [
  '15m',
  '1h',
  '1d',
  '1w',
  'permanently'
];

function durationToText(duration: Common.Content.DurationOption) {
  switch (duration) {
    case '15m': return '15 minutes';
    case '1h': return '1 hour';
    case '1d': return '1 day';
    case '1w': return '1 week';
    case 'permanently': return 'Permanently';
  }
}

const UserProfileMuteBan: React.FC<{
  onMuteOrBan?: (duration: Common.Content.DurationOption) => void;
}> = ({ onMuteOrBan }) => {
  return (
    <>
      {durations.map(duration =>
        <ListItem
          key={duration}
          title={durationToText(duration)}
          onClick={() => onMuteOrBan?.(duration)}
        />
      )}
    </>
  );
}


export default React.memo(UserProfileV2OtherOptions);
