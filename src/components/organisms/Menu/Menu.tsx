// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import config from "../../../common/config";

import BellIcon from "../../atoms/icons/24/Bell.svg?react";
import BellFilledIcon from "../../atoms/icons/24/BellFilled.svg?react";
import ChatBubbleIcon from "../../atoms/icons/24/ChatBubble.svg?react";
import ChatBubbleFilledIcon from "../../atoms/icons/24/ChatBubbleFilled.svg?react";
import HomeSolidIcon from "../../atoms/icons/24/HomeSolid.svg?react";
import HomeOutlineIcon from "../../atoms/icons/24/HomeOutline.svg?react";

import { AudioWidget } from "../../../components/molecules/AudioWidget/AudioWidget";
import MenuButton from "../../../components/molecules/MenuButton/MenuButton";
import GroupsMenu from "./GroupsMenu/GroupsMenu";
import Scrollable, { PositionData } from "../../molecules/Scrollable/Scrollable";
import { useNotificationContext } from "../../../context/NotificationProvider";

import './Menu.css';
import { useChats } from "context/OwnDataProvider";
import { getUrl } from 'common/util';

export default function Menu() {
  const navigate = useNavigate();
  const location = useLocation();
  const { chats } = useChats();
  const { unreadCount } = useNotificationContext();
  const [ groupsMenuPosition, setGroupsMenuPosition ] = useState<"top" | "middle" | "bottom">();
  const [ groupsMenuDirection, setGroupsMenuDirection ] = useState<"up" | "down">();
  
  let unreadChats: number = 0;
  chats.forEach(chat => {
    unreadChats += chat.unread || 0;
  });

  const positionCallback = useCallback((data: PositionData) => {
    if (!data.isTop && !data.isBottom) {
      if (groupsMenuPosition === "top") {
        setGroupsMenuDirection('down');
      } else if (groupsMenuPosition === "bottom") {
        setGroupsMenuDirection('up');
      }
      setGroupsMenuPosition("middle");
    } else if (data.isTop) {
      setGroupsMenuPosition("top");
      setGroupsMenuDirection('up');
    } else if (data.isBottom) {
      setGroupsMenuPosition("bottom");
      setGroupsMenuDirection('down');
    }
  }, [groupsMenuPosition, setGroupsMenuPosition, setGroupsMenuDirection]);

  const isActiveButton = useCallback((prefix: string): boolean => {
    if (prefix === "/") {
      return location.pathname === "/";
    }
    else {
      return location.pathname.startsWith(prefix)
    }
  }, [location]);

  const onHomeClick = useCallback(() => {
    if (location.pathname !== '/') {
      navigate(getUrl({type: 'home'}))
    } else {
      document.getElementById('home-scrollable')?.scrollTo({top: 0, behavior: 'smooth'});
    }
  }, [location.pathname, navigate]);
  
  const homeActive = isActiveButton('/') || isActiveButton('/e/');
  return (
    <div className='menu'>
      <Scrollable className={`community-icons ${groupsMenuPosition} ${groupsMenuDirection || ''}`} positionCallback={positionCallback}>
        <GroupsMenu collapsed={false} />
      </Scrollable>
      <div className="menu-buttons">
        <MenuButton icon={homeActive ? <HomeSolidIcon /> : <HomeOutlineIcon />} isActive={homeActive} onClick={onHomeClick} />
        <MenuButton
          icon={isActiveButton(getUrl({ type: 'chats' })) ? <ChatBubbleFilledIcon /> : <ChatBubbleIcon />}
          isActive={isActiveButton(getUrl({ type: 'chats' }))}
          onClick={() => navigate(getUrl({ type: 'chats' }))}
          notificationCount={unreadChats}
        />
        <MenuButton
          icon={isActiveButton(getUrl({ type: 'notifications' })) ? <BellFilledIcon /> : <BellIcon />}
          isActive={isActiveButton(getUrl({ type: 'notifications' }))}
          onClick={() => {
            if (config.NOTIFICATIONS_PAGE_ENABLED) { navigate(getUrl({ type: 'notifications' })) }
            }
          }
          notificationCount={unreadCount}
        />
        <AudioWidget isActive={false} />
      </div>
    </div>
  );
}
