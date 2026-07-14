// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ReactComponent as ChatIcon } from '../../../components/atoms/icons/16/Chat.svg';
import Modal from '../../atoms/Modal/Modal';
import { useWindowSizeContext } from '../../../context/WindowSizeProvider';
import { createSearchParams, useLocation, useNavigate, useSearchParams } from 'react-router-dom';
import MemberListPreview from '../../../components/molecules/MemberListPreview/MemberListPreview';
import TextChannelNotificationHeader from './TextChannelNotificationHeader';

import './TextChannel.css';
import MessageViewInner from 'views/MessageViewInner/MessageViewInner';
import BookmarkButton from 'components/atoms/BookmarkButton/BookmarkButton';
import { useSnackbarContext } from 'context/SnackbarContext';
import ScreenAwarePopover from 'components/atoms/ScreenAwarePopover/ScreenAwarePopover';
import { ChevronDownIcon } from '@heroicons/react/20/solid';
import { BellAlertIcon as BellAlertIconOutline } from '@heroicons/react/24/outline';
import { BellAlertIcon as BellAlertIconSolid } from '@heroicons/react/24/solid';
import PinnedChatOptionsModal from 'components/molecules/PinnedChatOptionsModal/PinnedChatOptionsModal';
import data from 'data';
import { PopoverHandle } from 'components/atoms/Tooltip/Tooltip';
import { getUrl } from 'common/util';
import { useLoadedCommunityContext, useSafeCommunityContext } from 'context/CommunityProvider';
import { PredefinedRole } from 'common/enums';
import { JOINCOMMUNITY_MUTED_MESSAGE } from 'components/molecules/GenericMessageList/GenericMessageList';
import communityApi from 'data/api/community';
import { calculateChannelPermissions } from '../ChannelList/ChannelList';
import GatedDialogModal from '../GatedDialogModal/GatedDialogModal';
import { PushPin } from '@phosphor-icons/react';
import { useUserData } from 'context/UserDataProvider';
import { convertContentToPlainText } from 'common/converters';
import Jdenticon from 'components/atoms/Jdenticon/Jdenticon';
import { getDisplayName } from '../../../util';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import Button from 'components/atoms/Button/Button';
import BotBadge from 'components/atoms/BotBadge/BotBadge';

type Props = {
  community: Models.Community.DetailView;
  channel: Models.Community.Channel;
  area?: Models.Community.Area;
  memberListIsExpanded: boolean;
  onMemberListToggle: () => void;
  messageIdFocus?: string;
  showNotificationHeader?: boolean;
}

