// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useMemo, useRef } from "react";
import { RoomConsumer, RoomPeer, RoomProducer } from "./CallPage.reducer";
import { useSignedUrl } from "hooks/useSignedUrl";

import "./PeerCard.css";
import UserTag from "components/atoms/UserTag/UserTag";
import Jdenticon from "components/atoms/Jdenticon/Jdenticon";
import { useCallContext } from "context/CallProvider";
import ScreenAwareDropdown from "components/atoms/ScreenAwareDropdown/ScreenAwareDropdown";
import ListItem from "components/atoms/ListItem/ListItem";
import { ArrowTopRightOnSquareIcon, StarIcon } from "@heroicons/react/20/solid";
import { StarIcon as OutlinedStarIcon } from "@heroicons/react/24/outline";
import { HandRaisedIcon } from "@heroicons/react/24/solid";
import DisabledMicrophone from "../../../components/atoms/icons/20/MicrofonDisabled.svg?react";
import { CallType } from "common/enums";
import UserTooltip from "../UserTooltip/UserTooltip";
import { UserTooltipHandle } from "components/atoms/Tooltip/UserProfilePopover";
import { canModerateCalls } from "./HelperFunctions/callHelpers";
import { useLiveQuery } from "dexie-react-hooks";
import data from "data";
import PeerReactionOverlay from "./PeerReactionOverlay/PeerReactionOverlay";

interface PeerViewProps {
  user: RoomPeer;
  actualUser: Models.User.Data;
  isMainCard: boolean;
}

