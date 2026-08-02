// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useLocation, useNavigate } from "react-router-dom";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import config from "../../../common/config";

import MenuButton from "../../molecules/MenuButton/MenuButton";
import { AudioWidget } from "../../molecules/AudioWidget/AudioWidget";

import { useCommunitySidebarContext } from "../CommunityViewSidebar/CommunityViewSidebarContext";
import { useNotificationContext } from "../../../context/NotificationProvider";

import useLocalStorage, { ReadArticlesState, VisitedCommunitiesState } from '../../../hooks/useLocalStorage';
import { getMobileOperatingSystem } from "./util";

import './MobileMenu.css';
import { useChats, useOwnCommunities, useOwnUser } from "context/OwnDataProvider";
import { useLiveQuery } from "dexie-react-hooks";
import data from "data";
import { getUrl } from 'common/util';
import { Bars3Icon } from "@heroicons/react/24/solid";
import { Bell, ChatsTeardrop, Compass, Storefront } from "@phosphor-icons/react";

export default function MobileMenu() {
  const navigate = useNavigate();
  const location = useLocation();
  const { chats } = useChats();
  const { unreadCount, pwaStatus } = useNotificationContext();
  const { communitySidebarIsOpen, setCommunitySidebarIsOpen, sliderTriggerRef } = useCommunitySidebarContext();
  const [visitedState] = useLocalStorage<VisitedCommunitiesState>({}, 'communities-visited-state');
  const [contentReadState,] = useLocalStorage<ReadArticlesState>({}, 'content-read-state');
  const [areNews, setAreNews] = useState<boolean>(false);
  const operatingSystem = getMobileOperatingSystem();
  const communities = useOwnCommunities();
  const ownUser = useOwnUser();

  const communityIdsRef = useRef<string[]>();
  const communityIds = useMemo(() => {
    const oldCommunityIds = communityIdsRef.current;
    if (!oldCommunityIds) {
      const newCommunityIds: string[] = communities.map(c => c.id);
      communityIdsRef.current = newCommunityIds;
      return newCommunityIds;
    }
    else {
      let changed = false;
      const newCommunityIds: string[] = [];
      for (let i = 0; i < communities.length; i++) {
        const community = communities[i];
        if (oldCommunityIds[i] !== community.id) {
          changed = true;
        }
        newCommunityIds.push(community.id);
      }
      if (!changed && newCommunityIds.length !== oldCommunityIds.length) {
        changed = true;
      }
      if (changed) {
        communityIdsRef.current = newCommunityIds;
        return newCommunityIds;
      }
      else {
        return oldCommunityIds;
      }
    }
  }, [communities]);

  const unreadCommunities = useLiveQuery(() => {
    if (communityIds) {
      return data.community.areCommunitiesUnread(communityIds);
    }
  }, [communityIds]);

  let unreadConversations = useMemo(() => chats.reduce<number>((agg, chat) => agg + (chat.unread || 0), 0), [chats]);

  /* const isRecent = (date: Date): boolean => {
    const createdDate = dayjs(date);
    const isRecent = dayjs().diff(createdDate, 'd') < 7;
    return isRecent;
  }; */

  useEffect(()=> {
    const loadNewCommunities = async () => {
      // Todo
      return [];
      // const communities = await cgApi.read.getAllGroups(0, 'new');
      // return communities.filter(community => {
      //   const isNew = isRecent(community.createdAt);
      //   const isVisited = visitedState[community.id];
      //   return (isNew && !isVisited);
      // });
    };
    const loadCommunityContent = async () => {
      // Todo
      return [];
      // const communityContent = await cgApi.read.getCommunityContent(0, undefined, 'published');
      // return communityContent.filter(contentItem => {
      //   const isNew = contentItem.published ? isRecent(contentItem.published) : false;
      //   const isRead = contentReadState[contentItem.id];
      //   return isNew && !isRead;
      // });
    };
    const loadPublicUserPosts = async () => {
      // Todo
      return [];
      // const allBlogs = await cgApi.read.loadBlogs(0, 'all');
      // return allBlogs.filter(blog => {
      //   const isNew = blog.published ? isRecent(blog.published) : false;
      //   const isRead = contentReadState[blog.id];
      //   return isNew && !isRead;
      // });
    };
    const loadNews = async () => {
      const newCommunities = await loadNewCommunities();
      let thereAreNews = (!!newCommunities && newCommunities.length > 0);
      if (!thereAreNews) {
        const news = await loadCommunityContent();
        thereAreNews = (!!news && news.length > 0);
      }
      if (!thereAreNews) {
        const newBlogs = await loadPublicUserPosts();
        thereAreNews = (!!newBlogs && newBlogs.length > 0);
      }
      setAreNews(thereAreNews)
    }
    loadNews();
  }, [setAreNews, visitedState, contentReadState]);

  const handleCommunityMenuItemClick = useCallback(() => {
    setCommunitySidebarIsOpen(old => !old);
  }, []);

  const isActiveButton = useCallback((prefix: string): boolean => {
    if (prefix === "/") {
      return !communitySidebarIsOpen && location.pathname === "/";
    }
    else {
      return !communitySidebarIsOpen && location.pathname.startsWith(prefix)
    }
  }, [communitySidebarIsOpen, location.pathname]);

  const onHomeClick = useCallback(() => {
    if (location.pathname !== '/') {
      navigate(getUrl({ type: 'home' }));
    } else {
      document.getElementById('home-scrollable')?.scrollTo({top: 0, behavior: 'smooth'});
    }
  }, [location.pathname, navigate]);

  const homeActive = isActiveButton('/') || isActiveButton('/e/');
  const homeBtn = useMemo(() => (
    <MenuButton
      icon={<Bars3Icon className="w-6 h-6" />}
      isActive={communitySidebarIsOpen}
      onClick={handleCommunityMenuItemClick}
      showDot={unreadCommunities}
      buttonRef={sliderTriggerRef}
    />
  ), [communitySidebarIsOpen, handleCommunityMenuItemClick, unreadCommunities]);
  const browseBtn = useMemo(() => (
    <MenuButton
      icon={<Compass weight="duotone" className="w-6 h-6" />}
      isActive={homeActive}
      onClick={onHomeClick}
      showDot={areNews}
    />
  ), [homeActive, areNews, onHomeClick]);
  const appStoreBtn = useMemo(() => (
      <MenuButton
        icon={<Storefront weight='duotone' className='h-6 w-6' />}
        isActive={isActiveButton(getUrl({type: 'appstore'}))}
        onClick={() => navigate(getUrl({type: 'appstore'}))}
      />
    ), [isActiveButton, navigate]);
  const chatBtn = useMemo(() => (
    <MenuButton
      icon={<ChatsTeardrop weight="duotone" className="w-6 h-6" />}
      isActive={isActiveButton(getUrl({ type: 'chats' }))}
      onClick={() => navigate(getUrl({ type: 'chats' }))}
      notificationCount={unreadConversations || undefined}
      disabled={!ownUser?.id}
    />
  ), [unreadConversations, ownUser?.id, isActiveButton]);
  const notificationBtn = useMemo(() => (
    <MenuButton
      icon={<Bell weight="duotone" className="w-6 h-6"/>}
      isActive={isActiveButton(getUrl({ type: 'notifications' }))}
      onClick={() => {
        if (config.NOTIFICATIONS_PAGE_ENABLED) { navigate(getUrl({ type: 'notifications' })) }
      }}
      notificationCount={unreadCount}
      disabled={!ownUser?.id}
    />
  ), [unreadCount, ownUser?.id, isActiveButton]);
  
  const profileBtn = useMemo(() => (
    <AudioWidget text="Profile" isActive={false} />
  ), [isActiveButton]);

  return (
    <div className={`mobile-menu ${operatingSystem === "Android" ? "mobile-menu-android" : pwaStatus === "InMobilePWA" ? "mobile-menu-ios-pwa" : 'mobile-menu-ios-web'}`}>
      {homeBtn}
      {browseBtn}
      {appStoreBtn}
      {chatBtn}
      {notificationBtn}
      {profileBtn}
    </div>
  );
}
