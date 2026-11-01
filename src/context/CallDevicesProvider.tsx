// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import useLocalStorage from "hooks/useLocalStorage";
import React, { useCallback, useEffect, useState } from "react";
import { listInputDevices, reconcileDeviceSelection } from "./callDeviceSelection";

interface CallDevicesState {
    selectedAudioDevice?: string;
    selectedWebCam?: string;
    availableAudioDevices: MediaDeviceInfo[];
    availableWebCams: MediaDeviceInfo[];
    chooseAudioDevice: (deviceId: string) => void;
    chooseWebcamDevice: (deviceId: string) => void;
    updateDevices: () => Promise<void>;
}

export const CallDevicesContext = React.createContext<CallDevicesState>({
    availableAudioDevices: [],
    availableWebCams: [],
    chooseAudioDevice: () => { },
    chooseWebcamDevice: () => { },
    updateDevices: async () => { return Promise.resolve(); },
});

export function CallDevicesProvider(props: React.PropsWithChildren<{}>) {

    const [selectedAudioDevice, setSelectedAudioDevice] = useLocalStorage('', 'selectedAudioDeviceId');
    const [selectedWebCam, setSelectedWebCam] = useLocalStorage('', 'selectedVideoDeviceId');
    const [availableAudioDevices, setAvailableAudioDevices] = useState<MediaDeviceInfo[]>([]);
    const [availableWebCams, setAvailableWebCams] = useState<MediaDeviceInfo[]>([]);

    const updateDevices = useCallback(async () => {
        const { audio: audioDevices, video: videoDevices } = await listInputDevices(navigator.mediaDevices);
        setAvailableAudioDevices(audioDevices);
        setAvailableWebCams(videoDevices);
        // An empty list (no device, or no media permission yet) keeps the
        // stored choice; see reconcileDeviceSelection.
        const audioDeviceId = reconcileDeviceSelection(selectedAudioDevice, audioDevices);
        if (audioDeviceId !== selectedAudioDevice) {
            setSelectedAudioDevice(audioDeviceId);
        }
        const webCamId = reconcileDeviceSelection(selectedWebCam, videoDevices);
        if (webCamId !== selectedWebCam) {
            setSelectedWebCam(webCamId);
        }
    }, [selectedAudioDevice, selectedWebCam, setSelectedAudioDevice, setSelectedWebCam]);
    
    useEffect(() => {
        updateDevices();
    }, [updateDevices]);

    const chooseAudioDevice = useCallback((deviceId: string) => {
        const device = availableAudioDevices.find(d => d.deviceId === deviceId);
        if (device) {
            setSelectedAudioDevice(device.deviceId);
        }
    }, [availableAudioDevices, setSelectedAudioDevice]);

    const chooseWebcamDevice = useCallback((deviceId: string) => {
        const device = availableWebCams.find(d => d.deviceId === deviceId);
        if (device) {
            setSelectedWebCam(device.deviceId);
        }
    }, [availableWebCams, setSelectedWebCam]);


    return (
        <CallDevicesContext.Provider value={{ availableAudioDevices, availableWebCams, selectedAudioDevice, selectedWebCam, chooseAudioDevice, chooseWebcamDevice, updateDevices }}>
            {props.children}
        </CallDevicesContext.Provider>
    )
}

export function useCallDevicesContext() {
    const context = React.useContext(CallDevicesContext);
    return context;
}