const PeerCard: React.FC<PeerViewProps> = ({
  user,
  actualUser,
  isMainCard,
}) => {
  const {
    me,
    consumers,
    producers,
    isMuted,
    setSpotlight,
    spotlightedPeer,
    spotlightedPeerOriginator,
    roomClient,
    call,
  } = useCallContext();
  const [isSpotlighted, setIsSpotlighted] = React.useState(false);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hasTalked = useRef(user.isTalking);
  const userTooltipRef = useRef<UserTooltipHandle>(null);

  hasTalked.current = hasTalked.current || user.isTalking;
  const isVideoEnabled = user.isMe
    ? me?.webcamEnabled || me?.sharingEnabled
    : user.webcamEnabled || user.sharingEnabled;
  const [audioConsumer, setAudioConsumer] = React.useState<
    RoomConsumer | undefined
  >(undefined);
  const [videoConsumer, setVideoConsumer] = React.useState<
    RoomConsumer | undefined
  >(undefined);
  const [videoProducer, setVideoProducer] = React.useState<
    RoomProducer | undefined
  >(undefined);

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

  const setPrefferedLayers = React.useCallback(
    (consumer: RoomConsumer, forceHighest?: boolean) => {
      if (consumer.track?.kind === "video") {
        if (isMainCard || forceHighest) {
          roomClient?.setConsumerPreferredLayers(
            consumer.id,
            consumer.spatialLayers - 1,
            consumer.temporalLayers - 1
          );
        } else {
          roomClient?.setConsumerPreferredLayers(
            consumer.id,
            0,
            consumer.temporalLayers - 1
          );
        }
      }
    },
    [isMainCard, roomClient]
  );

  useEffect(() => {
    const interval = setInterval(() => {
      const currentTime = Date.now();
      if (user.isTalking && currentTime - user.lastEventTime > 1000) {
        roomClient?.setPeerIsTalking(user.id, false);
      }
    }, 500); // Check every 1 second

    return () => {
      clearInterval(interval);
    };
  }, [
    user.displayName,
    user.id,
    user.isTalking,
    user.lastEventTime,
    roomClient,
  ]);

  useEffect(() => {
    let audioConsumer: RoomConsumer | undefined;
    let videoConsumer: RoomConsumer | undefined;
    let videoProducer: RoomProducer | undefined;
    if (user.consumers) {
      for (const consumerId of user.consumers) {
        const actualConsumer = consumers.get(consumerId);
        if (actualConsumer?.track?.kind === "audio") {
          audioConsumer = actualConsumer;
        } else if (actualConsumer?.track?.kind === "video") {
          videoConsumer = actualConsumer;
        }
      }
    }
    if (producers) {
      producers.forEach((producer) => {
        const actualProducer = producers.get(producer.id);
        if (actualProducer?.track?.kind === "video") {
          videoProducer = actualProducer;
        }
      });
    }
    setVideoProducer(videoProducer);
    setAudioConsumer(audioConsumer);
    setVideoConsumer(videoConsumer);
  }, [consumers, producers, user.consumers]);

  useEffect(() => {
    if (spotlightedPeer === user.id) {
      setIsSpotlighted(true);
    } else {
      setIsSpotlighted(false);
    }
  }, [spotlightedPeer, user.id]);

  useEffect(() => {
    if (!user.isMe) {
      let videoTrack: MediaStreamTrack | null = null;
      if (videoConsumer) {
        videoTrack = videoConsumer.track;
        setPrefferedLayers(videoConsumer);
      }

      if (videoTrack && videoRef.current) {
        const stream = new MediaStream();

        stream.addTrack(videoTrack);
        videoRef.current.srcObject = stream;

        console.log("streaming video: ", videoTrack);
        const playPromise = videoRef.current.play();

        if (playPromise !== undefined) {
          playPromise
            .then((_) => {
              // Automatic playback started!
              // Show playing UI.
            })
            .catch((error) => {
              // Auto-play was prevented
              // Show paused UI.
              console.warn("videoRef.current.play() failed:%o", error);
            });
        }
      }
    } else {
      let videoTrack: MediaStreamTrack | null = null;
      if (videoProducer) {
        videoTrack = videoProducer.track;
      }

      if (videoTrack && videoRef.current) {
        const stream = new MediaStream();

        stream.addTrack(videoTrack);
        videoRef.current.srcObject = stream;
        // Show loading animation.
        const playPromise = videoRef.current.play();

        if (playPromise !== undefined) {
          playPromise
            .then((_) => {
              // Automatic playback started!
              // Show playing UI.
            })
            .catch((error) => {
              // Auto-play was prevented
              // Show paused UI.
              console.warn("videoRef.current.play() failed:%o", error);
            });
        }
      }
    }
  }, [user.isMe, user.id, videoConsumer, videoProducer, setPrefferedLayers]);

  const imageId = actualUser.accounts.find(acc => acc.type === actualUser.displayAccount)?.imageId;
  const imageUrl = useSignedUrl(imageId);

  const userIsMuted = React.useCallback(() => {
    if (user.isMe) {
      return isMuted;
    } else {
      return audioConsumer ? audioConsumer.remotelyPaused : true;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [audioConsumer, audioConsumer?.remotelyPaused, isMuted, user.isMe]);

  const spotlightedItem = useMemo(() => {
    if (isSpotlighted) {
      return (
        <ListItem
          key="stop-spotlighting"
          title="Stop Spotlighting"
          icon={<OutlinedStarIcon className="w-5 h-5" />}
          onClick={() => setSpotlight("")}
        />
      );
    } else {
      return (
        <ListItem
          key="spotlight"
          title="Spotlight"
          icon={<StarIcon className="w-5 h-5" />}
          onClick={() => setSpotlight(user.id)}
        />
      );
    }
  }, [isSpotlighted, setSpotlight, user.id]);

  const hasModeratePermissions = useMemo(() => {
    if (!call || !community || !myRoles || !me || !roles) return false;
    return canModerateCalls(
      myRoles || [],
      call?.rolePermissions || [],
      roles,
      me.id,
      call.callCreator
    );
  }, [call, me, myRoles, community, roles]);

  const dropdownOptions = useMemo(() => {
    const options = [spotlightedItem];
    if (hasModeratePermissions) {
      if (call?.callType === CallType.BROADCAST) {
        options.push(
          <ListItem
            key="demote-audience"
            title="Demote to audience"
            onClick={() => roomClient?.demoteBroadcaster(user.id)}
            icon={<HandRaisedIcon className="w-5 h-5" />}
          />
        );
      }
      if (!(audioConsumer?.remotelyPaused || audioConsumer?.locallyPaused) && !user.isMe) {
        options.push(
          <ListItem
            key="moderation-mute"
            title="Mute"
            onClick={() => roomClient?.moderationMuteMic(user.id)}
            icon={<DisabledMicrophone className="w-5 h-5" />}
          />
        );
      }
    }
    if (isVideoEnabled) {
      options.push(
        <ListItem
          key="pop-out"
          title="Pop-out"
          icon={<ArrowTopRightOnSquareIcon className="w-5 h-5" />}
          onClick={() => {
            if (videoRef.current) {
              videoRef.current.requestPictureInPicture();
              if (videoConsumer) {
                setPrefferedLayers(videoConsumer, true);
              }
              videoRef.current.onleavepictureinpicture = () => {
                if (videoConsumer) {
                  setPrefferedLayers(videoConsumer);
                }
              };
            }
          }}
        />
      );
    }
    options.push(
      <ListItem
        key="view-profile"
        title="View profile"
        onClick={() => userTooltipRef.current?.open()}
      />
    );
    return options;
  }, [audioConsumer?.locallyPaused, audioConsumer?.remotelyPaused, call?.callType, hasModeratePermissions, isVideoEnabled, roomClient, setPrefferedLayers, spotlightedItem, user.id, user.isMe, videoConsumer]);

  const trigger = useMemo(() => {
    const backgroundImageStyle = { backgroundImage: `url(${imageUrl})` };
    const talkingClassName = hasTalked.current
      ? user.isTalking
        ? "talking"
        : "not-talking"
      : "";

    return (
      <div
        className={`call-peer-card cursor-pointer ${
          isVideoEnabled ? talkingClassName : ""
        }`}
        style={!isVideoEnabled ? backgroundImageStyle : undefined}
      >
        {!isVideoEnabled && <div className={"card-blur"} />}
        <div className="hover-shadow" />
        {isSpotlighted && (
          <StarIcon
            className={`absolute top-2 right-2 w-5 h-5 ${
              spotlightedPeerOriginator === "remote"
                ? "text-yellow-500"
                : "text-gray-500"
            }`}
          />
        )}
        {isVideoEnabled && videoRef && (
          <video
            className={`video-call-card`}
            autoPlay
            playsInline
            muted
            ref={videoRef}
          />
        )}
        {!isVideoEnabled && (
          <div className={`call-card-avatar ${talkingClassName}`}>
            <Jdenticon key={user.id} userId={user.id} hideStatus />
          </div>
        )}
        <div className="call-user-tag" onClick={(e) => e.stopPropagation()}>
          <UserTag userData={actualUser} isMuted={userIsMuted()} hideStatus />
        </div>
        <PeerReactionOverlay
          type={isMainCard ? 'mainSpeaker' : 'speaker'}
          reaction={user.reaction}
        />
      </div>
    );
  }, [
    actualUser,
    imageUrl,
    isSpotlighted,
    isVideoEnabled,
    spotlightedPeerOriginator,
    user.id,
    userIsMuted,
    user.isTalking,
    isMainCard,
    user.reaction
  ]);

  return (
    <>
      <ScreenAwareDropdown
        triggerContent={trigger}
        items={dropdownOptions}
        triggerClassname={"dropdown-options-trigger h-full w-full"}
        closeOnClick={true}
        placement={"bottom"}
      />
      <UserTooltip
        userId={actualUser.id}
        ref={userTooltipRef}
        isMessageTooltip={false}
        triggerClassName="hidden"
      />
    </>
  );
};

export default React.memo(PeerCard);
