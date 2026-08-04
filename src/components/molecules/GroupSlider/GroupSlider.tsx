// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useRef } from 'react'
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import CommunityCard from '../CommunityCard/CommunityCard';
import CommunitySkeletonCard from '../CommunitySkeletonCard/CommunitySkeletonCard';

import './GroupSlider.css';
import LargeCommunityCard from '../CommunityCard/LargeCommunityCard';

type Props = {
  communities: Models.Community.ListView[];
  mobileMode: 'slider' | 'grid'
  useDesktopSlider?: boolean;
  loadingGhostCount?: number;
  isLoading?: boolean;
  extraCards?: React.JSX.Element;
  scrollableRef?: React.RefObject<HTMLDivElement | null>;
  useLargeCards?: boolean;
  loadMore?: () => void;
};

const GroupSlider: React.FC<Props> = (props) => {
  const { communities, loadingGhostCount, isLoading, mobileMode, extraCards, useDesktopSlider, scrollableRef, useLargeCards, loadMore } = props;
  const { isMobile, isSmallTablet, isTablet } = useWindowSizeContext();
  const sentinelRef = useRef<HTMLDivElement>(null);

  const containerClassName: string[] = ["groupSlider-group-container"];
  if (isMobile || useDesktopSlider) {
    containerClassName.push("mobile")
    containerClassName.push(`${mobileMode}-layout`);
  } else if (isSmallTablet) {
    containerClassName.push("smallTablet");
  } else if (isTablet) {
    containerClassName.push("tablet");
  }

  if (useLargeCards) containerClassName.push('large-cards');

  useEffect(() => {
    if (!loadMore || !sentinelRef.current) return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting) {
          loadMore();
        }
      },
      { threshold: 0.1 }
    );

    observer.observe(sentinelRef.current);

    return () => {
      observer.disconnect();
    };
  });

  return (
    <div className={containerClassName.join(" ").trim()} ref={scrollableRef}>
      {(isMobile || useDesktopSlider) && mobileMode === 'slider' && <div className='pr-2' />}
      {communities.map(group => useLargeCards ? <LargeCommunityCard key={group.id} community={group} /> :  <CommunityCard key={group.id} community={group} />)}
      {extraCards}
      <div className='sentinel' ref={sentinelRef} />
      {isLoading && loadingGhostCount && Array.from(Array(loadingGhostCount).keys()).map(index => <CommunitySkeletonCard key={`community-skeleton-card-${index}`} />)}
    </div>
  )
}

export default GroupSlider