export default function TextChannel(props: Props) {
  const [searchParams] = useSearchParams();
  const { community, channel, area, memberListIsExpanded, onMemberListToggle, messageIdFocus } = props;
  const [muted, setMuted] = useState<string | undefined>();
  const gatedState = useMemo(() => calculateChannelPermissions(community, channel), [community, channel]);
  const [showGatedDialog, setShowGatedDialog] = useState(!!gatedState);

  const canWrite = useMemo(() => {
    if (!channel) return false;
    return channel.rolePermissions.some(rolePermission => rolePermission.permissions.includes('CHANNEL_WRITE') && community.myRoleIds.includes(rolePermission.roleId));
  }, [channel, community.myRoleIds]);

  const membersCanWrite = useMemo(() => {
    if (!channel) return false;
    const memberPermission = channel.rolePermissions.find(permission => permission.roleTitle === PredefinedRole.Member);
    return memberPermission?.permissions.includes('CHANNEL_WRITE');
  }, [channel]);

  useEffect(() => {
    if (!canWrite) {
      if (membersCanWrite) {
        setMuted(JOINCOMMUNITY_MUTED_MESSAGE);
      } else {
        setMuted('You do not have the required roles or permissions to write here.');
      }
    } else {
      setMuted(undefined);
    }

    let interval: any;
    const { blockState } = community;
    if (blockState && blockState.state === "CHAT_MUTED") {
      if (blockState.until !== null) {
        const until = (new Date(blockState.until)).getTime();
        if (until > Date.now()) {
          const getHowLong = () => {
            const now = Date.now();
            const d = Math.floor((until - now) / 86400000);
            const h = Math.floor(((until - now) % 86400000) / 3600000);
            const m = Math.floor(((until - now) % 3600000) / 60000);
            const s = Math.floor(((until - now) % 60000) / 1000);
            return `${d > 0 ? `${d}d ` : ''}${h > 0 ? `${h}h ` : ''}${m > 0 ? `${m}m` : ''}${m > 0 || h > 0 || d > 0 ? '' : `${s}s`}`;
          }
          setMuted(`You are muted for another ${getHowLong()} and cannot chat`);
          interval = setInterval(() => {
            if (until > Date.now()) {
              setMuted(`You are muted for another ${getHowLong()} and cannot chat`);
            } else {
              setMuted(undefined);
              clearInterval(interval);
            }
          }, 1000);
        }
      } else {
        setMuted("You are permanently muted");
      }
    }

    return () => clearInterval(interval);
  }, [canWrite, community, membersCanWrite]);

  const finalMessageIdFocus = messageIdFocus || searchParams.get('messageId') || undefined;

  return (
    <div className="content-message-list">
      <GatedDialogModal
        isOpen={!!gatedState && showGatedDialog}
        requiredPermissions={gatedState}
        onClose={() => setShowGatedDialog(false)}
      />
      {channel && <TextChannelInner
        key={channel.channelId}
        community={community}
        channel={channel}
        areaName={area?.title || ''}
        memberListIsExpanded={memberListIsExpanded}
        onMemberCountClick={onMemberListToggle}
        writingForbiddenMessage={muted}
        messageIdFocus={finalMessageIdFocus}
        showNotificationHeader={props.showNotificationHeader}
      />
      }
    </div>
  );
}

function TextChannelInner(props: {
  community: Models.Community.DetailView,
  channel: Models.Community.Channel,
  areaName: string | undefined,
  memberListIsExpanded: boolean,
  onMemberCountClick: () => void,
  writingForbiddenMessage?: string,
  messageIdFocus?: string,
  showNotificationHeader?: boolean
}) {
  const {
    community,
    channel,
    areaName,
    memberListIsExpanded,
    onMemberCountClick,
    writingForbiddenMessage,
    messageIdFocus
  } = props;

  const header = useMemo(() => {
    if (channel.title) {
      if (props.showNotificationHeader) {
        return <TextChannelNotificationHeader
          community={community} areaName={areaName || ''} textChannelName={channel.title} textChannelId={channel.channelId} messageId={messageIdFocus || ''}
        />;
      } else {
        return <TextChannelHeader
          channel={channel}
          areaName={areaName}
          memberListIsExpanded={memberListIsExpanded}
          onMemberCountClick={onMemberCountClick}
        />;
      }
    }
    return null;
  }, [areaName, channel, community, memberListIsExpanded, messageIdFocus, onMemberCountClick, props.showNotificationHeader])

  return (
    <div className="text-channel">
      <div className='text-channel-header-container'>
        {header}
      </div>
      <MessageViewInner
        channelId={channel.channelId}
        communityId={channel.communityId}
        updateAutoPin={(channel.pinType === 'autopin' || channel.pinType === null)}
        channelName={channel.title}
        messageIdFocus={messageIdFocus}
        writingForbiddenMessage={writingForbiddenMessage}
      />
    </div>
  );
}

