// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import config from 'common/config';
import Button from '../Button/Button';
import { CheckIcon, ChevronDownIcon, LockClosedIcon } from '@heroicons/react/20/solid';
import { useCallContext } from 'context/CallProvider';
import { useNavigate } from 'react-router-dom';
import { getUrl } from 'common/util';
import communityApi from 'data/api/community';
import { useOwnUser } from 'context/OwnDataProvider';
import { useLiveQuery } from 'dexie-react-hooks';
import communityDatabase from 'data/databases/community';
import { useUserOnboardingContext } from 'context/UserOnboarding';
import JoinCommunityButton from '../JoinCommunityButton/JoinCommunityButton';
import dayjs from 'dayjs';
import ScreenAwarePopover from '../ScreenAwarePopover/ScreenAwarePopover';
import AttendEventButtonDropdown from './AttendEventButtonDropdown';
import GatedDialogModal, { CalculatedPermission } from 'components/organisms/GatedDialogModal/GatedDialogModal';
import { PredefinedRole } from 'common/enums';
import { useSnackbarContext } from 'context/SnackbarContext';
import { useExternalModalContext } from 'context/ExternalModalProvider';
import { useEmailConfirmationContext } from 'context/EmailConfirmationProvider';

type Props = {
  onUpdateEvent: (eventId: string, eventChanges: Partial<Models.Community.Event>) => void;
  event: API.Community.getEvent.Response | undefined;
  community: Models.Community.ListView | undefined;
  call: Models.Calls.Call | undefined;
  className?: string;
  attendPrimary?: boolean;
  hideGoingDropdown?: boolean;
};

export function calculateEventPermissions(community: Models.Community.DetailView, event: Models.Community.Event): CalculatedPermission {
  const { rolePermissions } = event;
  const publicPermission = rolePermissions.find(permission => permission.roleTitle === PredefinedRole.Public);
  const publicCanAttend = publicPermission?.permissions.find(permission => permission === 'EVENT_ATTEND');
  if (publicCanAttend) return null;

  // If any of my roles has access, don't need to check further
  if (community?.myRoleIds.some(roleId => rolePermissions.some(rolePermission => rolePermission.roleId === roleId && rolePermission.permissions.includes('EVENT_ATTEND')))) {
    return null;
  }

  const memberPermission = rolePermissions.find(permission => permission.roleTitle === PredefinedRole.Member);
  const memberCanAttend = memberPermission?.permissions.find(permission => permission === 'EVENT_ATTEND');
  // Also ask for community join if not part of the community
  if (!community || memberCanAttend) return {
    type: 'community',
    communityId: community.id
  };

  return {
    type: 'roles',
    communityId: community.id,
    rolePermissions: rolePermissions.filter(role => role.permissions.includes('EVENT_ATTEND')),
  };
}

