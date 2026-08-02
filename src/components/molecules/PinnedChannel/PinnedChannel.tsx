// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo } from 'react'
import './PinnedChannel.css';
import CornerDownRightIcon from '../../atoms/icons/20/CornerDownRight.svg?react';
import { XMarkIcon } from '@heroicons/react/20/solid';
import NotificationDot from 'components/atoms/NotificationDot/NotificationDot';
import { getUrl } from '../../../common/util';
import { useLocation, useNavigate } from 'react-router-dom';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { Tooltip } from 'components/atoms/Tooltip/Tooltip';
import { useCommunitySidebarContext } from 'components/organisms/CommunityViewSidebar/CommunityViewSidebarContext';
import data from 'data';

type Props = {
  communityUrl: string;
  channel: Models.Community.Channel;
  collapsed: boolean;
  className?: string;
};

const PinnedChannel: React.FC<Props> = ({ communityUrl, channel, collapsed, className }) => {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const { isMobile } = useWindowSizeContext();
  const unread = !!channel.unread;
  const { setCommunitySidebarIsOpen } = useCommunitySidebarContext();

  const targetUrl = useMemo(() => getUrl({
    type: 'community-channel',
    channel: channel,
    community: { url: communityUrl },
  }), [channel, communityUrl]);

  const isActive = pathname.includes(targetUrl);

  const onClick = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    setCommunitySidebarIsOpen(false);
    navigate(targetUrl);
  };

  const onRemove = (ev: React.MouseEvent) => {
    if (!isMobile) {
      ev.stopPropagation();
      if (channel.pinType === 'autopin') {
        data.community.setChannelPinState({
          channelId: channel.channelId,
          communityId: channel.communityId,
          pinnedUntil: null,
        });
      }
      else if (channel.pinType === 'permapin'){
        data.community.setChannelPinState({
          channelId: channel.channelId,
          communityId: channel.communityId,
          pinType: 'autopin',
          pinnedUntil: null,
        });
      }
    }
  };

  const ownClassName = [
    'pinned-channel',
    collapsed ? 'collapsed' : '',
    isActive ? 'active' : '',
    className
  ].join(' ').trim();

  const content = <div className='pinned-channel-content'>
    {!collapsed && <div className={`pinned-channel-icon${!isMobile ? ' desktop-icon' : ''}`} onClick={onRemove}>
      <CornerDownRightIcon className='pinned-arrow' />
      <XMarkIcon className='w-5 h-5 pinned-x' />
    </div>}
    <span className='pinned-channel-title'>{`${channel.emoji || '💬'} ${!collapsed ? channel.title : ''}`}</span>
    {unread && <NotificationDot className='pinned-channel-notification' />}
  </div>;

  if (collapsed && !isMobile) {
    return (<Tooltip
      triggerContent={<div onClick={onClick}>
        {content}
      </div>}
      tooltipContent={channel.title}
      placement='right'
      triggerClassName={ownClassName}
      offset={4}
      openDelay={200}
    />)
  } else {
    return (<div className={ownClassName} onClick={onClick}>
      {content}
    </div>);
  }
}

export default React.memo(PinnedChannel);