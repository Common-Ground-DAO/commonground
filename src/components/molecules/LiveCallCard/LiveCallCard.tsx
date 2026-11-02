// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "./LiveCallCard.css";
import { useCallback, useMemo } from "react";
import { useNavigate } from 'react-router';
import { useWindowSizeContext } from '../../../context/WindowSizeProvider';
import { useLiveQuery } from "dexie-react-hooks";
import data from "data";
import { getUrl } from 'common/util';
import VoiceChannelTalkers from "../VoiceChannelTalkers/VoiceChannelTalkers";
import Tag from "components/atoms/Tag/Tag";
import { MicrophoneIcon } from "@heroicons/react/20/solid";
import { CallTimer } from "components/organisms/CallPage/CallTimer";
import dayjs from "dayjs";
import { useUserData } from "context/UserDataProvider";
import Jdenticon from "components/atoms/Jdenticon/Jdenticon";
import { getCommunityDisplayName, getDisplayName } from "../../../util";
import CommunityPhoto from "components/atoms/CommunityPhoto/CommunityPhoto";
import Button from "components/atoms/Button/Button";
import { useCallContext } from "context/CallProvider";
import { useCommunityListView } from "context/CommunityListViewProvider";

type Props = {
  call: Models.Calls.Call;
  hideCommunity?: boolean;
};

export default function LiveCallCard(props: Props) {
  const { call, hideCommunity } = props;
  const navigate = useNavigate();
  const { isMobile } = useWindowSizeContext();
  const community = useCommunityListView(call.communityId);
  const creator = useUserData(call.callCreator);
  const { callId } = useCallContext();
  const isInCall = call.id === callId;

  const navigateToCall = useCallback(() => {
    if (community) {
      navigate(getUrl({ type: 'community-call', community, call }));
    }
  }, [call, community, navigate]);
  const startTime = useMemo(() => dayjs(call.startedAt), [call.startedAt]);

  if (!community) return null;

  return (<div className={`live-call-card${isMobile ? " mobile" : ""}`} onClick={navigateToCall}>
    <div className="flex items-center gap-2">
      <Tag
        variant='live'
        label='Live'
      />
      <div className='flex items-center gap-1 cg-text-secondary'>
        <MicrophoneIcon className='w-5 h-5' />
        <span className='cg-text-md-400'>{call.callType === 'broadcast' ? 'Broadcast' : 'Call'}</span>
      </div>
    </div>
    <div className="flex flex-col gap-2 w-full">
      {!hideCommunity && <div className="flex gap-1 w-full items-center cg-text-secondary cg-text-md-400">
        {community && community.id && <CommunityPhoto community={community} size="tiny-20" noHover />}
        <div className="flex-1 overflow-hidden">
          {getCommunityDisplayName(community, 'w-4 h-4')}
        </div>
      </div>}
      <span className="cg-text-main cg-heading-3 whitespace-nowrap overflow-hidden text-ellipsis">{call.title}</span>
      <div className="flex items-center gap-1">
        <CallTimer startTime={startTime} noBg />
        <span className='cg-text-lg-400 cg-text-secondary'>·</span>
        {creator && <div className='flex items-center justify-center gap-2 cg-text-main overflow-hidden'>
          <Jdenticon userId={creator.id || ''} predefinedSize='24' hideStatus />
          <span className='cg-text-lg-500 overflow-hidden flex-1'>{getDisplayName(creator)}</span>
        </div>}
      </div>
      <VoiceChannelTalkers callId={call.id} />
    </div>
    {!isInCall && <Button
      role="secondary"
      text='Join now'
      className="w-full"
    />}
  </div>
  );
}