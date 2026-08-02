// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo } from "react";
import { useCallContext } from 'context/CallProvider';
import Button from "components/atoms/Button/Button";
import Microphone from '../../../components/atoms/icons/20/Microfon.svg?react';
import { ChatBubbleOvalLeftIcon, Cog6ToothIcon, UserGroupIcon, VideoCameraIcon } from '@heroicons/react/20/solid';
import { VideoCameraSlashIcon } from '@heroicons/react/24/outline';
import { TvIcon } from '@heroicons/react/20/solid';
import { TvIcon as TvIconOutline } from '@heroicons/react/24/outline';
import { ArrowsPointingOutIcon } from '@heroicons/react/24/solid';
import { ArrowsPointingInIcon } from '@heroicons/react/24/solid';
import { HandRaisedIcon } from '@heroicons/react/24/solid';
import { XMarkIcon } from '@heroicons/react/20/solid';
import DisabledMicrophone from '../../../components/atoms/icons/20/MicrofonDisabled.svg?react';
import HangupIcon from '../../../components/atoms/icons/20/Hangup.svg?react';
import { Gavel, PhoneDisconnect } from "@phosphor-icons/react";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import AudioDevicesManagement from "../AudioDevicesManagement/AudioDevicesManagement";
import ScreenAwareDropdown from "components/atoms/ScreenAwareDropdown/ScreenAwareDropdown";
import ListItem from "components/atoms/ListItem/ListItem";

import "./BroadcastActions.css";
import { useLiveQuery } from "dexie-react-hooks";
import data from "data";
import { canModerateCalls } from "./HelperFunctions/callHelpers";

interface CallActionsProps {
    isFullscreen: boolean;
    onLeaveCall?: () => void;
    onFullScreen: () => void;
    chatViewVisible: boolean;
    toggleChatView: () => void;
    showReactionPicker: boolean;
    setShowReactionPicker: (show: boolean) => void;
}

