// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import CommunityPhoto from 'components/atoms/CommunityPhoto/CommunityPhoto';
import Button from 'components/atoms/Button/Button';
import { createSearchParams, useNavigate } from 'react-router';
import { getUrl } from 'common/util';

type Props = {
  community: Models.Community.DetailView;
  areaName: string;
  textChannelName: string;
  textChannelId: string;
  messageId: string;
};

const TextChannelNotificationHeader: React.FC<Props> = (props) => {
  const { community, areaName, textChannelName, textChannelId, messageId } = props;
  const navigate = useNavigate();

  const goToGroupLobby = React.useCallback(() => {
    navigate(getUrl({ type: 'community-lobby', community }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community.url, navigate]);

  const goToChat = React.useCallback(() => {
    navigate({
      pathname: getUrl({
        type: 'community-channel',
        community,
        channel: { channelId: textChannelId, url: null }  
      }),
      search: createSearchParams({
        messageId: messageId
      }).toString()
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [community.url, messageId, navigate, textChannelId]);

  return (
    <div className='text-channel-notification-header'>
      <div className='text-channel-notification-header-container'>
        <div className='header-text-link' onClick={goToGroupLobby}>
          <CommunityPhoto community={community} size={'tiny'} />
        </div>
        <span className='header-text-link' onClick={goToGroupLobby}>{community.title}</span>
        <span className='text-separator'>/</span>
        <span>{areaName}</span>
        <span className='text-separator'>/</span>
        <span className='header-text-link' onClick={goToChat}>{textChannelName}</span>

        <div className='text-channel-notification-header-button'>
          <Button role='primary' text='Go to community' onClick={goToChat}/>
        </div>
      </div>
    </div>
  )
}

export default React.memo(TextChannelNotificationHeader);