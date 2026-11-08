// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import './EventView.css';
import dayjs from 'dayjs';
import { useParams } from 'react-router';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import { dayJsToUrlFormat, generateEventICSFile, getUrl } from 'common/util';
import Event from './Event';
import { parseIdOrUrl } from '../../util';

type Props = {
};

const GOOGLE_CALENDAR_URL = 'https://www.google.com/calendar/render?action=TEMPLATE&text=$1&dates=$2/$3&details=$4&location=$5&sf=true&output=xml'

export function addToGoogleCalendar(event: Models.Community.Event, community: Pick<Models.Community.ListView, "id" | "url">) {
  if (!event) return;

  const eventUrl = `${window.origin}${getUrl({ type: 'event', community, event })}`;
  const formattedUrl = GOOGLE_CALENDAR_URL
    .replace('$1', encodeURI(event.title || 'Event'))
    .replace('$2', dayJsToUrlFormat(dayjs(event.scheduleDate)))
    .replace('$3', dayJsToUrlFormat(dayjs(event.scheduleDate).add(event.duration, 'minutes')))
    .replace('$4', encodeURI(`To see more details: ${eventUrl}`))
    .replace('$5', encodeURI(eventUrl));

  window.open(formattedUrl, '_blank', 'noopener');
};

export function downloadICSFile(event: Models.Community.Event, community: Pick<Models.Community.ListView, "title" | "id" | "url">) {
  if (!event) return;

  const icsContent = generateEventICSFile(window.origin, community, event);
  const blob = new Blob([icsContent], { type: 'text/calendar' });
  const link = document.createElement('a');
  link.href = window.URL.createObjectURL(blob);
  link.download = 'invite.ics';
  link.click();
  // window.open("data:text/calendar;charset=utf8;name=invite.ics," + icsContent);
}

const EventsView: React.FC<Props> = () => {
  const { community } = useLoadedCommunityContext();
  const { eventIdOrUrl } = useParams<'eventIdOrUrl'>();

  if (!eventIdOrUrl) {
    throw new Error("Event id or url required");
  }

  const whatIsIt = parseIdOrUrl(eventIdOrUrl);

  return <Event
    eventId={whatIsIt.uuid || ''}
    eventUrl={whatIsIt.url}
    communityId={community.id}
  />
}

export default React.memo(EventsView);