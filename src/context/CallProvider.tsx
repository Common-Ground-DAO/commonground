// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { useOwnUser } from "./OwnDataProvider";
import {
  CallState,
  RoomConsumer,
  RoomPeer,
  callReducer,
  initialState,
  meInitialState,
} from "components/organisms/CallPage/CallPage.reducer";
import getDeviceInfo from "util/deviceInfo";
import data from "data";
import errors from "common/errors";
import dayjs from "dayjs";
import { RoomClient } from "../util/RoomClient";
import { RefusedMediaKind } from "../util/mediaRefusal";
import { PermissionType } from "components/molecules/RolePermissionToggle/RolePermissionToggle";
import { CallPermission, CallType } from "common/enums";
import { getDisplayNameString } from "../util";
import { useSnackbarContext } from "./SnackbarContext";
import communityApi from "data/api/community";
import webSocketManager from "data/appstate/webSocket";

const mediaRefusedText: Record<RefusedMediaKind, string> = {
  audio: "You are not allowed to speak in this call.",
  video: "You are not allowed to turn on your camera in this call.",
  share: "You are not allowed to share your screen in this call.",
};

type CallProviderState = CallState & {
  roomClient: RoomClient | null;
  joinCall: (callData: Models.Calls.Call) => void;
  startCall: (
    communityId: string,
    callName: string,
    callDescription: string | null,
    callType: Common.CallType,
    slots: number,
    stageSlots: number,
    hd: boolean,
    audioOnly: boolean,
    callPermissions?: { [roleId: string]: PermissionType }
  ) => Promise<Models.Calls.Call> | undefined;
  leaveCall: () => void;
  toggleMute: () => void;
  setSpotlight: (peerId: string) => void;
};

interface PeerAudioProps {
  user: RoomPeer;
  consumers: Map<string, RoomConsumer>;
}

const PeerAudio: React.FC<PeerAudioProps> = ({ user, consumers }) => {
  const audioRef = useRef<HTMLAudioElement>(null);

  useEffect(() => {
    if (!user.isMe) {
      let audioTrack: MediaStreamTrack | null = null;
      for (const consumerId of user.consumers) {
        const actualConsumer = consumers.get(consumerId);
        if (actualConsumer?.track?.kind === "audio") {
          audioTrack = actualConsumer.track;
        }
      }

      if (audioTrack && audioRef.current) {
        const stream = new MediaStream();

        stream.addTrack(audioTrack);
        audioRef.current.srcObject = stream;

        audioRef.current
          .play()
          .catch((error) => console.warn("audioElem.play() failed:%o", error));
      }
    }
  }, [consumers, user.consumers, user.isMe, user.id]);

  return <audio ref={audioRef} autoPlay={true} muted={user.isMe} />;
};

export const CallContext = React.createContext<CallProviderState>({
  call: null,
  callId: "",
  callDescription: null,
  callName: "",
  communityId: "",
  startTime: dayjs(),
  peers: new Map(),
  state: "disconnected",
  consumers: new Map(),
  producers: new Map(),
  activeSpeaker: "",
  roomClient: null,
  isMuted: true,
  isConnected: false,
  me: meInitialState,
  startCall: () => undefined,
  joinCall: () => undefined,
  leaveCall: () => {},
  toggleMute: () => {},
  setSpotlight: () => {},
  broadcasters: new Map(),
  raisedHands: new Map(),
  recentReactions: [],
  audioOnly: false,
  highQuality: false,
  callSlots: 0,
  stageSlots: 0,
});

