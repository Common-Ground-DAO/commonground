// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useMobileContext } from "../../../context/MobileContext";
import { useCallContext } from "../../../context/CallProvider";
import { useWindowSizeContext } from "../../../context/WindowSizeProvider";

import Button from "../../../components/atoms/Button/Button";
import TalkersCounterButton from "../../../components/molecules/TalkersCounterButton/TalkersCounterButton";

import HangupIcon from '../../../components/atoms/icons/20/Hangup.svg?react';
import MicrofonIcon from '../../../components/atoms/icons/20/Microfon.svg?react';
import MicrofonDisabledIcon from '../../../components/atoms/icons/20/MicrofonDisabled.svg?react';
import AudioWaves from "../AudioWidget/AudioWaves";
import { Cog6ToothIcon } from "@heroicons/react/20/solid";
import ScreenAwareDropdown from "components/atoms/ScreenAwareDropdown/ScreenAwareDropdown";
import AudioDevicesManagement from "components/organisms/AudioDevicesManagement/AudioDevicesManagement";

import "./AudioManagerButtons.css";

type Props = {}

export function AudioManagerButtons(props: Props) {
  const { isMobile } = useWindowSizeContext();
  const { toggleAudioTrayStatement } = useMobileContext();
  const { isConnected, toggleMute, isMuted, leaveCall } = useCallContext();

  if (isConnected) {
    return (
      <div className={`audio-manager-buttons`}>
        {isMobile && <AudioWaves />}
        {isMobile && <TalkersCounterButton onClick={toggleAudioTrayStatement} />}
        <div onClick={e => e.stopPropagation()}>
          <ScreenAwareDropdown
            triggerContent={<Button
              role="audio"
              iconLeft={<Cog6ToothIcon className='w-5 h-5' />}
            />}
            items={[<AudioDevicesManagement popupMode key={'audio'} />]}
            className="toggle-options-dropdown"
          />
        </div>
        {!isMuted && <div onClick={e => e.stopPropagation()}><Button role='audio' iconLeft={<MicrofonIcon />} onClick={toggleMute} /></div>}
        {isMuted && <div onClick={e => e.stopPropagation()}><Button className="cg-text-error" role='audio' iconLeft={<MicrofonDisabledIcon />} onClick={toggleMute} /></div>}
        <Button role='final' iconLeft={<HangupIcon />} onClick={(e) => {
          e.stopPropagation();
          leaveCall();
        }} />
      </div>
    );
  } else {
    return null;
  }
}