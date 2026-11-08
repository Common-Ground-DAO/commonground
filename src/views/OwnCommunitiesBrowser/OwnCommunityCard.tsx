// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo } from 'react'
import dayjs from 'dayjs';
import useLocalStorage, { VisitedCommunitiesState } from '../../hooks/useLocalStorage';
import { useWindowSizeContext } from '../../context/WindowSizeProvider';
import { useNavigate } from 'react-router';

import CommunityPhoto from '../../components/atoms/CommunityPhoto/CommunityPhoto';
import NotificationDot from 'components/atoms/NotificationDot/NotificationDot';

import './OwnCommunityCard.css';
import { getUrl } from 'common/util';
import { useLiveQuery } from 'dexie-react-hooks';
import data from 'data';
import { UserIcon } from '@heroicons/react/20/solid';
import PinnedChannel from 'components/molecules/PinnedChannel/PinnedChannel';
import { getCommunityDisplayName } from '../../util';

type Props = {
  community: Models.Community.ListView;
  size?: "large" | "small" | "tiny";
  hideNewTag?: boolean;
  collapsed: boolean;
}

const CommunityExplorerItem: React.FC<Props> = ({ community, size, hideNewTag, collapsed }) => {
  const navigate = useNavigate();
  const { isMobile } = useWindowSizeContext();
  const [visitedState] = useLocalStorage<VisitedCommunitiesState>({}, 'communities-visited-state');

  const createdDate = dayjs(community.createdAt);
  const isRecent = dayjs().diff(createdDate, 'd') < 7;
  const isVisited = visitedState[community.id];
  const showNewTag = !hideNewTag && isRecent && !isVisited;

  const channels = useLiveQuery(() => {
    return data.community.getChannels(community.id);
  }, [community.id]);

  const unread = (channels || []).reduce<number>((agg, channel) => {
    return agg + (channel.unread || 0);
  }, 0);

  const ownPinnedChannels = useMemo(() => {
    return channels?.filter(channel => 
      channel.pinType === 'permapin' ||
      (channel.pinType === 'autopin' && !!channel.pinnedUntil && new Date(channel.pinnedUntil) > new Date())
    ) || [];
  }, [channels]);

  const content = (
    <>
      {showNewTag && <span className='new-tag'>New</span>}
      <div className='community-photo-container'>
        <CommunityPhoto community={community} size={size || "large"} showExtraIcon />
      </div>
      <div className='community-card-footer'>
        <div className='community-card-title'>
          {getCommunityDisplayName(community, 'w-5 h-5', true)}
        </div>
      </div>
      <span className='flex items-center justify-end gap-1 cg-text-secondary cg-text-md-500'>
        <span>{community.memberCount}</span>
        {<UserIcon className='w-4 h-4' />}
      </span>
    </>
  );

  const ownPinnedChannelsContent = useMemo(() => {
    if (isMobile) {
      return ownPinnedChannels.map(channel => <PinnedChannel
        key={channel.channelId}
        communityUrl={community.url}
        channel={channel}
        collapsed={collapsed}
        className='ml-0.5'
      />);
    }
    else {
      return null;
    }
  }, [isMobile, ownPinnedChannels, community.url, collapsed]);

  if (isMobile) {
    return <>
      <div className='community-card-container community-card-container-mobile' onClick={() => navigate(getUrl({ type: 'community-lobby', community }))}>
        {content}
        {!!unread && <NotificationDot className="notification-dot" />}
      </div>
      <div className='flex flex-col gap-1 w-full'>
        {ownPinnedChannelsContent}
      </div>
    </>;
  }

  return (
    <div className='community-card-container community-card-container-desktop' onClick={() => navigate(getUrl({ type: 'community-lobby', community }))}>
      {content}
    </div>
  );
}

export default React.memo(CommunityExplorerItem);