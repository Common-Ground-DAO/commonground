// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import VoiceChannelDescription from '../../../components/molecules/VoiceChannelDescription/VoiceChannelDescription';
import { AudioManagerButtons } from '../../../components/molecules/AudioManagerButtons/AudioManagerButtons';
import { useCallContext } from "context/CallProvider";

import "./MobileVoiceCallManager.css";
import { useCallback } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { getUrl } from 'common/util';
import { createTranslator } from 'short-uuid';
import { useCommunityListView } from 'context/CommunityListViewProvider';

const short = createTranslator();

type Props = {
}

export default function MobileVoiceCallManager(props: Props) {
    const navigate = useNavigate();
    const { isConnected, call, communityId } = useCallContext();
    const { pathname } = useLocation();

    const community = useCommunityListView(communityId);

    const navigateToCall = useCallback(() => {
        if (community && call) {
            navigate(getUrl({ type: 'community-call', community, call }));
        }
    }, [call, community, navigate]);

    if (!call) return null;    
    const regex = new RegExp('/call/([a-z0-9]+)', 'i');
    const result = regex.exec(pathname);
    if (result?.[1] && short.toUUID(result[1]) === call.id) return null;
    
    return (
        <div className={`mobile-voice-call-manager ${isConnected ? 'active' : ''}`} onClick={navigateToCall}>
            {isConnected && <VoiceChannelDescription callName={call.title} communityId={call.communityId} />}
            <AudioManagerButtons />
        </div>
    );
}