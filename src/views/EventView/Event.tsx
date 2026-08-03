// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import './EventView.css';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import { useSignedUrl } from 'hooks/useSignedUrl';
import { ArrowUpTrayIcon, XCircleIcon, PencilIcon, ArrowLeftIcon } from '@heroicons/react/20/solid';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import Tag from 'components/atoms/Tag/Tag';
import Button from 'components/atoms/Button/Button';
import dayjs from 'dayjs';
import { useUserData } from 'context/UserDataProvider';
import AppleIcon from '../../components/atoms/icons/20/AppleIcon.svg?react';
import GoogleIcon from '../../components/atoms/icons/20/GoogleIcon.svg?react';
import { useNavigate } from 'react-router-dom';
import communityApi from 'data/api/community';
import { useCall, useSafeCommunityContext } from 'context/CommunityProvider';
import MemberPreview2 from 'components/atoms/MemberPreview/MemberPreview2';
import { dayJsToUrlFormat, generateEventICSFile, getUrl } from 'common/util';
import { AllContentRenderer } from 'components/molecules/MesssageBodyRenderer/MessageBodyRenderer';
import { useOwnUser } from 'context/OwnDataProvider';
import ScheduleEventModal from 'components/organisms/ScheduleEventModal/ScheduleEventModal';
import AttendEventButton from 'components/atoms/AttendEventButton/AttendEventButton';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import { useSnackbarContext } from 'context/SnackbarContext';
import SpinnerIcon from '../../components/atoms/icons/16/Spinner.svg?react';
import ShareButton from 'components/atoms/ShareButton/ShareButton';
import UserTag from 'components/atoms/UserTag/UserTag';
import MicClayIcon from '../../components/atoms/icons/40/micClay.png';
import MegaphoneClayIcon from '../../components/atoms/icons/40/megaphoneClay.png';
import PhoneClayIcon from '../../components/atoms/icons/40/phoneClay.png';
import EventExclusiveTooltip from 'components/molecules/EventCard/EventExclusiveTooltip';
import { useAsyncMemo } from 'hooks/useAsyncMemo';
import { isEventGated } from 'components/molecules/EventCard/EventCart.helper';
import { MegaphoneIcon, MicrophoneIcon } from '@heroicons/react/24/solid';
import { ArrowsOutSimple, Globe, Headphones, Link, MapPin, SignIn, SignOut } from '@phosphor-icons/react';
import SimpleLink from 'components/atoms/SimpleLink/SimpleLink';
import { useCommunityListView } from 'context/CommunityListViewProvider';
import MessageViewInner from 'views/MessageViewInner/MessageViewInner';
import channelDatabaseManager from 'data/databases/channel';
import Jdenticon from 'components/atoms/Jdenticon/Jdenticon';
import UserTooltip from 'components/organisms/UserTooltip/UserTooltip';
import { getDisplayName } from '../../util';

type ParticipantEvent = {
  eventType: 'join' | 'leave';
  userId: string;
  timestamp: string;
};

const ParticipantEventItem: React.FC<{ event: ParticipantEvent }> = ({ event }) => {
  const user = useUserData(event.userId);
  const time = dayjs(event.timestamp);

  return (
    <div className='flex items-center gap-3 py-2 px-4'>
      <div className={`flex items-center justify-center w-8 h-8 rounded-full ${event.eventType === 'join' ? 'cg-bg-success-subtle' : 'cg-bg-destructive-subtle'}`}>
        {event.eventType === 'join' 
          ? <SignIn className='w-4 h-4 cg-text-success' weight='bold' />
          : <SignOut className='w-4 h-4 cg-text-destructive' weight='bold' />
        }
      </div>
      <UserTooltip
        userId={event.userId}
        isMessageTooltip={false}
        openDelay={500}
        closeDelay={100}
      >
        <Jdenticon userId={event.userId} predefinedSize='32' hideStatus />
      </UserTooltip>
      <div className='flex flex-col flex-1 min-w-0'>
        <span className='cg-text-md-500 cg-text-main truncate'>
          {user ? getDisplayName(user) : 'Loading...'}
        </span>
        <span className='cg-text-sm-400 cg-text-secondary'>
          {event.eventType === 'join' ? 'Joined' : 'Left'} at {time.format('HH:mm:ss')}
        </span>
      </div>
    </div>
  );
};

