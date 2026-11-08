// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import "./VoiceCallManager.css";
import { useNavigate } from "react-router";
import VoiceChannelDescription from "../../../components/molecules/VoiceChannelDescription/VoiceChannelDescription";
import VoiceChannelTalkers from "../../../components/molecules/VoiceChannelTalkers/VoiceChannelTalkers";
import { useWindowSizeContext } from "../../../context/WindowSizeProvider";
import { useCallContext } from "context/CallProvider";
import { useCallback, useMemo } from "react";
import { getUrl } from 'common/util';
import { useCommunityListView } from "context/CommunityListViewProvider";

type Props = {};

export default function VoiceCallManager(props: Props) {
  const { isMobile } = useWindowSizeContext();
  const { call, communityId } = useCallContext();
  const navigate = useNavigate();

  const community = useCommunityListView(communityId);
  
  const navigateToCall = useCallback(() => {
    if (community && call) {
      navigate(getUrl({ type: 'community-call', community, call }));
    }
  }, [call?.id, community?.url, navigate]);

  const result = useMemo(() => {
    if (!call?.id || !community?.url) return null;

    return (
      <div className={`voice-call-manager${isMobile ? " mobile" : ""}`} onClick={navigateToCall}>
        <VoiceChannelDescription callName={call.title} communityId={community.id} />
        <VoiceChannelTalkers callId={call.id} memberLength={3} />
      </div>
    );
  }, [navigateToCall, call?.title, community?.id, isMobile]);

  return result;
}

type SidebarProps = Props & {
  collapsed?: boolean;
}

export function SidebarVoiceCallManager(props: SidebarProps) {
  const { call, communityId } = useCallContext();
  const navigate = useNavigate();

  const community = useCommunityListView(communityId);
  
  const navigateToCall = useCallback(() => {
    if (!!community?.url && !!call?.id) {
      navigate(getUrl({ type: 'community-call', community, call }));
    }
  }, [call?.id, community?.url, navigate]);

  return useMemo(() => {
    if (!call?.id || !community?.url) return null;

    return (
      <div className={`sidebar-voice-call-manager`} onClick={navigateToCall}>
        <VoiceChannelDescription callName={call.title} communityId={community.id} collapsed={props.collapsed} />
        <VoiceChannelTalkers callId={call.id} collapsed={props.collapsed} memberLength={3} />
      </div>
    );
  }, [navigateToCall, call?.title, community?.id, props.collapsed]);
}