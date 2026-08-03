// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import '../../../views/EventView/EventView.css';
import { getDateTitle } from 'components/organisms/EventsList/EventsList';
import { useOwnUser } from 'context/OwnDataProvider';
import dayjs from 'dayjs';
import React, { useCallback, useMemo } from 'react'
import Button from '../Button/Button';

import AppleIcon from '../../atoms/icons/20/AppleIcon.svg?react';
import GoogleIcon from '../../atoms/icons/20/GoogleIcon.svg?react';
import ShareButton from '../ShareButton/ShareButton';
import { getUrl } from 'common/util';
import { ArrowUpTrayIcon, XCircleIcon } from '@heroicons/react/20/solid';
import { addToGoogleCalendar, downloadICSFile } from 'views/EventView/EventView';
import communityApi from 'data/api/community';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { useCommunityListView } from 'context/CommunityListViewProvider';
import { useCall } from 'context/CommunityProvider';

type Props = {
  event: Models.Community.Event;
  onUpdateEvent: (eventId: string, eventChanges: Partial<Models.Community.Event>) => void;
}

const AttendEventButtonDropdown: React.FC<Props> = (props) => {
  const { event, onUpdateEvent } = props;
  const ownUser = useOwnUser();
  const { isMobile } = useWindowSizeContext();
  const startTime = dayjs(event.scheduleDate);
  const community = useCommunityListView(event.communityId);;
  const call = useCall(event?.callId || undefined);
  const isLive = !!call;

  const hasFinished = useMemo(() => {
    if (!event?.duration) return false;
    const finalTime = startTime.add(event.duration, 'minutes');
    return !isLive && finalTime.isBefore(dayjs());
  }, [event?.duration, isLive, startTime]);

  const isHost = event?.eventCreator === ownUser?.id;

  const cancelAttendance = useCallback(async (ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (!event || !ownUser) return;

    await communityApi.removeEventParticipant({ eventId: event.id });
    onUpdateEvent(event.id,
      {
        isSelfAttending: false,
        participantCount: Number(event.participantCount) - 1,
        participantIds: event.participantIds.filter(pId => pId !== ownUser?.id)
      }
    );
  }, [event, onUpdateEvent, ownUser]);

  return (<div className={`flex flex-col gap-6 cg-text-main px-4 pb-4 ${!isMobile ? 'w-80' : 'w-full'}`} onClick={ev => ev.stopPropagation()}>
    <div className='flex flex-col'>
      <h3 className='cg-heading-3 py-2'>{event.title}</h3>
      <div className='flex flex-col gap-2'>
        <h3 className='cg-heading-3'>{getDateTitle(event.scheduleDate, 'upcoming')}</h3>
        <span className='cg-text-lg-400 cg-text-secondary'>Starts {startTime.format('HH:mm')}</span>
      </div>
    </div>
    <div className='flex flex-col justify-center items-center gap-2'>
      <span className='cg-text-md-500 cg-text-secondary'>Options</span>
      {!hasFinished && community && <>
        <Button
          role='secondary'
          text='Add to Apple iCal'
          className='event-options-btn w-full'
          iconLeft={<AppleIcon />}
          onClick={() => downloadICSFile(event, community)}
        />
        <Button
          role='secondary'
          text='Add to Google Calendar'
          className='event-options-btn w-full'
          iconLeft={<GoogleIcon />}
          onClick={() => addToGoogleCalendar(event, community)}
        />
      </>}
      {!!community && <ShareButton
        relativeUrl={event
          ? getUrl({
            type: 'event',
            community,
            event
          })
          : ''}
        contentTitle={event?.title || ''}
        contentText={event ? `Share event ${event.title}` : ''}
        shareLinkOnly={true}
        role='secondary'
        className='event-options-btn w-full'
        buttonText='Share Event'
        iconLeft={<ArrowUpTrayIcon className='w-5 h-5 cg-text-secondary' />}
      />}
      {!hasFinished && !isHost && event?.isSelfAttending && <Button
        role='secondary'
        text='Cancel Attendance'
        className='event-options-btn w-full'
        onClick={cancelAttendance}
        iconLeft={<XCircleIcon className='w-5 h-5 cg-text-secondary' />}
      />}
    </div>
  </div>);
}

export default React.memo(AttendEventButtonDropdown);