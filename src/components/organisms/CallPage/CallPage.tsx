// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './CallPage.css';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useCallContext } from 'context/CallProvider';
import data from 'data';
import { useNavigate, useParams } from 'react-router-dom';
import dayjs from 'dayjs';
import relativeTime from 'dayjs/plugin/relativeTime';
import { useLoadedCommunityContext } from 'context/CommunityProvider';
import { CallWidget } from './CallWidget';
import { getUrl } from 'common/util';
import { useMultipleUserData } from 'context/UserDataProvider';
import MessageViewInner from 'views/MessageViewInner/MessageViewInner';
import { createTranslator } from 'short-uuid';
import EmptyState from 'components/molecules/EmptyState/EmptyState';
import Button from 'components/atoms/Button/Button';
import { CallType, PredefinedRole } from 'common/enums';
import CallHeader from './CallHeader/CallHeader';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import AudienceList from './AudienceList/AudienceList';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import JoinCommunityButton from 'components/atoms/JoinCommunityButton/JoinCommunityButton';
import ReactionPicker from './ReactionPicker/ReactionPicker';
import { useSnackbarContext } from 'context/SnackbarContext';

dayjs.extend(relativeTime);
const short = createTranslator();

const CallPage: React.FC = () => {
  const { community, calls, ownRoles } = useLoadedCommunityContext();
  const [isFullscreen, setFullscreen] = useState(false);
  const [showChat, setShowChat] = useState(false);
  const [isMobileFocused, setMobileFocused] = useState(false);
  const { isMobile, isTablet } = useWindowSizeContext();
  const { callId: _urlCallId } = useParams<'callId'>();
  const urlCallId = short.toUUID(_urlCallId as string);
  const { callId, peers, isConnected, joinCall } = useCallContext();
  const [showReactionPicker, setShowReactionPicker] = useState(false);
  const peerIds = Array.from(peers.keys());
  const navigate = useNavigate();
  const containerRef = useRef<HTMLDivElement>(null);
  const { showSnackbar } = useSnackbarContext();

  const isCommunityMember = useMemo(() => {
    return ownRoles.some(role => role.title === PredefinedRole.Member);
  }, [ownRoles]);
  const [showJoinCommunityModal, setShowJoinCommunityModal] = useState(!isCommunityMember);

  const currentCall = useMemo(() => {
    const call = calls.find(c => c.id === urlCallId);
    if (!!call) {
      data.channelManager.registerAccessForChannel({
        callId: call.id,
        channelId: call.channelId,
      });
    }
    return call;
  }, [calls, urlCallId]);

  const __membersInCall = useMultipleUserData(
    (isConnected && urlCallId === callId)
      ? peerIds
      : currentCall?.previewUserIds || []
  );

  const membersInCall = useMemo(() => (
    Object.values(__membersInCall).filter(value => !!value) as Models.User.Data[]
  ), [__membersInCall]);

  useEffect(() => {
    const listener = () => {
      setFullscreen(document.fullscreenElement !== null);
    };
    const container = containerRef.current;
    container?.addEventListener('fullscreenchange', listener);

    return () => {
      container?.removeEventListener('fullscreenchange', listener);
    }
  }, []);

  const trySettingFullscreen = useCallback((fullscreen: boolean) => {
    if (fullscreen) {
      containerRef.current?.requestFullscreen();
    } else {
      document.exitFullscreen();
    }
  }, []);

  const className = [
    'call-page-container',
    isFullscreen ? 'full-screen' : ''
  ].join(' ').trim();

  const renderChatOrAudience = useCallback(() => {
    if (isMobile && currentCall?.callType === 'broadcast' && !showChat) {
      return <Scrollable innerClassName='flex flex-col gap-4 p-4'>
        <AudienceList />
      </Scrollable>;
    }

    return <div className='call-chat'>
      <MessageViewInner
        channelId={currentCall?.channelId || ''}
        hideInput={urlCallId !== callId}
        onMobileFocus={setMobileFocused}
        callMode
      />
    </div>;
  }, [isMobile, currentCall?.callType, currentCall?.channelId, showChat, urlCallId, callId]);

  const onJoinCall = useCallback((currentCall: Models.Calls.Call) => {
    if(currentCall.callMembers >= currentCall.slots){
      showSnackbar({ type: 'warning', text: 'This call is full' });
      return;
    }
    joinCall(currentCall);
  }, [joinCall, showSnackbar]);

  return (
    <div className={className} ref={containerRef}>
      {currentCall && (
        <CallWidget
          channelId={currentCall.channelId}
          isConnected={isConnected && urlCallId === callId}
          membersInCall={membersInCall || []}
          name={currentCall.title}
          roomId={currentCall.id}
          startTime={dayjs(currentCall.startedAt)}
          description={currentCall.description}
          isFullscreen={isFullscreen}
          callType={currentCall.callType as CallType}
          setFullscreen={trySettingFullscreen}
          chatViewVisible={showChat}
          toggleChatView={() => setShowChat(old => !old)}
          onStartCall={() => onJoinCall(currentCall)}
          showReactionPicker={showReactionPicker}
          setShowReactionPicker={setShowReactionPicker}
          mobileCollapsed={isMobile && isMobileFocused}
          callMembers={membersInCall.length}
          callSlots={currentCall.slots}
        />
      )}
      {!currentCall && (
        <div className='flex flex-col gap-4 items-center justify-center col-span-2'>
          <EmptyState
            title='This call has ended or is inaccessible'
            description='No one is left here'
          />
          <Button role='primary' text="Back to lobby" onClick={() => navigate(getUrl({ type: 'community-lobby', community }))} />
        </div>
      )}
      {!!currentCall && (<div className='flex flex-col overflow-hidden relative'>
        {!isMobile && !isTablet && <div className='flex'>
          <CallHeader
            name={currentCall.title}
            description={currentCall.description}
            membersInCall={membersInCall || []}
            roomId={currentCall.id}
            standalone
          />
        </div>}
        {renderChatOrAudience()}
        {isMobile && <ReactionPicker
          showPicker={showReactionPicker}
          closePicker={() => setShowReactionPicker(false)}
        />}
      </div>)}
      <ScreenAwareModal
        isOpen={showJoinCommunityModal}
        onClose={() => setShowJoinCommunityModal(false)}
        title='Join community'
      >
        <div className={`flex flex-col items-center gap-4${isMobile ? ' p-4': ''}`}>
          <span className='cg-heading-3 cg-text-main'>Join the community to see the calls happening here</span>
          <JoinCommunityButton
            className='w-full'
            community={community}
            onSuccess={() => setShowJoinCommunityModal(false)}
          />
        </div>
      </ScreenAwareModal>
    </div>
  );
};

export default CallPage;