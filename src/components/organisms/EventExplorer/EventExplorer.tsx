// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import EventsList from '../EventsList/EventsList';
import Button from 'components/atoms/Button/Button';
import communityApi from 'data/api/community';
import config from 'common/config';
import EmptyState from 'components/molecules/EmptyState/EmptyState';
import { PostAndEventsButton } from 'views/Home/Home';
import { CalendarIcon } from '@heroicons/react/20/solid';

const INITIALEVENTLENGTH = 5;

type Props = {
  tags?: string[];
  followingOnly?: boolean;
}

const EventExplorer: React.FC<Props> = (props) => {
  const [events, setEvents] = useState<API.Community.getEventList.Response>([]);
  const [currentLimit, setCurrentLimit] = useState(INITIALEVENTLENGTH);
  const isFetching = useRef(false);
  const [isDone, setIsDone] = useState(false);
  const [tab, setTab] = useState<'all' | 'attending'>('all');

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

  useEffect(() => {
    if (isDone || events.length > 0) {
      setIsDone(false);
      setEvents([]);
    }
  }, [props.tags, props.followingOnly]); // eslint-disable-line react-hooks/exhaustive-deps

  const filteredEvents = useMemo(() => {
    if (tab === 'all') return events;
    else return events.filter(ev => ev.isSelfAttending);
  }, [events, tab]);

  const eventsSlice = useMemo(() => filteredEvents.slice(0, currentLimit), [currentLimit, filteredEvents]);

  useEffect(() => {
    if (
      filteredEvents.length < currentLimit &&
      !isFetching.current &&
      !isDone
    ) {
      isFetching.current = true;
      const last = events[events.length - 1];
      communityApi.getUpcomingEvents({
        scheduledAfter: last?.scheduleDate || null,
        afterId: last?.id || null,
        anyTags: props.tags || null,
        tags: null,
        type: !!props.followingOnly ? 'following' : 'verified'
      }).then(result => {
        if (result.length < config.EVENTS_BATCH_SIZE) {
          setIsDone(true);
        };
        setEvents(old => [...old, ...result]);
      }).catch(e => {
        console.warn("Could not load upcoming events", e instanceof Error ? e.message : e);
      }).finally(() => {
        isFetching.current = false;
      });
    }
  }, [currentLimit, events, filteredEvents.length, isDone, props.followingOnly, props.tags]);

  if (events.length === 0) return null;

  return (<>
    <PostAndEventsButton
      icon={<CalendarIcon className='w-6 h-6' />}
      text='Events'
      active={true}
      onClick={() => { }}
    />
    <div className='flex flex-col gap-4 event-explorer-container'>
      <div className='flex gap-2'>
        <Button
          role='chip'
          text={'All Events'}
          onClick={() => setTab('all')}
          className={tab === 'all' ? 'active cg-text-md-400' : 'cg-text-md-400'}
        />
        <Button
          role='chip'
          text={'Attending'}
          onClick={() => setTab('attending')}
          className={tab === 'attending' ? 'active cg-text-md-400' : 'cg-text-md-400'}
        />
      </div>
      {filteredEvents.length > 0 && <EventsList
        events={eventsSlice}
        onUpdateEvent={onUpdateEvent}
        order='upcoming'
        showCommunityOnCards
      />}
      {isDone && filteredEvents.length === 0 && <div className='cg-bg-subtle cg-border-xxl cg-text-main flex flex-col justify-center items-center gap-2 self-stretch p-4'>
        <EmptyState
          title='No upcoming events'
          description={tab === 'all' ? 'Check back later when communities schedule more events!' : 'Events you attend will show up here'}
        />
      </div>}
      {(currentLimit < events.length || !isDone) && !isFetching.current && <Button
        className='self-center w-full'
        text='Load more'
        role='secondary'
        onClick={() => setCurrentLimit(old => old + config.EVENTS_BATCH_SIZE)}
      />}
    </div>
  </>);
}

export default React.memo(EventExplorer);