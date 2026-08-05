// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './ScheduleEventModal.css';
import React, { useEffect, useMemo, useState } from 'react'
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import TextAreaField from 'components/molecules/inputs/TextAreaField/TextAreaField';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import Button from 'components/atoms/Button/Button';
import { InformationCircleIcon, MicrophoneIcon } from '@heroicons/react/20/solid';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import DateTimeField from 'components/molecules/inputs/DateTimeField/DateTimeField';
import dayjs from 'dayjs';
import communityApi from 'data/api/community';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import ImageUploadField from 'components/molecules/inputs/ImageUploadField/ImageUploadField';
import fileApi from 'data/api/file';
import errors from 'common/errors';
import { isImageContentRejected } from 'moderation/imageUploadError';
import ToggleInputField from 'components/molecules/inputs/ToggleInputField/ToggleInputField';
import RolePermissionToggle, { PermissionType } from 'components/molecules/RolePermissionToggle/RolePermissionToggle';
import { PredefinedRole } from 'common/enums';
import { useOwnUser } from 'context/OwnDataProvider';
import { useSnackbarContext } from 'context/SnackbarContext';
import { convertContentToPlainText } from 'common/converters';
import { useSignedUrl } from 'hooks/useSignedUrl';
import { Globe, Headphones } from "@phosphor-icons/react";
import { linkRegexGenerator } from 'common/validators';
import CallConfigurationToggle, { IConfig } from '../StartCallModal/CallConfigurationToggle/CallConfigurationToggle';
import { useCommunityPremiumTier } from 'hooks/usePremiumTier';
import config from 'common/config';

const onlyLinkRegex = linkRegexGenerator();

type Props = {
  isOpen: boolean;
  onClose: () => void;
  onAddEvent: (event: API.Community.getEvent.Response) => void;
  isEditMode?: boolean;
  event?: API.Community.getEvent.Response;
};

export function toPermissionType(permissions: Common.CommunityEventPermission[]): PermissionType {
  if (permissions.includes('EVENT_MODERATE')) return 'moderate';
  else if (permissions.includes('EVENT_ATTEND')) return 'full';
  else if (permissions.includes('EVENT_PREVIEW')) return 'preview';
  else return 'none';
}

export function eventPermissionsToPermissionType(eventPermissions: Models.Community.Event['rolePermissions']): Record<string, PermissionType> {
  return eventPermissions.reduce((acc, permission) => {
    // Don't convert admin, we won't modify it and won't send it either
    if (permission.roleTitle === PredefinedRole.Admin) return acc;

    return {
      ...acc,
      [permission.roleId]: toPermissionType(permission.permissions)
    }
  }, {});
}

function permissionTypeToEventPermissions(
  roles: readonly Models.Community.Role[],
  permissions: Record<string, PermissionType>,
  // defaultPermissions: Models.Community.Event['rolePermissions']
): Models.Community.Event['rolePermissions'] {
  const eventPermissions = Object.keys(permissions).map(roleId => {
    if (permissions[roleId] === 'none') return null;

    const newPermissions: Common.CommunityEventPermission[] = ['EVENT_PREVIEW'];
    if (permissions[roleId] === 'full') newPermissions.push('EVENT_ATTEND');
    else if (permissions[roleId] === 'moderate') newPermissions.push('EVENT_ATTEND', 'EVENT_MODERATE');

    const role = roles.find(role => role.id === roleId);

    return {
      roleId: roleId,
      roleTitle: role?.title || '',
      permissions: newPermissions
    }
  });

  const filteredPermissions = eventPermissions.filter(p => !!p) as Models.Community.Event['rolePermissions'];

  return filteredPermissions;
  // if (!channelHasCustomPermissions(filteredPermissions)) {
  //   return defaultPermissions;
  // } else {
  //   return filteredPermissions;
  // }
}

