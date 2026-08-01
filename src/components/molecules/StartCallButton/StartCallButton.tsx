// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { CalendarIcon, PhoneIcon } from "@heroicons/react/20/solid";

import './StartCallButton.css';
import { useLoadedCommunityContext } from "context/CommunityProvider";
import { useCallback, useMemo, useState } from "react";
import { StartCallModal } from "components/organisms/StartCallModal/StartCallModal";
import ScheduleEventModal from "components/organisms/ScheduleEventModal/ScheduleEventModal";
import { useNavigate } from "react-router-dom";
import { getUrl } from "common/util";
import config from "common/config";

type StartCallButtonProps = {};

export default function StartCallButton(props: StartCallButtonProps) {
  const navigate = useNavigate();
  const { community, communityPermissions } = useLoadedCommunityContext();
  const [isStartCallOpen, setIsStartCallOpen] = useState(false);
  const [isScheduleOpen, setIsScheduleOpen] = useState(false);

  // instances deployed without the mediasoup service cannot host calls at all
  const canCreateCalls = config.CALLS_ENABLED && communityPermissions.has('WEBRTC_CREATE');
  const canCreateEvents = communityPermissions.has('COMMUNITY_MANAGE_EVENTS');

  const openStartCall = useCallback(() => setIsStartCallOpen(true), []);
  const openSchedule = useCallback(() => setIsScheduleOpen(true), []);
  const closeStartCall = useCallback(() => setIsStartCallOpen(false), []);
  const closeSchedule = useCallback(() => setIsScheduleOpen(false), []);

  const onAddEvent = useCallback((event: Models.Community.Event) => navigate(getUrl({type: 'event', community, event})), [community.url]);

  const createCallContent = useMemo(() => {
    if (canCreateCalls) {
      return <>
        <div className="start-call-button flex-1" onClick={openStartCall}>
          {<PhoneIcon className='w-5 h-5 cg-text-secondary' />}
          <span className='flex cg-text-md-500'>Start Call</span>
        </div >
        <StartCallModal onClose={closeStartCall} open={isStartCallOpen} title="Start a call" />
      </>;
    }
    else {
      return null;
    }
  }, [canCreateCalls, isStartCallOpen]);

  const createEventsContent = useMemo(() => {
    if (canCreateEvents) {
      return <>
        <div className="start-call-button flex-1" onClick={openSchedule}>
          {<CalendarIcon className='w-5 h-5 cg-text-secondary' />}
          <span className='flex cg-text-md-500'>Schedule</span>
        </div>
        <ScheduleEventModal
          key={isScheduleOpen ? 1 : 0}
          onClose={closeSchedule}
          isOpen={isScheduleOpen}
          onAddEvent={onAddEvent}
        />
      </>;
    }
    else {
      return null;
    }
  }, [canCreateEvents, isScheduleOpen]);

  return useMemo(() => {
    if (!createCallContent && !createEventsContent) return null;
    
    return (
      <div className="flex py-2 px-3 gap-2">
        {createCallContent}
        {createEventsContent}
      </div>
    );
  }, [createCallContent, createEventsContent]);
}