function TextChannelHeader(props: {
  channel: Models.Community.Channel;
  areaName?: string;
  memberListIsExpanded: boolean;
  onMemberCountClick: () => void;
}) {
  const navigate = useNavigate();
  const location = useLocation();
  const { isMobile } = useWindowSizeContext();
  const { community } = useLoadedCommunityContext();
  const { channel, areaName, memberListIsExpanded, onMemberCountClick } = props;
  const { showSnackbar } = useSnackbarContext();
  const [showModalDescription, setShowModalDescription] = useState<boolean>(false);
  const popoverHandle = useRef<PopoverHandle>(null);
  const [memberList, setMemberList] = React.useState<Models.Community.ChannelMemberList>();
  const intervalRef = React.useRef<any>(undefined);

  const updateMemberList = useCallback(async () => {
    if (!channel || !community) return;
    communityApi.getChannelMemberList({
      channelId: channel.channelId,
      communityId: community.id,
      offset: 0,
      limit: 3,
    }).then(res => {
      setMemberList(res);
    }).catch(err => {
      setMemberList(undefined);
      console.log(err);
    });
  }, [community.id, channel.channelId]);

  useEffect(() => {
    if (intervalRef.current !== undefined) {
      clearInterval(intervalRef.current);
    }
    updateMemberList();
    intervalRef.current = setInterval(updateMemberList, 5000);
    return () => {
      if (intervalRef.current !== undefined) {
        clearInterval(intervalRef.current);
      }
    }
  }, [updateMemberList]);

  const channelIsPinned = (
    channel.pinType === 'permapin' ||
    (
      channel.pinType === 'autopin' &&
      !!channel.pinnedUntil &&
      new Date(channel.pinnedUntil) >= new Date()
    )
  );

  const togglePinnedChannel = useCallback(() => {
    if (
      channel.pinType === null ||
      channel.pinType === 'never' ||
      (
        channel.pinType === 'autopin' &&
        (
          channel.pinnedUntil === null ||
          new Date(channel.pinnedUntil) < new Date()
        )
      )
    ) {
      if (channel.notifyType === null) {
        data.community.setChannelPinState({
          channelId: channel.channelId,
          communityId: channel.communityId,
          pinType: 'permapin',
          pinnedUntil: null,
          notifyType: 'while_pinned',
        });
      }
      else {
        data.community.setChannelPinState({
          channelId: channel.channelId,
          communityId: channel.communityId,
          pinType: 'permapin',
          pinnedUntil: null,
        });
      }
      showSnackbar({ type: 'info', text: 'Channel permanently pinned', durationSeconds: 2 });
    }
    else {
      data.community.setChannelPinState({
        channelId: channel.channelId,
        communityId: channel.communityId,
        pinType: 'autopin',
        pinnedUntil: null,
      });
      showSnackbar({ type: 'info', text: 'Channel unpinned', durationSeconds: 2 });
    }
  }, [showSnackbar, channel]);

  const goToAdminPanel = useCallback(() => {
    if (!isMobile) {
      navigate({
        pathname: location.pathname,
        search: createSearchParams({
          modal: 'areas-channels',
          channel: channel.channelId
        }).toString()
      });
    } else {
      navigate({
        pathname: getUrl({
          type: 'community-settings-areas-and-channels',
          community
        }),
        search: createSearchParams({
          channel: channel.channelId
        }).toString()
      });
    }
    popoverHandle.current?.close();
  }, [channel.channelId, community.url, isMobile, location.pathname, navigate]);

  return (
    <div className='flex flex-col gap-2'>
      <div className="text-channel-header">
        <div className='flex flex-row w-full'>
          <div className='flex items-center gap-2 overflow-hidden flex-1'>
            <BookmarkButton
              active={channelIsPinned}
              onClick={togglePinnedChannel}
              icon={channelIsPinned ? <BellAlertIconSolid className='w-5 h-5' /> : <BellAlertIconOutline className='w-5 h-5' />}
            />
            <ScreenAwarePopover
              ref={popoverHandle}
              triggerType='click'
              closeOn='toggle'
              triggerClassName='text-channel-name'
              triggerContent={<>
                <ChatIcon fill='#F9F9F9' />
                <span className='overflow-hidden text-ellipsis'>{channel.title}</span>
                <ChevronDownIcon className='w-5 h-5' />
              </>}
              tooltipContent={<PinnedChatOptionsModal
                channel={channel}
                goToAdminPanel={goToAdminPanel}
              />}
              placement='bottom-start'
              tooltipClassName='p-0'
              closeDelay={500}
              offset={8}
            />
            {!isMobile && <div className="flex overflow-hidden" onClick={() => setShowModalDescription(true)}>
              <span className='cg-text-md-500 cg-text-secondary whitespace-nowrap text-ellipsis overflow-hidden'>{channel.description || ''}</span>
            </div>}
          </div>
          <div className='ml-auto flex gap-2'>
            <MemberListPreview
              memberList={memberList}
              onClick={onMemberCountClick}
              isExpanded={memberListIsExpanded}
            />
          </div>
        </div>
        {channel.pinnedMessageIds?.map(pinnedMessageId => <PinnedMessage key={pinnedMessageId} channelId={channel.channelId} messageId={pinnedMessageId} />)}
      </div>
      {showModalDescription && <Modal headerText={channel.title} close={() => setShowModalDescription(false)}>
        <div className="channel-modal-description">
          {!!areaName && <div className="channel-area">{`Part of ${areaName}`}</div>}
          <div className="channel-description break-all">{channel.description || ''}</div>
        </div>
      </Modal>}
    </div>
  );
}

