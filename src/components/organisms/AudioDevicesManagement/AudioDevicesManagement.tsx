// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md


import CheckmarkIcon from '../../../components/atoms/icons/16/Checkmark.svg?react';
import { VideoCameraIcon } from '@heroicons/react/20/solid';
import { MicrophoneIcon } from '@heroicons/react/20/solid';
import { useCallDevicesContext } from 'context/CallDevicesProvider';
import { useEffect, useState } from 'react';
import Button from 'components/atoms/Button/Button';
import { useCallContext } from 'context/CallProvider';
import ManagementHeader from 'components/molecules/ManagementHeader/ManagementHeader';
import { useWindowSizeContext } from 'context/WindowSizeProvider';

import './AudioDevicesManagement.css';

type Props = {
    popupMode?: boolean;
}

export default function AudioDevicesManagement(props: Props) {
    const { popupMode } = props;
    const { availableAudioDevices, availableWebCams, chooseWebcamDevice, selectedWebCam, selectedAudioDevice, chooseAudioDevice, updateDevices } = useCallDevicesContext();
    const { roomClient, me } = useCallContext();
    const { isMobile } = useWindowSizeContext();

    const [isNotAllowed, setIsNotAllowed] = useState(false);

    useEffect(() => {
        const fillDevices = async () => {
            try {
                await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
                await updateDevices();
            } catch (e: any) {
                //check if permission denied
                if (e.name === "NotAllowedError") {
                    setIsNotAllowed(true);
                }
            }
        }
        fillDevices();
    }, [updateDevices]);

    const className = ["audio-devices-management", popupMode ? 'popup-mode' : ''].join(' ').trim();

    return (
        <div className={className}>
            {!isMobile && !popupMode && <ManagementHeader title="Manage your media devices" />}
            <div className="audio-input-devices">
                <h3><MicrophoneIcon className='w-4 h-4' />Microphone devices</h3>
                <div className="audio-input-devices-container">
                    {!!availableAudioDevices && availableAudioDevices.map(d => (
                        <div className={`audio-input-device ${d.deviceId === selectedAudioDevice ? "active" : ""}`} key={d.deviceId} onClick={() => {
                            chooseAudioDevice(d.deviceId);
                            if(roomClient){
                                roomClient.changeMicrophone(d.deviceId);
                            }
                            }} >
                            <span>{d.label}</span>
                            {d.deviceId === selectedAudioDevice && <span><CheckmarkIcon /></span>}
                        </div>
                    ))}
                    {availableAudioDevices.length === 0 && isNotAllowed && (<span className="not-allowed">Permission denied when trying to get audio devices, you can make sure microphone usage is allowed for this app and refresh.<Button onClick={updateDevices} text={"Refresh"} role='primary'/></span>)}
                </div>
            </div>
            <div className="audio-input-devices">
                <h3><VideoCameraIcon className='w-4 h-4' />Webcam devices</h3>
                <div className="audio-input-devices-container">
                    {!!availableWebCams && availableWebCams.map(d => (
                        <div className={`audio-input-device ${d.deviceId === selectedWebCam ? "active" : ""}`} key={d.deviceId} onClick={() => {
                            chooseWebcamDevice(d.deviceId);
                            if(roomClient){
                                me?.webcamEnabled && roomClient.changeWebcam(d.deviceId);
                            }
                        }} >
                            <span>{d.label}</span>
                            {d.deviceId === selectedWebCam && <span><CheckmarkIcon /></span>}
                        </div>
                    ))}
                    
                    {availableWebCams.length === 0 && isNotAllowed && (<span className="not-allowed">Permission denied when trying to get webcam devices, you can make sure webcam usage is allowed for this app and refresh.<Button onClick={updateDevices} text={"Refresh"} role='primary'/></span>)}
                </div>
            </div>
            {/* <hr />
          <div className="section">
              <label><SpeakerIcon />Output device</label>
          </div> */}
        </div>
    );
}