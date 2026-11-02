// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './EventCard.css';
import { useUserData } from 'context/UserDataProvider';
import dayjs from 'dayjs';
import { useSignedUrl } from 'hooks/useSignedUrl';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { getCommunityDisplayName } from '../../../util';
import { MicrophoneIcon } from '@heroicons/react/20/solid';
import Tag from 'components/atoms/Tag/Tag';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { useNavigate } from 'react-router';
import { getUrl } from 'common/util';
import MemberPreview2 from 'components/atoms/MemberPreview/MemberPreview2';
import { AllContentRenderer } from '../MesssageBodyRenderer/MessageBodyRenderer';
import CommunityPhoto from 'components/atoms/CommunityPhoto/CommunityPhoto';
import AttendEventButton from 'components/atoms/AttendEventButton/AttendEventButton';
import UserTag from 'components/atoms/UserTag/UserTag';
import MicClayIcon from 'components/atoms/icons/40/micClay.png';
import MegaphoneClayIcon from 'components/atoms/icons/40/megaphoneClay.png';
import PhoneClayIcon from 'components/atoms/icons/40/phoneClay.png';
import { isEventGated } from './EventCart.helper';
import { useAsyncMemo } from 'hooks/useAsyncMemo';
import EventExclusiveTooltip from './EventExclusiveTooltip';
import { useCommunityListView } from 'context/CommunityListViewProvider';
import { useCall } from 'context/CommunityProvider';
import { Globe } from '@phosphor-icons/react';
import { useSidebarDataDisplayContext } from 'context/SidebarDataDisplayProvider';

type Props = {
  event: Models.Community.Event;
  onUpdateEvent: (eventId: string, eventChanges: Partial<Models.Community.Event>) => void;
  showCommunity?: boolean;
  hideDescription?: boolean;
};

const MINIMUM_COLLAPSED_WIDTH = 400;

const capitalize = (text: string) => `${text[0].toLocaleUpperCase()}${text.slice(1)}`;

const EventCard: React.FC<Props> = ({ event, onUpdateEvent, showCommunity, hideDescription }) => {
  const { isMobile } = useWindowSizeContext();
  const { showTooltip } = useSidebarDataDisplayContext();
  const [isSmallMode, setSmallMode] = useState(false);
  const eventCardRef = useRef<HTMLDivElement>(null);

  const community = useCommunityListView(event.communityId);
  const gatedState = useAsyncMemo(() => isEventGated(event), [event.rolePermissions]);

  const call = useCall(event.callId || undefined);
  const isLive = !!call;

  const imageUrl = useSignedUrl(event.imageId);
  const startTime = useMemo(() => dayjs(event.scheduleDate), [event.scheduleDate]);
  const creator = useUserData(event.eventCreator);

  const onEventClick = useCallback(() => {
    if (community) {
      showTooltip({ type: 'event', communityId: community.id, eventId: event.id });
    }
  }, [community, event.id, showTooltip]);

  const hasFinished = useMemo(() => {
    if (!event?.duration) return false;
    const finalTime = startTime.add(event?.duration || 0, 'minutes');

    return !isLive && finalTime.isBefore(dayjs());
  }, [event?.duration, isLive, startTime]);

  useEffect(() => {
    const listener: ResizeObserverCallback = async ([entry]) => {
      if (entry) {
        const width = entry.contentRect.width;
        const useSmallMode = width < MINIMUM_COLLAPSED_WIDTH;
        setSmallMode(useSmallMode);
      }
    }

    const observer = new ResizeObserver(listener);
    if (eventCardRef.current) {
      observer.observe(eventCardRef.current);
    }

    return () => observer.disconnect();
  }, []);

  return (<div className={`event-card cursor-pointer flex gap-4${isMobile || isSmallMode ? ' collapsed' : ''}`} ref={eventCardRef} onClick={onEventClick}>
    {imageUrl && <img loading='lazy' className={`event-card-image`} src={imageUrl} alt='Event' />}
    {!imageUrl && <div className={`event-card-image no-image`}>
      {event.type === 'broadcast' && <img className='w-10 h-10' src={MicClayIcon} alt={event.type} />}
      {event.type === 'call' && <img className='w-10 h-10' src={PhoneClayIcon} alt={event.type} />}
      {event.type === 'reminder' && <img className='w-10 h-10' src={MegaphoneClayIcon} alt={event.type} />}
      {event.type === 'external' && <Globe className='w-10 h-10 cg-text-secondary' />}
    </div>}
    <div className='flex flex-col gap-2 flex-1'>
      <div className='flex items-center gap-2'>
        {isLive && <Tag
          variant='live'
          label='Live'
        />}
        {!!showCommunity && community && <>
          <div className='flex items-center gap-1 cg-text-md-400 cg-text-secondary'>
            <CommunityPhoto community={community} size='tiny-20' noHover />
            {getCommunityDisplayName(community)}
          </div>
          <span className='cg-text-lg-400 cg-text-secondary'>·</span>
        </>}
        <div className='flex items-center gap-1 cg-text-secondary'>
          {event.type === 'external' ? <Globe className='w-5 h-5' /> : <MicrophoneIcon className='w-5 h-5' />}
          <span className='cg-text-md-400'>{capitalize(event.type)}</span>
        </div>
        {gatedState && <>
          <span className='cg-text-lg-400 cg-text-secondary'>·</span>
          <EventExclusiveTooltip gatedState={gatedState} />
        </>}
      </div>
      <div className='flex flex-col gap-4'>
        <div className='flex flex-col gap-2'>
          <span className='cg-heading-3 cg-text-main'>{event.title}</span>
          <div className='flex items-center flex-wrap gap-1'>
            <span className='cg-text-lg-500 cg-text-main whitespace-nowrap'>{startTime.format('MMM D')}</span>
            <span className='cg-text-lg-400 cg-text-secondary'>·</span>
            <span className='cg-text-lg-500 cg-text-main whitespace-nowrap'>Starts {startTime.format('HH:mm')}</span>
            <span className='cg-text-lg-400 cg-text-secondary'>·</span>
            {creator && <div onClick={e => e.stopPropagation()}>
              <UserTag
                userData={creator}
                hideStatus
                noOfflineDimming
                jdenticonSize='24'
                largeNameFont
              />
            </div>}
          </div>
        </div>
        {!hideDescription && <div className='event-card-description cg-text-md-400 cg-text-secondary'>
          <AllContentRenderer
            content={event?.description.content}
          />
        </div>}
        <div className='event-card-footer flex justify-between items-center gap-2 flex-wrap'>
          <MemberPreview2
            memberCount={event.participantCount}
            memberIds={event.participantIds || []}
            limit={6}
            rightElement={hasFinished ? 'went' : "going"}
            forceShowRightElement
          />
          <AttendEventButton
            call={call}
            community={community}
            event={event}
            onUpdateEvent={onUpdateEvent}
            className={isMobile || isSmallMode ? 'w-full' : ''}
          />
        </div>
      </div>
    </div>
  </div>);
}

export default React.memo(EventCard);