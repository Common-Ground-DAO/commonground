// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import { useCallback } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import config from "../../../../common/config";

import { AudioWidget } from "../../../../components/molecules/AudioWidget/AudioWidget";
import GroupsMenu from "./../GroupsMenu/GroupsMenu";
import { useNotificationContext } from "../../../../context/NotificationProvider";
import NotificationCount from 'components/atoms/NotificationCount/NotificationCount';
import Scrollable from 'components/molecules/Scrollable/Scrollable';
import { useChats, useOwnUser } from 'context/OwnDataProvider';

import './../Menu.css';
import './ExpandedMenu.css';
import { getUrl } from 'common/util';
import { ReactComponent as CircleLogo } from "components/atoms/icons/misc/Logo/logo.svg";
import { Bell, ChatsTeardrop, Compass, Plus, CoinVertical, HouseSimple, Storefront } from '@phosphor-icons/react';
import { useCreateCommunityModalContext } from 'context/CreateCommunityModalProvider';

type Props = {
  expanded?: boolean;
}

export function isActiveButton(pathname: string, prefix: string): boolean {
  if (prefix === "/") {
    return pathname === "/";
  }
  else {
    return pathname.startsWith(prefix);
  }
}

const ExpandedMenu: React.FC<Props> = ({ expanded }) => {
  const navigate = useNavigate();
  const location = useLocation();
  const { chats } = useChats();
  const { unreadCount } = useNotificationContext();
  const { isVisible, setVisible } = useCreateCommunityModalContext();
  const ownUser = useOwnUser();

  let unreadChats: number = 0;
  chats.forEach(chat => {
    unreadChats += chat.unread || 0;
  });

  const onHomeClick = useCallback(() => {
    if (location.pathname !== '/') {
      navigate(getUrl({type: 'home'}));
    } else {
      document.getElementById('home-scrollable')?.scrollTo({ top: 0, behavior: 'smooth' });
    }
  }, [location.pathname, navigate]);

  const className = [
    'menu-expanded',
    expanded ? '' : 'collapsed'
  ].join(' ').trim();

  const homeActive = isActiveButton(location.pathname, '/') || isActiveButton(location.pathname, '/e/');
  return (
    <div className={className}>
      <Scrollable>
        <div className='menu-expanded-top'>
          <CircleLogo className={`w-8 h-8 cg-text-brand ${!expanded ? 'm-auto' : 'ml-1'}`} onClick={onHomeClick}/>
          <div className='menu-content'>
            <div className="menu-buttons">
              <ExpandedMenuButton
                text={expanded ? 'Explore' : undefined}
                icon={<Compass weight='duotone' className='h-6 w-6' />}
                isActive={homeActive}
                onClick={onHomeClick}
              />
              <ExpandedMenuButton
                text={expanded ? 'Stake' : undefined}
                icon={<CoinVertical weight='duotone' className='h-6 w-6' />}
                isActive={isActiveButton(location.pathname, getUrl({type: 'token'}))}
                onClick={() => navigate(getUrl({type: 'token'}))}
              />
              {!!ownUser && <ExpandedMenuButton
                text={expanded ? 'Chats' : undefined}
                icon={<ChatsTeardrop weight='duotone' className='h-6 w-6' />}
                isActive={isActiveButton(location.pathname, getUrl({ type: 'chats' }))}
                onClick={() => navigate(getUrl({ type: 'chats' }))}
                notificationCount={unreadChats}
              />}
              {!!ownUser && <ExpandedMenuButton
                text={expanded ? 'Notifications' : undefined}
                icon={<Bell weight='duotone' className='h-6 w-6' />}
                isActive={isActiveButton(location.pathname, getUrl({ type: 'notifications' }))}
                onClick={() => {
                  if (config.NOTIFICATIONS_PAGE_ENABLED) { navigate(getUrl({ type: 'notifications' })) }
                }}
                notificationCount={unreadCount}
              />}
              <ExpandedMenuButton
                text={expanded ? 'Apps' : undefined}
                icon={<Storefront weight='duotone' className='h-6 w-6' />}
                isActive={isActiveButton(location.pathname, getUrl({ type: 'appstore' }))}
                onClick={() => navigate(getUrl({ type: 'appstore' }))}
              />

              {/* <ExpandedMenuButton
                text={expanded ? 'Articles' : undefined}
                icon={isActiveButton(getUrl({ type: 'feed' })) ? <NewspaperIconFilled className='h-7 w-7' /> : <NewspaperIcon className='h-7 w-7' />}
                isActive={isActiveButton(getUrl({ type: 'feed' }))}
                onClick={() => navigate(getUrl({ type: 'feed' }))}
              />
              <ExpandedMenuButton
                text={expanded ? 'Communities' : undefined}
                icon={isActiveButton(getUrl({ type: 'browse-communities' })) ? <UserGroupIconFilled className='h-7 w-7' /> : <UserGroupIcon className='h-7 w-7' />}
                isActive={isActiveButton(getUrl({ type: 'browse-communities' }))}
                onClick={() => navigate(getUrl({ type: 'browse-communities' }))}
              /> */}
            </div>
            <div className='cg-separator'/>
            <div className="menu-buttons">
              <ExpandedMenuButton
                text={expanded ? 'Create a community' : undefined}
                icon={<Plus weight='duotone' className='h-6 w-6' />}
                isActive={isVisible}
                onClick={() => setVisible(true)}
              />
              <ExpandedMenuButton
                text={expanded ? 'Browse communities' : undefined}
                icon={<HouseSimple weight='duotone' className='h-6 w-6' />}
                isActive={isActiveButton(location.pathname, getUrl({ type: 'browse-communities' }))}
                onClick={() => navigate(getUrl({ type: 'browse-communities' }))}
              />
            </div>
            <div className='cg-separator'/>
            <GroupsMenu collapsed={!expanded} />
          </div>
        </div>
      </Scrollable>
      <div className='menu-user-container'>
        <AudioWidget isActive={isActiveButton(location.pathname, '/profile')} isCollapsed={!expanded} />
      </div>
    </div>
  );
}

type ExpandedMenuButtonProps = {
  text?: string;
  icon?: JSX.Element;
  onClick?: (ev: React.MouseEvent<HTMLElement, MouseEvent>) => void;
  className?: string;
  isActive?: boolean;
  disabled?: boolean;
  notificationCount?: number;
  buttonRef?: React.RefObject<HTMLButtonElement>;
}

function ExpandedMenuButton(props: ExpandedMenuButtonProps) {
  const { text, icon, onClick, isActive, disabled, notificationCount } = props;

  return (
    <div className={`expanded-menu-button cg-text-lg-500 ${isActive ? 'active' : ''} ${disabled ? 'disabled' : ''}`} onClick={(ev) => {
      if (!disabled) onClick?.(ev);
    }}>
      <div className='icon-container'>
        {icon}
      </div>
      {text}
      {!!notificationCount && <NotificationCount notificationCount={notificationCount} />}
    </div>
  );
}


export default React.memo(ExpandedMenu);