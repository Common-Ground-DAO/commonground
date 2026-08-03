// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './LiveCallExplorer.css';
import React, { useCallback, useEffect, useRef, useState } from 'react';

import Button from '../../../components/atoms/Button/Button';
import FrontPageSectionHeader from '../../../components/molecules/FrontPageSectionHeader/FrontPageSectionHeader';
import LiveCallSlider from '../../../components/molecules/LiveCallSlider/LiveCallSlider';

import ArrowLeftIcon from '../../../components/atoms/icons/24/ArrowLeft.svg?react';

import { useWindowSizeContext } from '../../../context/WindowSizeProvider';
import { useCalls } from 'context/CommunityProvider';
import communityApi from 'data/api/community';

type Props = {
  mode: 'limited' | 'unlimited';
  communityId?: string;
}

function useCurrentCalls(fetchCalls: boolean) {
  const refetchTimeoutRef = useRef<any>(null);
  const [calls, setCalls] = useState<Models.Calls.Call[]>([]);
  const fetchCallsAndPrepareUpdate = useCallback(() => {
    communityApi.getCurrentCalls({offset: 0}).then(setCalls);
    refetchTimeoutRef.current = setTimeout(() => {
      fetchCallsAndPrepareUpdate();
    }, 60 * 1000);
  }, []);

  useEffect(() => {
    if (fetchCalls) fetchCallsAndPrepareUpdate();
    
    return () => {
      if (refetchTimeoutRef.current) clearTimeout(refetchTimeoutRef.current);
    }
  }, [fetchCalls, fetchCallsAndPrepareUpdate]);

  return calls;
}

const LiveCallExplorer: React.FC<Props> = ({ mode, communityId }) => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const { isMobile, isTablet, isSmallTablet } = useWindowSizeContext();
  const [isLeftMost, setIsLeftMost] = React.useState(true);
  const [isRightMost, setIsRightMost] = React.useState(false);
  const isLimitedMode = mode === 'limited';

  const MAX_CONTENT = isLimitedMode ? 6 : undefined;
  const myLiveCalls = useCalls(!!communityId ? "community" : "all", communityId);
  const allLiveCalls = useCurrentCalls(!communityId);
  const calls = !!communityId ? myLiveCalls : allLiveCalls;

  const scrollLeft = React.useCallback(() => {
    const container = containerRef.current;
    if (container) {
      container.scroll({ left: container.scrollLeft - container.clientWidth, behavior: 'smooth' });
    }
  }, []);

  const scrollRight = React.useCallback(() => {
    const container = containerRef.current;
    if (container) {
      container.scroll({ left: container.scrollLeft + container.clientWidth, behavior: 'smooth' });
    }
  }, []);

  React.useEffect(() => {
    if (isMobile) return;

    const listener = () => {
      const container = containerRef.current;
      if (container) {

        const isLeftMost = container.scrollLeft === 0;
        const isRightMost =
          ((container.scrollLeft || 0) + (container.clientWidth || 0) === container.scrollWidth) ||
          container.scrollWidth < container.clientWidth;

        setIsLeftMost(isLeftMost);
        setIsRightMost(isRightMost);
      }
    }

    const container = containerRef.current;
    if (container) {
      listener();
      container.addEventListener('scroll', listener);
    }

    return () => container?.removeEventListener('scroll', listener);
  }, [isMobile, isTablet, isSmallTablet, calls]);

  if (!calls || calls.length === 0) return null;

  const titleClassname = [
    'cg-heading-3 cg-text-main',
    isMobile && isLimitedMode ? 'px-4' : ''
  ].join(' ').trim();

  return (
    <div className={`live-call-explorer-container${calls.length > 0 ? ' active' : ''}`}>
      <FrontPageSectionHeader
        sectionTitle={<span className={titleClassname}>Live calls</span>}
        rightContent={!isMobile ?
          <div className='live-call-explorer-controls'>
            <Button role='primary' disabled={isLeftMost} iconLeft={<ArrowLeftIcon />} onClick={scrollLeft} />
            <Button role='primary' disabled={isRightMost} className='rotatedArrow' iconLeft={<ArrowLeftIcon />} onClick={scrollRight} />
          </div> : undefined
        }
      />
      <LiveCallSlider
        containerRef={containerRef}
        items={calls}
        cardCountLimit={MAX_CONTENT}
        hideCommunity={!isLimitedMode}
      />
    </div>
  );
}

export default React.memo(LiveCallExplorer);
