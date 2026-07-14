// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo, useRef } from 'react'
import './NotificationMessage.css';
import { useLiveQuery } from "dexie-react-hooks";

import CommunityPhoto from '../../../components/atoms/CommunityPhoto/CommunityPhoto';
import Jdenticon from '../../../components/atoms/Jdenticon/Jdenticon';
import UserTooltip from '../../organisms/UserTooltip/UserTooltip';
import Timestamp from '../../../components/atoms/Timestamp/Timestamp';

import { getDisplayName, getDisplayNameString } from '../../../util';
import { ReactComponent as ReplyIcon } from '../../../components/atoms/icons/16/Reply.svg';
import { ReactComponent as ModIcon } from '../../../components/atoms/icons/16/Mod.svg';
import { ReactComponent as MentionIcon } from '../../../components/atoms/icons/16/Mention.svg';
import { ReactComponent as FollowIcon } from '../../../components/atoms/icons/16/Follow.svg';

import data from 'data';
import NotificationDot from 'components/atoms/NotificationDot/NotificationDot';
import { useUserData } from 'context/UserDataProvider';
import { UserTooltipHandle } from 'components/atoms/Tooltip/UserProfilePopover';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import BotBadge from 'components/atoms/BotBadge/BotBadge';

type Props = {
  notification: Models.Notification.Notification;
  selected?: boolean;
  onClick?: () => void;
};

const iconStyle = { width: '24px', height: '24px' };

export function getIcon(type: Models.Notification.Type) {
  switch (type) {
    case 'Reply': return <ReplyIcon />;
    //case 'Airdrop': return <AirdropIcon />;
    // case 'Announcement': return <AnnouncementAltIcon />;
    //case 'Article': return <ArticleIcon />;
    //case 'DM': return <ChatIcon />;
    case 'Follower': return <FollowIcon />;
    case 'Mention': return <MentionIcon />;

    default: return <ModIcon />;
  }
}

const NotificationMessage: React.FC<Props> = ({ notification, selected, onClick }) => {
  const { isMobile } = useWindowSizeContext();

  const community = useLiveQuery(() => {
    if (notification.subjectCommunityId) {
      return data.community.getCommunityDetailView(notification.subjectCommunityId);
    }
    if (notification.extraData?.type === 'articleData' && notification.extraData?.articleOwner.type === 'community') {
      return data.community.getCommunityDetailView(notification.extraData.articleOwner.communityId);
    }

    return undefined;
  }, [notification.subjectCommunityId]);

  const channel = useLiveQuery(() => {
    if (notification.subjectCommunityId && notification.extraData?.channelId) {
      return data.community.getChannel(notification.subjectCommunityId, notification.extraData.channelId);
    }
    return undefined;
  }, [notification.subjectCommunityId, notification.extraData?.channelId]);

  const userId = useMemo(() => {
    if (notification.subjectUserId) return notification.subjectUserId;
    if (notification.extraData?.type === 'articleData' && notification.extraData?.articleOwner.type === 'user') {
      return notification.extraData.articleOwner.userId;
    }
    return undefined;
  }, [notification.subjectUserId, notification.extraData]); 

  const user = useUserData(userId);
  const userTooltipRef = useRef<UserTooltipHandle>(null);

  const onClickInternal = useCallback(() => {
    if (notification.type === "Follower") {
      userTooltipRef.current?.open();
    }
    onClick?.();
  }, [notification.type, onClick]);

  const icon = useMemo(() => {
    return getIcon(notification.type);
  }, [notification.type]);

  const renderedTitle = useMemo(() => {
    if (notification.subjectUserId && (
      notification.type === 'DM' ||
      notification.type === 'Mention' || 
      notification.type === 'Reply' ||
      notification.type === 'Follower'
    )) {
      if (!user) return null;

      if (!isMobile || notification.type === 'Follower') {
        return (
          <UserTooltip
            ref={userTooltipRef}
            userId={notification.subjectUserId}
            placement="right"
            isMessageTooltip={false}
            listId={`follower-${notification.subjectUserId}`}
            triggerClassName='flex'
          >
            <div className='notificationMessageSubject'>
              <Jdenticon userId={user.id} onlineStatus={user.onlineStatus} iconStyle={iconStyle} />
              <span className='notificationMessageSubjectName flex items-center gap-1'>
                {getDisplayName(user)}
                {user.isBot && <BotBadge />}
              </span>
            </div>
          </UserTooltip>
        );
      }
      else {
        return (
          <div className='notificationMessageSubject'>
            <Jdenticon userId={user.id} onlineStatus={user.onlineStatus} iconStyle={iconStyle} />
            <span className='notificationMessageSubjectName flex items-center gap-1'>
              {getDisplayName(user)}
              {user.isBot && <BotBadge />}
            </span>
          </div>
        );
      }
    }
    else if (notification.subjectCommunityId) {
      if (!community) return null;

      return <div className='notificationMessageSubject'>
        <CommunityPhoto community={community} size="tiny" />
        <span className='notificationMessageSubjectName'>{community.title}</span>
      </div>;
    }

    return <span className='unknown-subject'>Unknown subject</span>;
  }, [community, notification.subjectCommunityId, notification.subjectUserId, notification.type, user, isMobile]);

  const extraInfo: (JSX.Element | null) = useMemo(() => {
    switch (notification.type) {
      case 'Mention':
      case 'Reply': {
        if (notification.extraData?.type === 'articleData') {
          return <span className='notificationMessageExtra'>{community?.title || (user ? getDisplayNameString(user) : '')} ⋅ {notification.extraData.articleTitle}</span>;

        }
        return <span className='notificationMessageExtra'>{community?.title} ⋅ {channel?.title}</span>;
      }
    }
    return null;
  }, [notification.type, notification.extraData, community?.title, channel?.title, user]);

  return (
    <div
      className={`notificationMessage ${notification.read ? 'read' : 'unread'} ${selected ? 'selected' : ''}`}
      onClick={onClickInternal}
      data-timestamp={notification.createdAt.toISOString()}
    >
      <div className='notificationMessageTitle'>
        <div className='overflow-hidden flex-1'>
          {!notification.read && <NotificationDot />}
          {icon}
          {renderedTitle}
        </div>
        <Timestamp timestamp={notification.createdAt} mode='minimal' />
        {/* <span>{formatTimestamp(notification.created)}</span> */}
      </div>
      <span className={`notificationMessageText${notification.type === 'Approval' ? ' no-clamp' : ''}`}>{notification.text}</span>
      {extraInfo}
    </div>
  )
}

export default React.memo(NotificationMessage);
