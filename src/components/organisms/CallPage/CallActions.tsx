// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo } from "react";
import { useCallContext } from 'context/CallProvider';
import Button from "components/atoms/Button/Button";
import Microphone from '../../../components/atoms/icons/20/Microfon.svg?react';
import { Cog6ToothIcon, VideoCameraIcon } from '@heroicons/react/20/solid';
import { VideoCameraSlashIcon } from '@heroicons/react/24/outline';
import { TvIcon } from '@heroicons/react/20/solid';
import { TvIcon as TvIconOutline } from '@heroicons/react/24/outline';
import { ArrowsPointingOutIcon } from '@heroicons/react/24/solid';
import { ArrowsPointingInIcon } from '@heroicons/react/24/solid';
import { XMarkIcon } from '@heroicons/react/20/solid';
import DisabledMicrophone from '../../../components/atoms/icons/20/MicrofonDisabled.svg?react';
import HangupIcon from '../../../components/atoms/icons/20/Hangup.svg?react';
import { useWindowSizeContext } from "context/WindowSizeProvider";
import AudioDevicesManagement from "../AudioDevicesManagement/AudioDevicesManagement";
import ScreenAwareDropdown from "components/atoms/ScreenAwareDropdown/ScreenAwareDropdown";
import ListItem from "components/atoms/ListItem/ListItem";

import "./CallActions.css";
import { canModerateCalls } from "./HelperFunctions/callHelpers";
import { useLiveQuery } from "dexie-react-hooks";
import data from "data";
import { PhoneDisconnect, Gavel } from "@phosphor-icons/react";

interface CallActionsProps {
    isFullscreen: boolean;
    onLeaveCall?: () => void;
    onFullScreen: () => void;
    showReactionPicker: boolean;
    setShowReactionPicker: (value: boolean) => void;
}

const CallActions: React.FC<CallActionsProps> = ({ onLeaveCall, onFullScreen, isFullscreen, showReactionPicker, setShowReactionPicker }) => {
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
                  className="call-actions-button"
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

    const onLeaveCallClick = useCallback(() => {
        leaveCall();
        onLeaveCall && onLeaveCall();
        if (isFullscreen) onFullScreen();
    }, [isFullscreen, leaveCall, onFullScreen, onLeaveCall]);


    const shareDropdownItems: React.JSX.Element[] = useMemo(() => [
        <ListItem
            key={'Start sharing'}
            title='Start sharing'
            icon={<TvIcon className="w-5 h-5" />}
            disabled={sharingEnabled}
            onClick={() => {
                if (!sharingEnabled) roomClient?.enableShare()
            }}
        />,
        <ListItem
            key={'Stop sharing'}
            title='Stop sharing'
            icon={<XMarkIcon className="w-5 h-5" />}
            disabled={!sharingEnabled}
            onClick={() => {
                if (sharingEnabled) roomClient?.disableShare()
            }}
        />
    ], [roomClient, sharingEnabled]);

    return useMemo(
      () => (
        <div className="video-call-footer">
          <Button
            iconLeft={<>🔥</>}
            onClick={() => setShowReactionPicker(!showReactionPicker)}
            className={`call-actions-button cg-heading-2${
              showReactionPicker ? " media-sharing-enabled" : ""
            }`}
          />
          <Button
            iconLeft={
              isMuted ? (
                <DisabledMicrophone className="cg-text-error" />
              ) : (
                <Microphone className="" />
              )
            }
            onClick={toggleMute}
            className={`call-actions-button${
              isMuted ? "" : " media-sharing-enabled"
            }`}
          />
          {!audioOnly && <Button
            iconLeft={
              webcamEnabled ? (
                <VideoCameraIcon className="w-5 h-5" />
              ) : (
                <VideoCameraSlashIcon className="w-5 h-5" />
              )
            }
            onClick={toggleWebcam}
            className={`call-actions-button ${
              webcamEnabled ? "media-sharing-enabled" : ""
            }`}
          />}
          {!isMobile && !isTablet && !audioOnly && (
            <ScreenAwareDropdown
              triggerContent={
                <Button
                  iconLeft={
                    sharingEnabled ? (
                      <TvIcon className="w-5 h-5" />
                    ) : (
                      <TvIconOutline className="w-5 h-5" />
                    )
                  }
                  className={`call-actions-button ${
                    sharingEnabled ? "media-sharing-enabled" : ""
                  }`}
                />
              }
              items={shareDropdownItems}
              className="toggle-share-dropdown"
            />
          )}
          {!isMobile && !isTablet && (
            <Button
              iconLeft={
                isFullscreen ? (
                  <ArrowsPointingInIcon className="w-5 h-5" />
                ) : (
                  <ArrowsPointingOutIcon className="w-5 h-5" />
                )
              }
              className={`call-actions-button ${
                isFullscreen ? "media-sharing-enabled" : ""
              }`}
              onClick={onFullScreen}
            />
          )}
          <ScreenAwareDropdown
            triggerContent={
              <Button
                iconLeft={<Cog6ToothIcon className="w-5 h-5" />}
                className="call-actions-button"
              />
            }
            items={[<AudioDevicesManagement popupMode key={"audio"} />]}
            className="toggle-options-dropdown"
          />
          {moderateButton}
          <Button
            role="final"
            className="call-actions-button-size"
            iconRight={<HangupIcon className="hangup-icon" />}
            onClick={onLeaveCallClick}
          />
        </div>
      ),
      [
        showReactionPicker,
        isMuted,
        toggleMute,
        webcamEnabled,
        toggleWebcam,
        isMobile,
        isTablet,
        sharingEnabled,
        shareDropdownItems,
        isFullscreen,
        onFullScreen,
        moderateButton,
        onLeaveCallClick,
        setShowReactionPicker,
      ]
    );
}

export default CallActions;