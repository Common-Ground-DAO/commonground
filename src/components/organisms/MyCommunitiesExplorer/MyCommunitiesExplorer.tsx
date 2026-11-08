// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useState, useMemo, useCallback, useRef } from 'react'
import { useLiveQuery } from 'dexie-react-hooks';
import data from 'data';
import { EmptyCommunityCard } from 'components/molecules/CommunityCard/EmptyCommunityCard';
import { useNavigate } from 'react-router';
import GroupSlider from 'components/molecules/GroupSlider/GroupSlider';

import { ChevronLeftIcon, ChevronRightIcon } from '@heroicons/react/20/solid';

import './MyCommunitiesExplorer.css';
import { useOwnUser, useOwnCommunities } from 'context/OwnDataProvider';
import { getUrl } from 'common/util';

type Props = {};

const MyCommunitiesExplorer: React.FC<Props> = () => {
  const [leftDisabled, setLeftDisabled] = useState(true);
  const [rightDisabled, setRightDisabled] = useState(false);
  const scrollableRef = useRef<HTMLDivElement>(null);
  const navigate = useNavigate();

  const ownUser = useOwnUser();
  const ownCommunities = useOwnCommunities();

  const sortedCommunities = useMemo(() => {
    const sortedCommunities: Models.Community.ListView[] = [];
    ownUser?.communityOrder.forEach(communityId => {
      const foundCommunity = ownCommunities?.find(community => community.id === communityId);
      if (foundCommunity) {
        sortedCommunities.push(foundCommunity);
      }
    });

    return sortedCommunities;
  }, [ownUser?.communityOrder, ownCommunities]);

  const extraCard = useMemo(() => {
    return <EmptyCommunityCard title='Find communities' onClick={() => navigate(getUrl({ type: 'browse-communities' }))} />;
  }, [navigate]);

  const scrollLeft = useCallback(() => {
    const div = scrollableRef.current;
    if (div) {
      div.scrollBy({left: -100, behavior: 'smooth'});
      setTimeout(() => {
        console.log(div.scrollLeft);
        setLeftDisabled(div.scrollLeft < 50);
        setRightDisabled(div.scrollLeft + div.clientWidth >= div.scrollWidth);
      }, 250);
    }
  }, []);

  const scrollRight = useCallback(() => {
    const div = scrollableRef.current;
    if (div) {
      div.scrollBy({left: 100, behavior: 'smooth'});
      setTimeout(() => {
        console.log(div.scrollLeft);
        setLeftDisabled(div.scrollLeft < 50);
        setRightDisabled(div.scrollLeft + div.clientWidth >= div.scrollWidth);
      }, 250);
    }
  }, []);

  if (sortedCommunities.length === 0) return null;

  return (
    <div className='my-communities-explorer'>
      <div className='my-communities-explorer-header'>
        <div className='my-communities-explorer-header-text'>
          My Communities
          <span className='my-communities-explorer-count'>{sortedCommunities.length}</span>
        </div>
        <div className='my-communities-buttons'>
          <div
            onClick={scrollLeft}
            className={`my-communities-button${leftDisabled ? ' disabled' : ''}`}
          >
            <ChevronLeftIcon className='w-5 h-5' />
          </div>
          <div
            onClick={scrollRight}
            className={`my-communities-button${rightDisabled ? ' disabled' : ''}`}
          >
            <ChevronRightIcon className='w-5 h-5' />
          </div>
        </div>
      </div>
      <div className='w-full flex flex-col items-center'>
        <GroupSlider
          communities={sortedCommunities}
          mobileMode='slider'
          extraCards={extraCard}
          useDesktopSlider
          scrollableRef={scrollableRef}
        />
      </div>
    </div>
  );
}

export default React.memo(MyCommunitiesExplorer);