const ParticipantsList: React.FC<{ callId: string }> = ({ callId }) => {
  const [events, setEvents] = useState<ParticipantEvent[]>([]);
  const [isLoading, setIsLoading] = useState(true);

  useEffect(() => {
    communityApi.getCallParticipantEvents({ callId })
      .then(data => {
        setEvents(data.events);
      })
      .catch(e => {
        console.error('Failed to load participant events:', e);
      })
      .finally(() => {
        setIsLoading(false);
      });
  }, [callId]);

  if (isLoading) {
    return (
      <div className='flex items-center justify-center p-4'>
        <div className='spinner'>
          <SpinnerIcon />
        </div>
      </div>
    );
  }

  if (events.length === 0) {
    return (
      <div className='flex flex-col items-center justify-center p-8 gap-2'>
        <span className='cg-text-lg-400 cg-text-secondary'>No participants recorded</span>
      </div>
    );
  }

  return (
    <div className='flex flex-col'>
      {events.map((event, index) => (
        <ParticipantEventItem key={`${event.userId}-${event.eventType}-${index}`} event={event} />
      ))}
    </div>
  );
};

type Props = {
  eventId: string;
  eventUrl?: string;
  communityId: string;
  goBack?: () => void;
  sidebarMode?: boolean;
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

type PastCallTab = 'chat' | 'participants';

const Event: React.FC<Props> = (props) => {
  const { eventId, eventUrl, communityId, goBack, sidebarMode } = props;
  const navigate = useNavigate();
  const { isMobile, isTablet } = useWindowSizeContext();
  const communityContext = useSafeCommunityContext();
  const { showSnackbar } = useSnackbarContext();
  const ownUser = useOwnUser();
  const [event, setEvent] = useState<API.Community.getEvent.Response | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [showScheduleModalKey, setShowScheduleModalKey] = useState(0);
  const [showDeleteModal, setShowDeleteModal] = useState(false);
  const [pastCall, setPastCall] = useState<API.Community.getCall.Response | null>(null);
  const [activeTab, setActiveTab] = useState<PastCallTab>('participants');
  const canCreateEvents = communityContext.state === 'loaded' && communityContext.communityPermissions.has('COMMUNITY_MANAGE_EVENTS');
  const community = useCommunityListView(communityId);

  if (!eventId && !eventUrl) {
    throw new Error("Event id or url required");
  }

  useEffect(() => {
    communityApi.getEvent(eventId ? { id: eventId } : { url: eventUrl || '' }).then(setEvent).catch(e => {
      console.error(e);
    }).finally(() => {
      setIsLoading(false);
    });
  }, [eventId, eventUrl]);

  const call = useCall(event?.callId || undefined);
  const isLive = !!call;

  const imageUrl = useSignedUrl(event?.imageId);
  const startTime = dayjs(event?.scheduleDate);
  const finalTime = useMemo(() => startTime.add(event?.duration || 0, 'minutes'), [event?.duration, startTime]);
  const creator = useUserData(event?.eventCreator);

  const hasFinished = useMemo(() => {
    if (!event?.duration) return false;
    return !isLive && finalTime.isBefore(dayjs());
  }, [event?.duration, finalTime, isLive]);

  useEffect(() => {
    let mounted = true;
    if (hasFinished && event?.callId) {
      communityApi.getCall({ id: event.callId, communityId: event.communityId })
      .then(data => {
        if (mounted) {
          channelDatabaseManager.registerAccessForChannel({
            channelId: data.channelId,
            communityId: data.communityId,
            callId: data.id,
          });
          setPastCall(data);
        }
      })
      .catch(e => {
        console.error(e);
      });
    }
    else {
      setPastCall(null);
    }
    return () => {
      mounted = false;
    };
  }, [event?.callId, event?.communityId, hasFinished]);

  const gatedState = useAsyncMemo(async () => {
    if (event) return isEventGated(event);
    return undefined;
  }, [event?.rolePermissions]);

  const isHost = event?.eventCreator === ownUser?.id;

  const editEvent = useCallback(() => {
    if (event) {
      setShowScheduleModalKey(new Date().getTime());
    }
  }, [event]);

  const onEditEvent = useCallback((newEvent: API.Community.updateCommunityEvent.Response) => {
    if (!newEvent) {
      return;
    }
    setEvent((old) => {
      if (old) {
        return {
          ...old,
          ...newEvent
        }
      }
      return old;
    });
  }, []);

  const deleteEvent = useCallback(async () => {
    if (event && community) {
      await communityApi.deleteCommunityEvent({ eventId: event.id, communityId: community.id });
      showSnackbar({ type: 'info', text: 'The event was cancelled' });
      navigate(getUrl({ type: 'community-events', community }));
    }
  }, [community, event, navigate, showSnackbar]);

  const cancelAttendance = useCallback(async (ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (!event || !ownUser) return;

    await communityApi.removeEventParticipant({ eventId: event.id });
    setEvent(old => {
      if (old) return {
        ...old,
        isSelfAttending: false,
        participantCount: Number(event.participantCount) - 1,
        participantIds: event.participantIds.filter(pId => pId !== ownUser?.id)
      }
      return old;
    });
  }, [event, ownUser]);

  const goToEventPage = useCallback(() => {
    if (event && community) {
      navigate(getUrl({ type: 'event', community, event }));
    }
  }, [event, community, navigate]);

  const content = useMemo(() => {
    let header: JSX.Element | null = null;
    if (isLive || gatedState) header = <div className='flex items-center gap-2'>
      {isLive && <Tag
        variant='live'
        label='Live'
      />}

      {isLive && gatedState && <span className='cg-text-lg-400 cg-text-secondary'>·</span>}

      {gatedState && <>
        <EventExclusiveTooltip gatedState={gatedState} />
      </>}
    </div>;

    const callInfo = <div className='flex flex-col gap-4'>
      {header}
      <span className={`${isMobile ? 'cg-heading-2' : 'cg-heading-1'} cg-text-main`}>{event?.title}</span>
      <div className='flex gap-4 items-center'>
        <div className='flex flex-col justify-center items-center cg-simple-container cg-border-l overflow-hidden cg-text-main h-12 w-12'>
          <div className='cg-bg-subtle py-1 px-3 cg-caption-md-600'>{startTime.format('MMM')}</div>
          <div className='cg-text-lg-500 py-0.5 px-2'>{startTime.format('D')}</div>
        </div>

        <div className='flex flex-col gap-1'>
          <span className='cg-text-md-500 cg-text-main'>{startTime.format('dddd, MMMM Do')}</span>
          <span className='cg-text-md-400 cg-text-secondary'>{startTime.format('HH:mm')} - {finalTime.format('HH:mm z')}</span>
        </div>
      </div>

      {event?.type !== 'external' && <div className='flex gap-4 items-center'>
        <div className='flex flex-col justify-center items-center cg-simple-container cg-border-l overflow-hidden cg-text-secondary h-12 w-12'>
          {event?.type === 'call' && <Headphones weight='fill' className='w-6 h-6' />}
          {event?.type === 'broadcast' && <MicrophoneIcon className='w-6 h-6' />}
          {event?.type === 'reminder' && <MegaphoneIcon className='w-6 h-6' />}
        </div>
        <span className='cg-text-md-500 cg-text-main'>
          {event?.type === 'call' ? 'Group Call' : event?.type === 'broadcast' ? 'Broadcast' : 'Reminder'}
        </span>
      </div>}

      {event?.externalUrl && <div className='flex gap-4 items-center'>
        <div className='flex flex-col justify-center items-center cg-simple-container cg-border-l overflow-hidden cg-text-secondary h-12 w-12'>
          <Link className='w-6 h-6 cg-text-secondary' weight='duotone' />
        </div>
        <SimpleLink href={event.externalUrl} className='cg-text-md-500 cg-text-main'>
          {event.externalUrl}
        </SimpleLink>
      </div>}

      {event?.location && <div className='flex gap-4 items-center'>
        <div className='flex flex-col justify-center items-center cg-simple-container cg-border-l overflow-hidden cg-text-secondary h-12 w-12'>
          <MapPin className='w-6 h-6 cg-text-secondary' weight='duotone' />
        </div>
        <span className='cg-text-md-500 cg-text-main'>
          {event.location}
        </span>
      </div>}

      {/* <div className='flex items-center gap-1 cg-text-lg-400 cg-text-secondary'>
        <span>{startTime.format('MMM D')}</span>
        <span>·</span>
        <span>Starts {startTime.format('HH:mm')}</span>
        <span>·</span>
        {creator && <UserTag
          userData={creator}
          hideStatus
          noOfflineDimming
          jdenticonSize='24'
          largeNameFont
        />}
      </div> */}
      <MemberPreview2
        memberCount={event?.participantCount || 0}
        memberIds={event?.participantIds || []}
        limit={7}
        rightElement="going"
        forceShowRightElement
      />
    </div>;

    const callOptions = <div className='flex flex-col gap-2 items-center'>
      <AttendEventButton
        call={call}
        community={community}
        event={event || undefined}
        hideGoingDropdown
        onUpdateEvent={(eventId, changes) => setEvent(old => {
          if (old) return {
            ...old, ...changes
          }
          return old;
        })}
        className='w-full'
        attendPrimary
      />
      <div className='flex flex-col gap-2 items-center self-stretch'>
        {(isHost || canCreateEvents) && !sidebarMode && !isLive && !hasFinished && <>
          <span className='cg-text-md-500 cg-text-secondary'>{isHost ? 'Host' : 'Management'} Options</span>
          <Button
            role='secondary'
            text='Cancel Event'
            className='event-options-btn w-full'
            iconLeft={<XCircleIcon />}
            onClick={() => setShowDeleteModal(true)}
          />
          {event && <ScheduleEventModal
            key={showScheduleModalKey}
            isOpen={!!showScheduleModalKey}
            onClose={() => setShowScheduleModalKey(0)}
            onAddEvent={onEditEvent}
            isEditMode
            event={event}
          />}
          {canCreateEvents && <Button
            role='secondary'
            text='Edit Event'
            className='event-options-btn w-full'
            iconLeft={<PencilIcon />}
            onClick={editEvent}
          />}
        </>}
        <span className='cg-text-md-500 cg-text-secondary'>Options</span>
        {!hasFinished && event && <>
          <Button
            role='secondary'
            text='Add to Apple iCal'
            className='event-options-btn w-full'
            iconLeft={<AppleIcon />}
            onClick={() => community && downloadICSFile(event, community)}
          />
          <Button
            role='secondary'
            text='Add to Google Calendar'
            className='event-options-btn w-full'
            iconLeft={<GoogleIcon />}
            onClick={() => community && addToGoogleCalendar(event, community)}
          />
        </>}
        <ShareButton
          relativeUrl={event && !!community
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
        />
        {!hasFinished && !isHost && event?.isSelfAttending && <Button
          role='secondary'
          text='Cancel Attendance'
          className='event-options-btn w-full'
          onClick={cancelAttendance}
          iconLeft={<XCircleIcon className='w-5 h-5 cg-text-secondary' />}
        />}
      </div>
    </div>;

    let agenda: JSX.Element | null = null;
    const isAgendaEmpty = event?.description.content.length === 0 ||
      (event?.description.content.length === 1 && event.description.content[0].type === 'text' && event.description.content[0].value.length === 0);

    const hostedBy = <div className='flex flex-wrap cg-text-lg-500 cg-text-main items-center gap-2 select-text'>
      <span>Hosted by</span>
      {creator && <UserTag
        userData={creator}
        hideStatus
        noOfflineDimming
        jdenticonSize='24'
        largeNameFont
      />}
    </div>;

    if (!isAgendaEmpty) {
      agenda = <div className={`flex flex-col gap-4 select-text${isMobile ? ' pb-4' : ''}`}>
        <h3 className='cg-heading-3 cg-text-main'>Agenda</h3>
        {hostedBy}
        {event?.description && <div className='cg-text-lg-400 cg-text-main whitespace-pre-line'>
          <AllContentRenderer
            content={event?.description.content}
          />
        </div>}
      </div>;
    } else {
      agenda = hostedBy;
    }

    if (isTablet) {
      return <div className={`flex flex-col gap-4 ${sidebarMode ? 'px-4 pb-4' : ''}`}>
        {callInfo}
        {callOptions}
        {agenda}
      </div>
    } else if (isMobile) {
      return <div className={`flex flex-col gap-4 ${sidebarMode ? 'px-4 pb-4' : ''}`}>
        {callInfo}
        {callOptions}
        {agenda}
      </div>
    } else {
      return <div className={`flex flex-col gap-6 ${sidebarMode ? 'px-8 pb-8' : ''}`}>
        <div className='flex gap-4'>
          <div className='flex flex-col gap-2 flex-1'>
            {callInfo}
          </div>
          <div className='flex flex-col gap-2 flex-1'>
            {callOptions}
          </div>
        </div>
        {agenda}
      </div>;
    }
  }, [call, canCreateEvents, cancelAttendance, community, creator, editEvent, event, finalTime, gatedState, hasFinished, isHost, isLive, isMobile, isTablet, onEditEvent, showScheduleModalKey, sidebarMode, startTime]);

  return <div className={`event-view ${sidebarMode ? 'sidebarMode' : ''}`}>
    <Scrollable>
      {sidebarMode && !!event && <div className={`flex justify-between absolute top-4 ${isMobile ? 'left-4 right-4' : 'left-8 right-8'}`}>
        <Button
          role="secondary"
          iconLeft={<ArrowLeftIcon className="w-5 h-5" />}
          onClick={goBack}
          className="cg-circular tray-btn"
        />
        <Button
          role="secondary"
          iconLeft={<ArrowsOutSimple weight="duotone" className="w-5 h-5" />}
          text='Go to Event'
          onClick={goToEventPage}
          className="cg-circular tray-btn"
        />
      </div>}
      {!event && isLoading && <div className='p-4 w-full m-auto cg-text-main flex items-center justify-center'>
        <div className='spinner'>
          <SpinnerIcon />
        </div>
      </div>}
      {event && <div className='event-view-content'>
        <div className='event-view-upper'>
          {imageUrl && <img loading='lazy' className={`event-view-image`} src={imageUrl} alt='Event' />}
          {!imageUrl && <div className='event-view-image no-image'>
            {event.type === 'broadcast' && <img className='w-10 h-10' src={MicClayIcon} alt={event.type} />}
            {event.type === 'call' && <img className='w-10 h-10' src={PhoneClayIcon} alt={event.type} />}
            {event.type === 'reminder' && <img className='w-10 h-10' src={MegaphoneClayIcon} alt={event.type} />}
            {event.type === 'external' && <Globe className='w-10 h-10 cg-text-secondary' />}
          </div>}
          {hasFinished && <h2 className='cg-heading-2 cg-text-main w-full text-center'>This event has ended</h2>}
          {content}
        </div>
        {pastCall && <div className='event-view-chat-history-section'>
          <div className='flex items-center gap-4 px-4'>
            <Button
              role='chip'
              text={<h3>Participants</h3>}
              onClick={() => setActiveTab('participants')}
              className={activeTab === 'participants' ? 'active cg-text-md-400' : 'cg-text-md-400'}
            />
            <Button
              role='chip'
              text={<h3>Chat History</h3>}
              onClick={() => setActiveTab('chat')}
              className={activeTab === 'chat' ? 'active cg-text-md-400' : 'cg-text-md-400'}
            />
          </div>
          {activeTab === 'chat' && <div className='event-view-chat-history'>
            <MessageViewInner
              channelId={pastCall.channelId}
              communityId={pastCall.communityId}
              hideInput={true}
            />
          </div>}
          {activeTab === 'participants' && <div className='event-view-participants'>
            <Scrollable>
              <ParticipantsList callId={pastCall.id} />
            </Scrollable>
          </div>}
        </div>}
      </div>}
      <ScreenAwareModal
        hideHeader
        isOpen={showDeleteModal}
        onClose={() => setShowDeleteModal(false)}
        footerActions={<>
          <Button
            role='secondary'
            text='Keep'
            onClick={() => setShowDeleteModal(false)}
          />
          <Button
            role='destructive'
            text='Cancel event'
            onClick={deleteEvent}
          />
        </>}
      >
        <span className='cg-text-main cg-heading-3'>Are you sure you want to cancel this event? Please note attendees will not receive a notification yet</span>
      </ScreenAwareModal>
      <ScreenAwareModal
        isOpen={!event && !isLoading}
        onClose={() => { }}
        hideHeader
      >
        <div className='flex flex-col gap-4 p-4 items-center justify-center'>
          <h3 className='cg-heading-3 cg-text-main'>Sorry, this event does not exist or was cancelled</h3>
          <Button
            role='primary'
            text={'Got it'}
            onClick={() => community && navigate(getUrl({ type: 'community-events', community }))}
          />
        </div>
      </ScreenAwareModal>
    </Scrollable>
  </div>;
}

export default React.memo(Event);