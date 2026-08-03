// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo } from 'react';
import './CommunityView.css';
import { Route, Routes, useParams } from 'react-router-dom';

import CommunityLobby from '../../components/templates/CommunityLobby/CommunityLobby';
import MemberList from '../../components/organisms/MemberList/MemberList';
import CommunityContentList from 'components/templates/CommunityContentList/CommunityContentList';

import UsersWithPlusIcon from '../../components/atoms/icons/24/UsersWithPlus.svg?react';
import SpinnerIcon from '../../components/atoms/icons/16/Spinner.svg?react';

import { useWindowSizeContext } from "../../context/WindowSizeProvider";
import { useLoadedCommunityContext } from '../../context/CommunityProvider';
import { useMemberListContext } from '../../components/organisms/MemberList/MemberListContext';
import { parseIdOrUrl } from '../../util';
import JoinCommunityButton from 'components/atoms/JoinCommunityButton/JoinCommunityButton';

export default function CommunityView() {
  const { channelIdOrUrl } = useParams<'channelIdOrUrl'>();
  const { ownRolesById, community, channels } = useLoadedCommunityContext();

  const channelId = React.useMemo(() => {
    if (!!channelIdOrUrl) {
      const data = parseIdOrUrl(channelIdOrUrl);
      if (!!data.uuid) {
        return data.uuid;
      } else if (!!data.url) {
        return channels.find(ch => ch.url === data.url)?.channelId;
      }
    }
  }, [channelIdOrUrl, channels]);

  const { isMobile } = useWindowSizeContext();
  const { memberListIsOpen } = useMemberListContext();

  const myRoleTitles = useMemo(() => {
    return Array.from(ownRolesById.values()).map(r => r.title);
  }, [ownRolesById]);
  const isJoinedCommunity = myRoleTitles.length > 0;

  const contentClassName = [
    'community-view',
    !!channelId ? 'text-channel-view' : '',
    (memberListIsOpen && !!channelId) ? 'with-member-list-container' : ''
  ].join(" ").trim();

  const lobbyContent = useMemo(() => {
    if (isJoinedCommunity) {
      if (!!channelId) {
        return <MemberList />;
      }
    }
    else {
      if (isMobile) {
        return <div className='join-community-btn-container'>
          <JoinCommunityButton
            community={community}
            className='join-community-btn mobile-join-btn'
            iconLeft={<UsersWithPlusIcon />}
          />
        </div>;
      }
    }
    return null;
  }, [isJoinedCommunity, isMobile, channelId, community]);

  return <div className={contentClassName}>
    <Routes>
      <Route path='/' element={<>
        <CommunityLobby
          channelId={channelId}
        />
        {lobbyContent}
      </>} />
      <Route path='/announcements' element={<CommunityContentList communityId={community.id} tags={['announcement']} />} />
      <Route path='/articles' element={<CommunityContentList communityId={community.id} tags={['article']} />} />
      <Route path='/guides' element={<CommunityContentList communityId={community.id} tags={['guide']} />} />
      <Route path='/drafts' element={<CommunityContentList communityId={community.id} tags={[/* Todo */]} />} />
    </Routes>
  </div>;
}