const ScheduleEventModal: React.FC<Props> = (props) => {
  const { isOpen, onClose, onAddEvent } = props;
  const { community, roles, ownRoles } = useLoadedCommunityContext();
  const { isMobile } = useWindowSizeContext();
  const { showSnackbar } = useSnackbarContext();
  const ownUser = useOwnUser();
  const [title, setTitle] = useState('');
  const [agenda, setAgenda] = useState('');
  const [externalUrl, setExternalUrl] = useState('');
  const [showLocationInput, setShowLocationInput] = useState(false);
  const [location, setLocation] = useState('');
  const [banner, setBanner] = useState<File | undefined | null>(null);
  // 'call' and 'broadcast' both need the media server; without it an external
  // event (a plain link) is the only type that can actually happen
  const [eventType, setEventType] = useState<Models.Community.EventType>(config.CALLS_ENABLED ? 'call' : 'external');
  const [startDatetime, setStartDatetime] = useState<dayjs.Dayjs>(dayjs());
  const [endDatetime, setEndDatetime] = useState<dayjs.Dayjs>(dayjs());
  const [enableCustomRoles, setEnableCustomRoles] = useState(false);
  const [isSending, setIsSending] = useState(false);

  const { premium } = community;
  const { tierData } = useCommunityPremiumTier(premium);

  const [callConfig, setCallConfig] = useState<IConfig>({
    stageLimit: tierData.BROADCASTERS_SLOTS,
    overallCallLimit: tierData.CALL_STANDARD,
    highDefinition: false,
    audioOnly: false,
  });
  let imageUrl = useSignedUrl(props.event?.imageId);

  const canCreateCustomCalls = ownRoles.some((r) =>
    r.permissions.includes("WEBRTC_CREATE_CUSTOM")
  );

  const duration = useMemo(() => endDatetime.diff(startDatetime, 'minutes'), [endDatetime, startDatetime]);
  const durationString = useMemo(() => {
    if (duration < 60) return `${duration}m`;
    else return `${Math.floor(duration / 60)}h ${duration % 60}m`
  }, [duration]);

  const defaultPermission = useMemo(() => {
    return [
      {
        roleId: roles.find(role => role.title === PredefinedRole.Public)?.id,
        roleTitle: PredefinedRole.Public,
        permissions: ['EVENT_PREVIEW']
      },
      {
        roleId: roles.find(role => role.title === PredefinedRole.Member)?.id,
        roleTitle: PredefinedRole.Member,
        permissions: ['EVENT_PREVIEW', 'EVENT_ATTEND']
      },
    ] as Models.Community.Event['rolePermissions'];
  }, [roles]);
  const [rolesPermissions, setRolesPermissions] = useState<Record<string, PermissionType>>(eventPermissionsToPermissionType(defaultPermission));

  useEffect(() => {
    // load event if is edit mode
    if (props.isEditMode && props.event) {
      const eventDescription = convertContentToPlainText(props.event.description.content);
      setTitle(props.event.title);
      setAgenda(eventDescription);
      setStartDatetime(dayjs(props.event.scheduleDate));
      setEndDatetime(dayjs(props.event.scheduleDate).add(props.event.duration, 'minutes'));
      setEventType(props.event.type);
      setExternalUrl(props.event.externalUrl || '');
      setShowLocationInput(!!props.event.location);
      setLocation(props.event.location || '');
      if (props.event.rolePermissions) {
        setEnableCustomRoles(true);
        setRolesPermissions(eventPermissionsToPermissionType(props.event.rolePermissions));
      }

      const getCall = async () => {
        if (props.event?.callId) {
          const call = await communityApi.getCall({id: props.event.callId, communityId: props.event.communityId});
          if (call) {
            setCallConfig({
              audioOnly: call.audioOnly,
              highDefinition: call.highQuality,
              overallCallLimit: call.slots,
              stageLimit: call.stageSlots,
            });
          }
        }
      }
      getCall();
    }
  }, [props.isEditMode, props.event]);

  const updatedUrl = useMemo(() => {
    if (banner) {
      const bannerUrl = URL.createObjectURL(banner);
      return bannerUrl;
    } else {
      return imageUrl;
    }
  }, [banner, imageUrl]);

  const onScheduleEvent = async () => {
    if (title.length === 0) {
      showSnackbar({ type: 'warning', text: 'Event title cannot be empty, please add a title.' });
      return;
    }

    if (startDatetime.isBefore(dayjs())) {
      showSnackbar({ type: 'warning', text: 'Cannot schedule an event in the past, please pick a new date.' });
      return;
    }

    if (endDatetime.isBefore(startDatetime)) {
      showSnackbar({ type: 'warning', text: 'Cannot schedule with start time happening after end time.' });
      return;
    }

    if (duration > 60 * 8) {
      showSnackbar({ type: 'warning', text: 'Cannot schedule events longer than 8 hours in duration.' });
      return;
    }

    if (eventType === 'external' && (externalUrl.length === 0 || !externalUrl.match(onlyLinkRegex))) {
      showSnackbar({ type: 'warning', text: 'Cannot schedule external event without a valid external url.' });
      return;
    }

    try {
      setIsSending(true);
      if (props.isEditMode && props.event) {
        const response = await updateEvent();

        onAddEvent(response);
        showSnackbar({ type: 'info', text: 'The event was updated' });
        onClose();
        return;
      } else {
        const response = await insertNewEvent();

        onAddEvent({
          ...response,
          isSelfAttending: true,
          participantCount: 1,
          participantIds: [ownUser?.id || '']
        });

        showSnackbar({ type: 'info', text: 'The event was scheduled' });
        onClose();
      }
    } catch (e: any) {
      showSnackbar({
        type: 'warning',
        text: isImageContentRejected(e)
          ? errors.client.IMAGE_CONTENT_REJECTED
          : `Something went wrong, code error: ${e.message}`,
      });
    } finally {
      setIsSending(false);
    }
  };

  const insertNewEvent = async (): Promise<Models.Community.Event> => {
    let newImageId: string | null = null;

    if (banner) {
      const result = await fileApi.uploadImage({ type: 'articleImage' }, banner);
      newImageId = result.largeImageId || result.imageId;
    }

    const response = await communityApi.createCommunityEvent({
      communityId: community.id,
      description: agenda,
      duration,
      type: eventType,
      imageId: newImageId,
      scheduleDate: startDatetime.toISOString(),
      title,
      url: null,
      rolePermissions: permissionTypeToEventPermissions(roles, rolesPermissions),
      externalUrl: externalUrl || null,
      location: location || null,
      callData: {
        audioOnly: callConfig.audioOnly,
        hd: callConfig.highDefinition,
        slots: callConfig.overallCallLimit,
        stageSlots: callConfig.stageLimit,
      }
    });
    return response;
  }

  const updateEvent = async (): Promise<API.Community.updateCommunityEvent.Response> => {
    if (!props.event) throw new Error('Event is not defined');
    let imageId: string | null = null;
    if (banner) {
      const result = await fileApi.uploadImage({ type: 'articleImage' }, banner);
      imageId = result.largeImageId || result.imageId;
    } else if (imageUrl) {
      imageId = props.event.imageId;
    }

    const response = await communityApi.updateCommunityEvent({
      id: props.event.id,
      description: agenda,
      duration,
      type: eventType,
      imageId,
      scheduleDate: startDatetime.toISOString(),
      title,
      rolePermissions: permissionTypeToEventPermissions(roles, rolesPermissions),
      externalUrl: eventType === 'external' ? externalUrl || null : null,
      location: eventType === 'external' ? location || null : null,
      callData: {
        stageSlots: callConfig.stageLimit,
        audioOnly: callConfig.audioOnly,
        hd: callConfig.highDefinition,
        slots: callConfig.overallCallLimit
      }
    });
    return response;
  }

  const eventTypeSection = useMemo(() => {
    return <div className='flex flex-col gap-2'>
      <span className='cg-text-main cg-text-lg-500'>Event Type</span>
      <div className='flex flex-wrap gap-2'>
        {config.CALLS_ENABLED && <Button
          iconLeft={<Headphones weight='fill' className='w-5 h-5' />}
          text='Group Call'
          role='chip'
          className={eventType === 'call' ? 'active' : undefined}
          onClick={() => setEventType('call')}
        />}
        {config.CALLS_ENABLED && <Button
          iconLeft={<MicrophoneIcon className='w-5 h-5' />}
          text='Broadcast'
          role='chip'
          className={eventType === 'broadcast' ? 'active' : undefined}
          onClick={() => setEventType('broadcast')}
        />}
        <Button
          iconLeft={<Globe className='w-5 h-5' />}
          text='External'
          role='chip'
          className={eventType === 'external' ? 'active' : undefined}
          onClick={() => setEventType('external')}
        />
        {/* <Button
            text='Reminder'
            role='chip'
            className={eventType === 'reminder' ? 'active' : undefined}
            onClick={() => setEventType('reminder')}
          /> */}
      </div>
      <div className='flex items-center p-2 gap-2 cg-text-md-400 cg-text-secondary cg-bg-subtle-active cg-text-brand cg-border-l'>
        <InformationCircleIcon className='w-5 h-5' />
        {eventType === 'call' && <span>In Group Calls, anyone can speak</span>}
        {eventType === 'broadcast' && <span>In Broadcasts, you decide who can speak</span>}
        {eventType === 'external' && <span>{config.CALLS_ENABLED
          ? 'In external events, no call will be created'
          : 'Calls are disabled on this instance, so events can only link to an external location'}</span>}
      </div>
    </div>
  }, [eventType]);

  return (<ScreenAwareModal
    isOpen={isOpen}
    onClose={onClose}
    title={props.isEditMode ? 'Update Event' : 'Schedule Event'}
    footerActions={<Button
      loading={isSending}
      className={isMobile ? 'w-full' : undefined}
      role='primary'
      text={props.isEditMode ? 'Update Event' : 'Schedule Event'}
      onClick={onScheduleEvent}
    />}
  >
    <div className={`flex flex-col gap-6${isMobile ? ' pt-4 px-4' : ''}`}>
      <div className='flex flex-col gap-4'>
        <TextInputField
          value={title}
          onChange={setTitle}
          label='Event Name'
          placeholder='e.g. Daily Standup'
          tabIndex={1}
          maxLetters={100}
          error={title.length === 100 ? 'Max length reached' : undefined}
        />

        <TextAreaField
          value={agenda}
          onChange={setAgenda}
          label='Agenda'
          placeholder={`What is this about?`}
          maxLetters={2000}
          autoGrow
          tabIndex={2}
          error={agenda.length === 2000 ? 'Max length reached' : undefined}
        />
      </div>
      {eventTypeSection}
      <ImageUploadField
        label='Event Banner'
        subLabels={['Optional']}
        imageURL={updatedUrl}
        onChange={setBanner}
        imagePreviewStyle={{ height: 'unset', width: '100%', aspectRatio: '720 / 320' }}
      />

      <div className='flex flex-col gap-6'>
        <div className={`flex flex-col gap-2${!isMobile ? ' flex-1' : ''}`}>
          <span className='cg-text-lg-500 cg-text-main'>Start time</span>
          <DateTimeField
            value={startDatetime}
            onChange={setStartDatetime}
            minValueNow
            step={60 * 15} // 15 minutes
          />
        </div>
        <div className={`flex flex-col gap-2${!isMobile ? ' flex-1' : ''}`}>
          <span className='cg-text-lg-500 cg-text-main'>End time</span>
          <DateTimeField
            value={endDatetime}
            onChange={setEndDatetime}
            minValue={startDatetime}
            step={60 * 15} // 15 minutes
          />
        </div>
        <div className='flex flex-col gap-2'>
          <span className='cg-text-lg-500 cg-text-main'>Duration</span>
          <span className='cg-text-lg-500 cg-text-secondary'>{durationString}</span>
        </div>
      </div>

      {eventType === 'external' && <>
        <TextInputField
          label='Meeting Link'
          placeholder='Zoom, Google Meet, ...'
          value={externalUrl}
          onChange={setExternalUrl}
          tabIndex={6}
          maxLetters={200}
          error={agenda.length === 200 ? 'Max length reached' : undefined}
        />
        {!showLocationInput && <Button
          className='w-fit'
          text='Add venue address'
          role='chip'
          onClick={() => setShowLocationInput(true)}
        />}
        {!!showLocationInput && <TextInputField
          label={<div className='flex gap-1'>Venue Address <span className='cg-text-secondary'>(optional)</span></div>}
          placeholder='Example Street, USA'
          value={location}
          onChange={setLocation}
          tabIndex={6}
          maxLetters={200}
          error={agenda.length === 200 ? 'Max length reached' : undefined}
        />}
      </>}

      {canCreateCustomCalls && eventType !== 'external' && (
        <CallConfigurationToggle
          premiumConfig={tierData}
          isBroadcast={eventType === 'broadcast'}
          callConfig={callConfig}
          setCallConfig={setCallConfig}
        />
      )}

      <div className='event-roles-container flex flex-col p-4 gap-4 cg-border-l'>
        <div className='flex items-center gap-2 self-stretch' onClick={() => setEnableCustomRoles(old => !old)}>
          <div className='flex flex-col justify-center items-start flex-1'>
            <span className='self-stretch cg-text-lg-500 cg-text-main'>Restrict Event</span>
            <span className='self-stretch cg-text-md-400 cg-text-secondary'>Set permissions for Roles in your community</span>
          </div>
          <ToggleInputField toggled={enableCustomRoles} />
        </div>
        {enableCustomRoles && <RolePermissionToggle
          availablePermissions={['none', 'preview', 'full', 'moderate']}
          roles={roles}
          rolesPermissions={rolesPermissions}
          setRolesPermissions={setRolesPermissions}
        />}
      </div>
    </div>
  </ScreenAwareModal>);
}

export default React.memo(ScheduleEventModal);