export function CallProvider(props: React.PropsWithChildren<{}>) {
  const [callState, dispatch] = useReducer(callReducer, initialState);
  const ownUser = useOwnUser();
  const device = getDeviceInfo();
  const startingCall = useRef<boolean>(false);
  const wakeLockRef = useRef<WakeLockSentinel | null>(null);
  const snackbar = useSnackbarContext();
  const snackbarRef = useRef(snackbar);
  snackbarRef.current = snackbar;
  const [wakeLockActive, setWakeLockActive] = useState(false);
  const roomClient = useRef<RoomClient | null>(null);

  const requestWakeLock = useCallback(async () => {
    if (!wakeLockRef.current || wakeLockRef.current?.released) {
      wakeLockRef.current = await navigator.wakeLock.request("screen");
    }
  }, []);

  const releaseWakeLock = useCallback(() => {
    if (wakeLockRef.current && !wakeLockRef.current.released) {
      wakeLockRef.current?.release();
    }
    wakeLockRef.current = null;
  }, []);

  useEffect(() => {
    if (wakeLockActive) {
      let mounted = true;
      let timeoutId: any = null;
      const listener = () => {
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        if (mounted && document.visibilityState === "visible") {
          console.log("requesting wake lock");
          requestWakeLock().then(() => {
            if (mounted && wakeLockRef.current && !wakeLockRef.current?.released) {
              wakeLockRef.current.addEventListener("release", listener);
            }
          }).catch(err => {
            console.error(`error requesting wake lock (retry in 2s): ${err.name}, ${err.message}`);
            timeoutId = setTimeout(listener, 2000);
          });
        } else {
          releaseWakeLock();
        }
      };
      listener();
      window.addEventListener("visibilitychange", listener);
      return () => {
        mounted = false;
        if (timeoutId) {
          clearTimeout(timeoutId);
          timeoutId = null;
        }
        window.removeEventListener("visibilitychange", listener);
        wakeLockRef.current?.removeEventListener("release", listener);
      };
    }
    else {
      releaseWakeLock();
    }
  }, [wakeLockActive]);

  const joinCall = useCallback(
    async (callData: Models.Calls.Call) => {
      if (!!ownUser) {
        const joinAudio = new Audio("/audio/joinCall.mp3");

        //ensure call state is completely new
        roomClient.current?.close();
        roomClient.current = null;

        //start joining the call
        let callId = callData.id;

        const onNewPeer = () => {
          const newPeerAudio = new Audio("/audio/peerJoined.mp3");
          newPeerAudio.onended = () => {
            newPeerAudio.src = "";
          };
          newPeerAudio.play();
        };

        const onPeerLeft = () => {
          const peerLeftAudio = new Audio("/audio/peerLeft.mp3");
          peerLeftAudio.onended = () => {
            peerLeftAudio.src = "";
          };
          peerLeftAudio.play();
        };

        roomClient.current = new RoomClient({
          consume: true,
          consumerReplicas: 0,
          device,
          displayName: getDisplayNameString(ownUser),
          forceTcp: false,
          peerId: ownUser?.id,
          roomId: callId,
          produce: true,
          dispatch,
          callServerUrl: callData.callServerUrl,
          callType: callData.callType as CallType,
          callCreator: callData.callCreator,
          onNewPeer,
          onPeerLeft,
          onMediaRefused: (kind) => {
            snackbarRef.current.showSnackbar({
              text: mediaRefusedText[kind],
              type: "warning",
            });
          },
          audioOnly: callData.audioOnly,
          highQuality: callData.highQuality,
        });

        try {
          const me: RoomPeer = {
            id: ownUser.id || "anonymous",
            displayName: getDisplayNameString(ownUser),
            device,
            consumers: [],
            isMe: true,
            volume: 0,
            priority: 1,
            lastEventTime: 0,
            isTalking: false,
            isHandRaised: false,
            isBroadcaster: ownUser.id === callData.callCreator,
          };
          const payload = {
            call: callData,
            callId,
            user: me,
            callDescription: callData.description || "",
            callName: callData.title,
            startTime: dayjs(callData.startedAt),
            communityId: callData.communityId,
            isMuted: true,
            audioOnly: callData.audioOnly,
            highQuality: callData.highQuality,
            callSlots: callData.slots,
            stageSlots: callData.stageSlots,
          }
          await roomClient.current.join(payload);
          if (callData.scheduleDate) {
            //add user to event participants
            await communityApi.addEventParticipantByCallId({
              callId: callData.id,
            });
          }
          // dispatch({
          //   type: "initializeCall",
          //   payload
          // });
          joinAudio.play();
          setWakeLockActive(true);
        } catch (error) {
          console.error("Error joining call:", error);
          dispatch({ type: "exitCall" });
        }
      } else {
        throw new Error(errors.client.LOGIN_REQUIRED);
      }
    },
    [device, ownUser]
  );

  const startCall = useCallback(
    (
      communityId: string,
      callName: string,
      callDescription: string | null,
      callType: Common.CallType,
      slots: number,
      stageSlots: number,
      hd: boolean,
      audioOnly: boolean,
      callPermissions?: { [roleId: string]: PermissionType },
    ) => {
      if (!startingCall.current && !!ownUser) {
        const rolePermissions:
          | { roleId: string; permissions: CallPermission[] }[]
          | undefined = [];
        if (callPermissions) {
          const roleIds = Object.keys(callPermissions);
          for (const roleId of roleIds) {
            const permission = callPermissions[roleId];
            if (permission === "full") {
              rolePermissions.push({
                roleId,
                permissions: [
                  CallPermission.CALL_EXISTS,
                  CallPermission.CALL_JOIN,
                  CallPermission.AUDIO_SEND,
                  CallPermission.VIDEO_SEND,
                  CallPermission.CHANNEL_READ,
                  CallPermission.CHANNEL_WRITE,
                  CallPermission.SHARE_SCREEN,
                ],
              });
            } else if (permission === "moderate") {
              rolePermissions.push({
                roleId,
                permissions: [
                  CallPermission.CALL_EXISTS,
                  CallPermission.CALL_JOIN,
                  CallPermission.AUDIO_SEND,
                  CallPermission.VIDEO_SEND,
                  CallPermission.CHANNEL_READ,
                  CallPermission.CHANNEL_WRITE,
                  CallPermission.CALL_MODERATE,
                  CallPermission.PIN_FOR_EVERYONE,
                  CallPermission.END_CALL_FOR_EVERYONE,
                ],
              });
            }
          }
        }
        startingCall.current = true;
        const result = data.community
          .startCall({
            communityId,
            description: callDescription,
            title: callName,
            rolePermissions:
              callPermissions === undefined ? undefined : rolePermissions,
            callType,
            callCreator: ownUser.id,
            slots,
            stageSlots,
            hd,
            audioOnly,
          })
          .then((callData) => {
            joinCall(callData);
            return callData;
          })
          .catch((e) => {
            console.error("Error starting call", e);
            throw e;
          })
          .finally(() => {
            startingCall.current = false;
          });
        return result;
      }
    },
    [joinCall, ownUser]
  );

  const leaveCall = useCallback(() => {
    const leaveAudio = new Audio("/audio/leaveCall.mp3");
    leaveAudio.play();
    roomClient.current?.close();
    roomClient.current = null;
    setWakeLockActive(false);
  }, []);

  const toggleMute = useCallback(async () => {
    if (roomClient.current?.isMicEnabled()) {
      if (callState.isMuted) {
        await roomClient?.current?.unmuteMic();
      } else {
        await roomClient?.current?.muteMic();
      }
    } else {
      try {
        await roomClient.current?.enableMic();
        // enableMic reports its own failures (a refused mic included); only
        // unmute a mic that is there, so a refusal is not retried at once
        if (roomClient.current?.isMicEnabled()) {
          await roomClient.current.unmuteMic();
        }
      } catch (error) {
        snackbar.showSnackbar({
          text: "Please allow microphone access in your browser settings.",
          type: "warning",
        });
      }
    }
  }, [callState.isMuted, snackbar]);

  const setSpotlight = useCallback((peerId: string) => {
    dispatch({
      type: "setPeerSpotlight",
      payload: { peerId, originator: "local" },
    });
  }, []);

  // a tab in a call keeps its socket while hidden (call chat, call events);
  // see HIDDEN_DISCONNECT_AFTER_MS in data/appstate/transport.ts
  const inCall = !!callState.call;
  useEffect(() => {
    if (!inCall) {
      return;
    }
    const hold = webSocketManager.holdSocket('call');
    return () => hold.release();
  }, [inCall]);

  const peersArray = Array.from(callState.peers.values());

  useEffect(() => {
    if (peersArray.length === 0 && wakeLockRef.current !== null) {
      setWakeLockActive(false);
    }
  }, [peersArray]);

  const peerComponents = React.useMemo(() => {
    return peersArray.map((peer) => (
      <PeerAudio key={peer.id} user={peer} consumers={callState.consumers} />
    ));
  },[callState.consumers, peersArray]);

  useEffect(() => {
    //set roomclient connected state when call is connected
    if (callState.state === "connected") {
      roomClient.current?.setConnectedState();
    }
  }, [callState.state]);

  return (
    <CallContext.Provider
      value={{
        ...callState,
        roomClient: roomClient.current,
        joinCall,
        startCall,
        leaveCall,
        toggleMute,
        setSpotlight,
      }}
    >
      {props.children}
      {peerComponents}
    </CallContext.Provider>
  );
}

export function useCallContext() {
  const context = React.useContext(CallContext);
  return context;
}