const BroadcastActions: React.FC<CallActionsProps> = (props) => {
    const {
        onLeaveCall,
        onFullScreen,
        chatViewVisible,
        toggleChatView,
        isFullscreen,
        showReactionPicker,
        setShowReactionPicker
    } = props;
    const { call, leaveCall, toggleMute, isMuted, roomClient, me, audioOnly } = useCallContext();
    const { sharingEnabled, webcamEnabled } = me;
    const { isMobile, isTablet } = useWindowSizeContext();
    
    const community = useLiveQuery(() => {
        if (!call) return undefined;
        return data.community.getCommunityDetailView(call.communityId);
    }, [call?.communityId]);

    const roles = useLiveQuery(() => {
        if (!call) return [];
        return data.community.getRoles(call.communityId);
    }, [call?.communityId]);

    const myRoles = useMemo(() => {
        return community?.myRoleIds;
    }, [community?.myRoleIds]);

    const onEndCallClick = useCallback(() => {
        roomClient?.endCallForEveryone(me.id);
    }, [me.id, roomClient]);

    const hasModeratePermissions: boolean = useMemo(()=> {
        if (!call || !community || !myRoles || !me || !roles) return false;
        return canModerateCalls(
            myRoles || [],
            call?.rolePermissions || [],
            roles,
            me.id,
            call.callCreator
        );
    }, [call, community, me, myRoles, roles]);

    const moderateButton = useMemo(() => {
        const moderatorOptions = [
            <ListItem
                key={'end-for-everyone'}
                title='End call for everyone'
                icon={<PhoneDisconnect className="w-5 h-5" />}
                onClick={onEndCallClick}
                className="cg-text-warning w-full"
            />
        ];
        return hasModeratePermissions ? (
            <ScreenAwareDropdown
                triggerContent={<Button
                    className="broadcast-actions-button"
                    iconRight={<Gavel className="w-5 h-5 cg-text-warning" />}
                />}
                items={moderatorOptions}
                className="toggle-options-dropdown"
                title="Moderate"
            />
            
        ) : null;
    }, [hasModeratePermissions, onEndCallClick]);

    const toggleWebcam = useCallback(() => {
        if (me && me.webcamEnabled) {
            roomClient?.disableWebcam();
            return;
        } else {
            roomClient?.enableWebcam();
            return;
        }
    }, [me, roomClient])

    const raiseHand = useCallback(() => {
        if (me && me.isHandRaised) {
            roomClient?.lowerHand(me.id);
            return;
        } else {
            roomClient?.raiseHand(me.id);
            return;
        }
    }, [me, roomClient]);

    const onLeaveCallClick = useCallback(() => {
        leaveCall();
        onLeaveCall && onLeaveCall();
        if (isFullscreen) onFullScreen();
    }, [isFullscreen, leaveCall, onFullScreen, onLeaveCall]);

    const shareDropdownItems: JSX.Element[] = useMemo(() => [
        <ListItem
            title='Start sharing'
            icon={<TvIcon className="w-5 h-5" />}
            disabled={sharingEnabled}
            onClick={() => {
                if (!sharingEnabled) roomClient?.enableShare()
            }}
        />,
        <ListItem
            title='Stop sharing'
            icon={<XMarkIcon className="w-5 h-5" />}
            disabled={!sharingEnabled}
            onClick={() => {
                if (sharingEnabled) roomClient?.disableShare()
            }}
        />
    ], [roomClient, sharingEnabled]);

    const broadcasterButtons = useMemo(() => (
        <>
            <Button
                iconLeft={<>🔥</>}
                onClick={() => setShowReactionPicker(!showReactionPicker)}
                className={`broadcast-actions-button cg-heading-2${showReactionPicker ? ' media-sharing-enabled' : ''}`}
            />
            <Button
                iconLeft={isMuted ? <DisabledMicrophone className="cg-text-error" /> : <Microphone className="" />}
                onClick={toggleMute}
                className={`broadcast-actions-button${isMuted ? '' : ' media-sharing-enabled'}`}
            />
            {!audioOnly && <Button
                iconLeft={webcamEnabled ? <VideoCameraIcon className='w-5 h-5' /> : <VideoCameraSlashIcon className='w-5 h-5' />}
                onClick={toggleWebcam}
                className={`broadcast-actions-button ${webcamEnabled ? 'media-sharing-enabled' : ''}`}
            />}
            {!isMobile && !isTablet && !audioOnly && <ScreenAwareDropdown
                triggerContent={<Button
                    iconLeft={sharingEnabled ? <TvIcon className='w-5 h-5' /> : <TvIconOutline className='w-5 h-5' />}
                    className={`broadcast-actions-button ${sharingEnabled ? 'media-sharing-enabled' : ''}`}
                />}
                items={shareDropdownItems}
                className="toggle-share-dropdown"
            />}
            {!isMobile && !isTablet && <Button
                iconLeft={isFullscreen ? <ArrowsPointingInIcon className="w-5 h-5" /> : <ArrowsPointingOutIcon className="w-5 h-5" />}
                className={`broadcast-actions-button ${isFullscreen ? 'media-sharing-enabled' : ''}`}
                onClick={onFullScreen}
            />}
            {isMobile && <Button
                iconLeft={chatViewVisible ? <UserGroupIcon className="w-5 h-5" /> : <ChatBubbleOvalLeftIcon className="w-5 h-5" />}
                className={`broadcast-actions-button`}
                onClick={toggleChatView}
            />}
            <ScreenAwareDropdown
                triggerContent={<Button
                    iconLeft={<Cog6ToothIcon className='w-5 h-5' />}
                    className="broadcast-actions-button"
                />}
                items={[<AudioDevicesManagement popupMode />]}
                className="toggle-options-dropdown"
            />
            {moderateButton}
        </>
    ), [audioOnly, chatViewVisible, isFullscreen, isMobile, isMuted, isTablet, moderateButton, onFullScreen, setShowReactionPicker, shareDropdownItems, sharingEnabled, showReactionPicker, toggleChatView, toggleMute, toggleWebcam, webcamEnabled]);

    //alter the emoji to open up the emoji picker and only then send the reaction
    const audienceButtons = useMemo(() => (<>
        <Button
            iconLeft={<>🔥</>}
            onClick={() => setShowReactionPicker(!showReactionPicker)}
            className={`broadcast-actions-button cg-heading-2${showReactionPicker ? ' media-sharing-enabled' : ''}`}
        />
        <Button
            iconLeft={me.isHandRaised ? <XMarkIcon className="w-5 h-5" /> : <HandRaisedIcon className="w-5 h-5" />}
            onClick={raiseHand}
            className={`broadcast-actions-button no-fixed-width ${me.isHandRaised ? 'active' : ''}`}
            text={!isMobile ? (me.isHandRaised ? 'Lower hand' : 'Raise hand') : undefined}
        />
        {!isMobile && !isTablet && <Button
            iconLeft={isFullscreen ? <ArrowsPointingInIcon className="w-5 h-5" /> : <ArrowsPointingOutIcon className="w-5 h-5" />}
            className={`broadcast-actions-button ${isFullscreen ? 'active' : ''}`}
            onClick={onFullScreen}
        />}
        {isMobile && <Button
            iconLeft={chatViewVisible ? <UserGroupIcon className="w-5 h-5" /> : <ChatBubbleOvalLeftIcon className="w-5 h-5" />}
            className={`broadcast-actions-button`}
            onClick={toggleChatView}
        />}
        {moderateButton}
    </>), [chatViewVisible, isFullscreen, isMobile, isTablet, me.isHandRaised, moderateButton, onFullScreen, raiseHand, setShowReactionPicker, showReactionPicker, toggleChatView]);

    return useMemo(
      () => (
        <div className="video-call-footer">
          {me.isBroadcaster ? broadcasterButtons : audienceButtons}
          <Button
            role="final"
            className={`broadcast-actions-button-size`}
            iconRight={<HangupIcon className="hangup-icon" />}
            onClick={onLeaveCallClick}
          />
        </div>
      ),
      [me.isBroadcaster, broadcasterButtons, audienceButtons, onLeaveCallClick]
    );
}

export default BroadcastActions;