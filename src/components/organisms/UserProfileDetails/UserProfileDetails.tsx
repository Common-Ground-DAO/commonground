// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useMemo, useState, useRef, useEffect } from "react";
import "./UserProfileDetails.css";

import { getDisplayName, getDisplayNameString, normalizeTwitterLink } from "../../../util";

import Button from "../../../components/atoms/Button/Button";
import { Tooltip } from "../../../components/atoms/Tooltip/Tooltip";
import UserProfilePhoto from "../../../components/molecules/UserProfilePhoto/UserProfilePhoto";
import SimpleLink from "../../../components/atoms/SimpleLink/SimpleLink";
import Scrollable from "../../molecules/Scrollable/Scrollable";

import FollowIcon from '../../../components/atoms/icons/16/Follow.svg?react';
import HandshakeIcon from '../../../components/atoms/icons/16/Handshake.svg?react';
import GlobeIcon from '../../../components/atoms/icons/24/Globe.svg?react';
import LinkIcon from "../../../components/atoms/icons/24/LinkIcon.svg?react";
import MessageIcon from '../../../components/atoms/icons/16/Message.svg?react';
import XIcon from '../../atoms/icons/24/X.svg?react';
import UnfollowIcon from '../../../components/atoms/icons/16/Unfollow.svg?react';

import { useLoadedProfileContext } from "context/ProfileProvider";
import data from "data";
import { useChats, useOwnUser } from "context/OwnDataProvider";

import useLocalStorage from "hooks/useLocalStorage";
import { useSnackbarContext } from "context/SnackbarContext";
import { useDetailledUserData } from "context/UserDataProvider";
import BotBadge from "components/atoms/BotBadge/BotBadge";

type Props = {
};

export default function UserProfileDetails(props: Props) {
  const { showSnackbar } = useSnackbarContext();
  const { user, isSelf } = useLoadedProfileContext();
  const [usePieMenu, setUsePieMenu] = useLocalStorage(false, 'EXPERIMENTAL_PIE_MENU');
  const ownUser = useOwnUser();
  const userId = user.id;
  const [experimentalUiCounter, setExperimentalUiCounter] = useState<number>(0);
  const experimentalUiTimeout = useRef<any>(null);
  const twitter = user?.accounts?.find(a => a.type === 'twitter');
  const userDisplayNameString = useMemo(() => getDisplayNameString(user), [user]);
  const userDisplayName = useMemo(() => getDisplayName(user), [user]);
  const { navigateToChatOrCreateNewChat } = useChats();

  const detailledData = useDetailledUserData(userId);
  const cgProfile = detailledData?.detailledProfiles.find(a => a.type === 'cg');
  const extraData = cgProfile?.extraData as Models.User.UserAccountExtraData_CG | null | undefined;
  const botProfile = detailledData?.detailledProfiles.find(a => a.type === 'bot');
  const botExtraData = botProfile?.extraData?.type === 'bot' ? botProfile.extraData : undefined;

  const toggleFollow = async () => {
    if (user.isFollowed) {
      await data.user.unfollow(userId);
      showSnackbar({ type: 'info', text: `Stopped following ${userDisplayNameString}` });
    } else {
      await data.user.follow(userId);
      showSnackbar({ type: 'info', text: `Following ${userDisplayNameString}` });
    }
  };

  const toggleExperimentalUi = useMemo(() => {
    return () => {
      if (experimentalUiCounter >= 6) {
        setUsePieMenu(!usePieMenu);
        setExperimentalUiCounter(0);
        if (!!experimentalUiTimeout.current) {
          clearTimeout(experimentalUiTimeout.current);
          experimentalUiTimeout.current = null;
        }
      } else if (isSelf) {
        setExperimentalUiCounter(experimentalUiCounter + 1);
      }
      if (!experimentalUiTimeout.current) {
        experimentalUiTimeout.current = setTimeout(() => {
          experimentalUiTimeout.current = null;
          setExperimentalUiCounter(0);
        }, 5000);
      }
    }
  }, [experimentalUiCounter, isSelf, setUsePieMenu, usePieMenu]);
  useEffect(() => {
    return () => {
      if (!!experimentalUiTimeout.current) {
        clearTimeout(experimentalUiTimeout.current);
      }
    }
  }, []);

  const MessageButton = (
    <Button
      text={user.isFollower && user.isFollowed ? "Message" : ""}
      role="primary"
      disabled={!(user.isFollower && user.isFollowed)}
      iconLeft={<MessageIcon />}
      onClick={() => !!user && navigateToChatOrCreateNewChat(user.id)}
    />
  );

  return (
    <>
      <div className="user-profile-details">
        <div className="user-profile-header">
          <UserProfilePhoto userId={userId} />
        </div>
        <div className="user-profile-content">
          {userId !== ownUser?.id && !user.isBot && (
            <div className="interfaction-buttons-container">
              {user.isFollower && user.isFollowed ? <span className="follows-me"><HandshakeIcon /></span> : user.isFollower && <span className="follows-me">follows you</span>}
              <Button
                role={user.isFollowed ? "secondary" : "primary"}
                iconLeft={user.isFollowed ? <UnfollowIcon /> : <FollowIcon />}
                onClick={toggleFollow}
              />
              {user.isFollower && user.isFollowed ? <>{MessageButton}</> : (
                <Tooltip
                  placement="bottom"
                  triggerContent={MessageButton}
                  tooltipContent="Only users who follow each other can send a DM"
                  offset={4}
                />
              )}
            </div>
          )}
          <div className="user-display-name cg-text-main">
            <span className="user-alias">{userDisplayName}</span>
            {user.isBot && <BotBadge />}
          </div>
          <div className="user-description">
            <Scrollable>
              <div className="user-about-box">
                <label>About me</label>
                <span onClick={toggleExperimentalUi}>{user.isBot ? botExtraData?.description : extraData?.description}</span>
              </div>
              {!user.isBot && <div className="user-socials">
                {twitter && (
                  <SimpleLink key="link-twitter" href={normalizeTwitterLink(twitter.displayName)}>
                    <div className={`user-socials-row ${!twitter ? "invalid" : ""}`}>
                      <XIcon />
                      <div>{twitter.displayName}</div>
                    </div>
                  </SimpleLink>
                )}
                {extraData?.homepage && (
                  <SimpleLink key="link-homepage" href={extraData.homepage}>
                    <div className={`user-socials-row ${extraData?.homepage ? "invalid" : ""}`}>
                      <GlobeIcon />
                      <div>{extraData?.homepage}</div>
                    </div>
                  </SimpleLink>
                )}
                {extraData?.links && extraData.links.filter(link => !!link).map((link, index) =>
                  <SimpleLink key={`link-${index}`} href={link.url}>
                    <div className={`user-socials-row`}>
                      <LinkIcon />
                      <div>{link.text}</div>
                    </div>
                  </SimpleLink>
                )}
              </div>}
            </Scrollable>
          </div>
        </div>
      </div>
    </>
  );
}
