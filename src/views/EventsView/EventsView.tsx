// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from 'react'
import Scrollable from 'components/molecules/Scrollable/Scrollable';

import './EventsView.css';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import ManagementHeader from 'components/molecules/ManagementHeader/ManagementHeader';
import { useNavigate } from 'react-router';
import Button from 'components/atoms/Button/Button';
import EventsList from 'components/organisms/EventsList/EventsList';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import { PlusIcon } from '@heroicons/react/20/solid';
import ScheduleEventModal from 'components/organisms/ScheduleEventModal/ScheduleEventModal';
import communityApi from 'data/api/community';
import dayjs from 'dayjs';
import { getUrl } from 'common/util';

type Props = {
};

type EventTab = "past" | "upcoming";

const EventsView: React.FC<Props> = () => {
  const { community, communityPermissions } = useLoadedCommunityContext();
  const [currentTab, setCurrentTab] = useState<EventTab>("upcoming");
  const [showScheduleModalKey, setShowScheduleModalKey] = useState(0);
  const [events, setEvents] = useState<API.Community.getEventList.Response>([]);
  const { isMobile } = useWindowSizeContext();
  const navigate = useNavigate();
  const canCreateEvents = communityPermissions.has('COMMUNITY_MANAGE_EVENTS');

  useEffect(() => {
    communityApi.getEventList({ communityId: community.id }).then(result => {
      setEvents(result);
    }).catch(e => {
      console.error(e);
    });
  }, [community.id]);

  const validEvents = useMemo(() => {
    if (currentTab === 'upcoming') {
      return events.filter(ev => dayjs(ev.scheduleDate).add(ev.duration, 'minutes').isAfter(dayjs()));
    } else {
      return events.filter(ev => dayjs(ev.scheduleDate).add(ev.duration, 'minutes').isBefore(dayjs()));
    }
  }, [currentTab, events]);

  const onAddEvent = useCallback((event: Models.Community.Event) => {
    setEvents(oldEvents => [...oldEvents, event]);
    navigate(getUrl({type: 'event', community, event}));
  }, [community, navigate]);

  const onUpdateEvent = useCallback((eventId: string, eventChanges: Partial<Models.Community.Event>) => {
    setEvents(oldEvents => {
      const eventIndex = oldEvents.findIndex(ev => ev.id === eventId);
      if (eventIndex < 0) return oldEvents;

      const event = { ...oldEvents[eventIndex], ...eventChanges };
      const newEvents = [...oldEvents];
      newEvents.splice(eventIndex, 1, event);
      return newEvents;
    });
  }, []);

  const goBack = useCallback(() => navigate(-1), [navigate]);

  const header = useMemo(() =>
    <div className='flex flex-col gap-4'>
      <ManagementHeader
        title="Events"
        goBack={goBack}
        rightControls={canCreateEvents ? <Button
          role='secondary'
          text='New Event'
          iconLeft={<PlusIcon className='w-5 h-5' />}
          onClick={() => setShowScheduleModalKey(new Date().getTime())}
        /> : undefined}
      />
      <div className={`flex gap-2${isMobile ? ' px-2' : ''}`}>
        <Button
          role='chip'
          text='Upcoming'
          className={currentTab === 'upcoming' ? 'active' : undefined}
          onClick={() => setCurrentTab('upcoming')}
        />
        <Button
          role='chip'
          text='Past'
          className={currentTab === 'past' ? 'active' : undefined}
          onClick={() => setCurrentTab('past')}
        />
      </div>
    </div>,
  [canCreateEvents, isMobile, currentTab]);

  const scheduleEventModalOnClose = useCallback(() => setShowScheduleModalKey(0), []);

  if (isMobile) {
    return <div className="events-view">
      <ScheduleEventModal
        key={showScheduleModalKey}
        isOpen={!!showScheduleModalKey}
        onClose={scheduleEventModalOnClose}
        onAddEvent={onAddEvent}
      />
      {header}
      <Scrollable>
        <EventsList
          events={validEvents}
          order={currentTab}
          onUpdateEvent={onUpdateEvent}
        />
      </Scrollable>
    </div>
  } else {
    return (<div className="events-view">
      <ScheduleEventModal
        key={showScheduleModalKey}
        isOpen={!!showScheduleModalKey}
        onClose={scheduleEventModalOnClose}
        onAddEvent={onAddEvent}
      />
      <Scrollable>
        <div className='flex flex-col gap-6'>
          {header}
          <EventsList
            events={validEvents}
            order={currentTab}
            onUpdateEvent={onUpdateEvent}
          />
        </div>
      </Scrollable>
    </div>);
  }
}

export default React.memo(EventsView);