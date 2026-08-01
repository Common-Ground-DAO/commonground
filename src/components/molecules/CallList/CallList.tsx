// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './CallList.css';
import React, { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getUrl } from 'common/util';
import { useCalls, useLoadedCommunityContext } from 'context/CommunityProvider';
import CallItem from './CallItem';
import StartCallButton from '../StartCallButton/StartCallButton';
import Scrollable from '../Scrollable/Scrollable';
import { useCommunitySidebarContext } from 'components/organisms/CommunityViewSidebar/CommunityViewSidebarContext';
import short from "short-uuid";
import config from 'common/config';

const t = short();

interface CallListProps {
}

export const CallList: React.FC<CallListProps> = (props: CallListProps) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { setCommunitySidebarIsOpen } = useCommunitySidebarContext();
  const { community, communityPermissions } = useLoadedCommunityContext();
  const activeCalls = useCalls("community", community.id);

  const navigateToCall = useCallback((call: Models.Calls.Call) => {
    setCommunitySidebarIsOpen(false);
    navigate(getUrl({ type: 'community-call', community, call }));
  }, [community, navigate, setCommunitySidebarIsOpen]);

  // Show nothing if there's nothing to show. Without the mediasoup service no
  // call can be started, so the whole section goes.
  const canCreateCalls = config.CALLS_ENABLED && communityPermissions.has('WEBRTC_CREATE');
  // useCalls is a live query: undefined on the first render, so check for
  // "no calls" rather than "exactly zero calls"
  if (!activeCalls?.length && !canCreateCalls) return null;

  return (<div className='call-list-container'>
    <div className="call-list">
      <Scrollable innerClassName='active-calls'>
        {activeCalls?.map(call => <CallItem
          key={call.id}
          call={call}
          navigateToCall={navigateToCall}
          active={location.pathname.includes(t.fromUUID(call.id))}
        />)}
      </Scrollable>  
      <StartCallButton />
    </div>
  </div>);
}