const PinnedMessage: React.FC<{
  channelId: string;
  messageId: string;
}> = ({ channelId, messageId }) => {
  const [message, setMessage] = useState<Models.Message.Message | null | undefined>(null); // Undefined => Not found
  const commContext = useSafeCommunityContext();
  const { showSnackbar } = useSnackbarContext();
  const [, setSearchParams] = useSearchParams();
  const [unpinModalOpen, setUnpinModalOpen] = useState(false);
  const { isMobile } = useWindowSizeContext();
  const creator = useUserData(message?.creatorId);

  useEffect(() => {
    const resultPromise = data.channelManager.getMessageById(channelId, messageId, (updatedMessage) => {
      setMessage(updatedMessage);
    }).then(result => {
      setMessage(result.item);
      return result;
    });

    return () => {
      resultPromise.then(result => result.unsubscribe());
    };
  }, [channelId, messageId]);

  const onUnpin = async (ev: React.MouseEvent) => {
    ev.stopPropagation();
    // FIXME: Only pins for community channel, doesn't work for chats or calls right now
    if (commContext.state === 'loaded') {
      const { community, channelsById } = commContext;
      const channel = channelsById.get(channelId);
      if (!channel) return;

      try {
        await data.community.updateChannel(community.id, channelId, {
          pinnedMessageIds: (channel.pinnedMessageIds || []).filter(mId => mId !== messageId)
        });
        showSnackbar({ type: 'success', text: 'Message unpinned' });
      } catch (e) {
        console.error(e);
      }
    }
  }

  const onFocusMessage = () => {
    setSearchParams({ messageId });
  }

  return <div className='flex items-center gap-2 w-full cg-border-xl cg-bg-subtle py-1 px-2 cursor-pointer' onClick={onFocusMessage}>
    <div className='pin-btn p-2 cg-circular cursor-pointer' onClick={() => setUnpinModalOpen(true)}>
      <PushPin weight='duotone' className='w-6 h-6' />
    </div>
    <ScreenAwareModal
      isOpen={unpinModalOpen}
      onClose={() => setUnpinModalOpen(false)}
      hideHeader
      noDefaultScrollable
    >
      <div className={`flex flex-col gap-4${isMobile ? ' pt-4 px-4 pb-8' : ''}`}>
        <div className='flex flex-col gap-2'>
          <h3>Unpin Message?</h3>
          <p>Are you sure you want to unpin this message? It will no longer be visible in the pinned messages section.</p>
        </div>
        <div className='flex justify-end gap-2'>
          <Button
            role='borderless'
            text={'Cancel'}
            onClick={() => setUnpinModalOpen(false)}
          />
          <Button
            role='primary'
            text={'Unpin'}
            onClick={onUnpin}
          />
        </div>
      </div>
    </ScreenAwareModal>
    <div className='flex items-center overflow-hidden w-full gap-1' >
      {!!creator && <div className='flex items-end gap-1 cg-text-md-500 cg-text-secondary'>
        <Jdenticon
          userId={creator.id}
          hideStatus
          predefinedSize='20'
        />
        {getDisplayName(creator)}
        {creator.isBot && <BotBadge />}
      </div>}
      {!!message && <span
        className='cg-text-lg-400 cg-text-main overflow-hidden whitespace-nowrap text-ellipsis'
        onClick={onFocusMessage}
      >
        {convertContentToPlainText(message.body.content)}
      </span>}
      {message === undefined && <span className='cg-text-lg-400 cg-text-warning overflow-hidden whitespace-nowrap text-ellipsis'>
        This message has been deleted.
      </span>}
    </div>

  </div>
}