const AttendEventButton: React.FC<Props> = (props) => {
  const {
    call,
    community,
    event,
    onUpdateEvent,
    className,
    attendPrimary
  } = props;
  const navigate = useNavigate();
  const { joinCall } = useCallContext();
  const { showSnackbar } = useSnackbarContext();
  const { setUserOnboardingVisibility } = useUserOnboardingContext();
  const { openModal } = useEmailConfirmationContext();
  const ownUser = useOwnUser();
  const { showModal } = useExternalModalContext();
  const [gatedDialogOpen, setGatedDialogOpen] = useState(false);
  const ownCommunities = useLiveQuery(async () => communityDatabase.getOwnCommunities(), []);
  const detailedCommunity = useLiveQuery(async () => {
    const foundCommunity = ownCommunities?.find(comm => comm.id === community?.id);
    if (foundCommunity) return foundCommunity;
    if (community?.id) return communityDatabase.getCommunityDetailView(community?.id);
  }, [ownCommunities, community?.id]);

  const gatedState = useMemo(() => {
    if (detailedCommunity && event) return calculateEventPermissions(detailedCommunity, event);
  }, [detailedCommunity, event]);

  const ownRoles = useLiveQuery(async () => {
    const community = ownCommunities?.find(comm => comm.id === event?.communityId);
    if (!community) return [];

    const communityRoles = await communityDatabase.getRoles(event?.communityId || '');
    return communityRoles.filter(commRole => community?.myRoleIds.includes(commRole.id));
  }, [ownCommunities, event?.communityId]);
  const [isOnTime, setEventStatus] = useState<boolean>(false);

  const isLive = !!call;

  const hasFinished = useMemo(() => {
    if (!event) return false;
    const startTime = dayjs(event.scheduleDate);
    const finalTime = startTime.add(event.duration, 'minutes');
    return !isLive && finalTime.isBefore(dayjs());
  }, [event, isLive]);

  const externalIsLive = useMemo(() => {
    if (event?.type !== 'external') return false;
    return dayjs().isAfter(dayjs(event.scheduleDate)) && !hasFinished;
  }, [event, hasFinished]);

  useEffect(() => {
    if (event) {
      const checkEventStatus = () => {
        const now = dayjs();
        const start = dayjs(event.scheduleDate);
        const end = start.add(event.duration, 'minutes');
        const gracePeriodStart = start.subtract(15, 'minutes');

        if (now.isAfter(gracePeriodStart) && now.isBefore(end)) {
          setEventStatus(true);
        } else {
          setEventStatus(false);
        }
      };

      // Check the event status immediately
      checkEventStatus();

      // Then check the event status every second
      const intervalId = setInterval(checkEventStatus, 1000);

      // Clean up the interval when the component unmounts or the event changes
      return () => clearInterval(intervalId);
    }
  }, [event]);

  const hasCommunityManageEventPermission = ownRoles?.some(role => role.permissions.includes('COMMUNITY_MANAGE_EVENTS'));
  const hasEventManagePermission = event?.rolePermissions?.some(rolePermission =>
    rolePermission.permissions.includes('EVENT_MODERATE') &&
    ownRoles?.find(role => role.id === rolePermission.roleId)
  );
  const hasPermission = hasCommunityManageEventPermission || hasEventManagePermission;

  const onJoinCall = useCallback((ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (event?.type === 'external' && event.externalUrl) {
      showModal(event.externalUrl);
    } else if (!config.CALLS_ENABLED) {
      showSnackbar({ type: 'warning', text: 'Calls are disabled on this instance' });
    } else if (call && community) {
      if (call.slots >= call.callMembers) {
        showSnackbar({type: 'warning', text: 'This call is full'});
        return;
      }
      
      if(call.callMembers >= call.slots){
        showSnackbar({ type: 'warning', text: 'This call is full' });
        return;
      }
      joinCall(call);
      navigate(getUrl({ type: 'community-call', community, call }));
    }
  }, [call, community, event?.externalUrl, event?.type, joinCall, navigate, showModal, showSnackbar]);

  const onStartEvent = useCallback(async (ev: React.MouseEvent) => {
    ev.stopPropagation();
    if (!event) return;
    if (!community) return;

    try {
      const scheduledCall = await communityApi.startScheduledCall({ communityEventId: event.id });
      joinCall(scheduledCall);
      navigate(getUrl({ type: 'community-call', community, call: scheduledCall }));
    } catch (error) {
      // the backend rejects with SERVICE_UNAVAILABLE when no call server is
      // reachable — say so instead of leaving a button that does nothing
      console.error('Error starting event:', error);
      showSnackbar({ type: 'warning', text: 'The event could not be started because no call server is available' });
    }
  }, [community, event, joinCall, navigate, showSnackbar]);

  const attendEvent = useCallback(async (ev?: React.MouseEvent) => {
    ev?.stopPropagation();
    if (!event) return;

    if (!ownUser) {
      setUserOnboardingVisibility(true);
      return;
    }

    // on instances without email delivery, verification is impossible —
    // don't gate attendance on it
    if (!ownUser.emailVerified && config.EMAIL_ENABLED) {
      openModal('signup');
      return;
    }

    await communityApi.addEventParticipant({ eventId: event.id });

    onUpdateEvent(event.id, {
      isSelfAttending: true,
      participantCount: Number(event.participantCount) + 1,
      participantIds: event.participantIds.length < 6 ? [...event.participantIds, ownUser?.id || ''] : event.participantIds
    });
  }, [event, onUpdateEvent, openModal, ownUser, setUserOnboardingVisibility]);

  if (hasFinished) return null;

  if (event && !ownCommunities?.find(comm => comm.id === event.communityId) && gatedState?.type === 'community') {
    return <JoinCommunityButton
      community={detailedCommunity}
      text='Attend'
      className={className}
      role={attendPrimary ? 'primary' : 'secondary'}
      onSuccess={attendEvent}
    />
  }

  if (gatedState) {
    return <>
      <Button
        onClick={(ev) => {
          ev.stopPropagation();
          setGatedDialogOpen(true);
        }}
        role='secondary'
        text='Locked'
        className={className}
        iconLeft={<LockClosedIcon className='w-5 h-5' />}
      />
      {gatedDialogOpen && <div onClick={ev => ev.stopPropagation()}>
        <GatedDialogModal
          isOpen={gatedDialogOpen}
          requiredPermissions={gatedState}
          onClose={(redirect) => {
            setGatedDialogOpen(false);
          }}
        />
      </div>}
    </>;
  }

  if ((isLive && config.CALLS_ENABLED) || (event?.type === 'external' && externalIsLive)) {
    return <Button
      role='primary'
      text='Join now'
      className={className}
      onClick={onJoinCall}
      disabled={event?.type !== 'external' && (call?.slots || 0) >= (call?.callMembers || 0)}
    />;
  } else if (isOnTime && hasPermission && event?.type !== 'external' && config.CALLS_ENABLED) {
    return <Button
      role='primary'
      text='Start Event'
      className={className}
      onClick={onStartEvent}
    />;
  }

  if (event?.isSelfAttending) {
    if (props.hideGoingDropdown) {
      return <Button
        role='chip'
        text={event.eventCreator === ownUser?.id ? "You're hosting" : "You're going"}
        iconLeft={<CheckIcon className='w-5 h-5' />}
        className={className}
      />
    } else {
      return <ScreenAwarePopover
        triggerType='click'
        closeOn='toggleOrClick'
        placement='bottom-end'
        tooltipContent={<AttendEventButtonDropdown
          event={event}
          onUpdateEvent={onUpdateEvent}
        />}
        offset={8}
        triggerClassName='flex justify-center'
        triggerContent={<Button
          role='chip'
          text={event.eventCreator === ownUser?.id ? "You're hosting" : "You're going"}
          iconLeft={<CheckIcon className='w-5 h-5' />}
          iconRight={<ChevronDownIcon className='w-5 h-5' />}
          className={className}
        />}
      />;
    }
  } else {
    return <Button
      role={attendPrimary ? 'primary' : 'secondary'}
      text='Attend'
      onClick={attendEvent}
      className={className}
    />;
  }
}

export default React.memo(AttendEventButton);