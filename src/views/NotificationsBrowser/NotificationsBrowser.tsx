// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Scrollable, { ScrollableHandle } from "../../components/molecules/Scrollable/Scrollable";
import { useWindowSizeContext } from "../../context/WindowSizeProvider";
import NotificationMessage from '../../components/molecules/NotificationMessage/NotificationMessage';
import NotificationsTypeSelector from '../../components/molecules/NotificationTypeSelector/NotificationTypeSelector';
import { createSearchParams, useNavigate, useParams } from 'react-router-dom';
import ToggleInputField from '../../components/molecules/inputs/ToggleInputField/ToggleInputField';
import SearchField from '../../components/atoms/SearchField/SearchField';
import { ReactComponent as SpinnerIcon } from '../../components/atoms/icons/16/Spinner.svg';
import useLocalStorage from '../../hooks/useLocalStorage';
import { useLiveQuery } from 'dexie-react-hooks';
import data from 'data';
import EmptyState from 'components/molecules/EmptyState/EmptyState';

import './NotificationsBrowser.css';
import TextChannel from 'components/organisms/TextChannel/TextChannel';
import { getUrl } from 'common/util';
import { useConnectionContext } from 'context/ConnectionProvider';
import { isElementOverlappingViewport } from 'hooks/useOnScreen';
import shortUUID from 'short-uuid';
import NotificationBanner from 'components/molecules/NotificationBanner/NotificationBanner';
import { useOwnUser } from 'context/OwnDataProvider';
import { useMultipleUserData } from 'context/UserDataProvider';
import { filterNotifications } from './NotificationsBrowser.helper';
import { useMultipleCommunityListViews } from 'context/CommunityListViewProvider';
import config from 'common/config';
import { BETWEEN_LOADS_TIMEOUT } from 'components/molecules/GenericMessageList/ScrollingMessageList/ScrollingMessageList';
import { useCommunityJoinedContext } from 'context/CommunityJoinedProvider';
import { useSidebarDataDisplayContext } from 'context/SidebarDataDisplayProvider';

const t = shortUUID();

export default function NotificationsBrowser() {
  const navigate = useNavigate();
  const [selectedNotificationType, setSelectedNotificationType] = useState<Models.Notification.Type | undefined>();
  const { notificationShortUuid } = useParams<'notificationShortUuid'>();
  const [hideRead, setHideRead] = useLocalStorage(false, 'hide-read');
  const [search, setSearch] = useState('');

  const loadingRef = useRef<HTMLDivElement>(null);
  const { isMobile } = useWindowSizeContext();

  const listener: Models.ItemList.ItemListUpdateListener<Models.Notification.Notification> = useCallback((data) => {
    if (!_readyToLoadRef.current && data.items.length > 0) {
      _readyToLoadRef.current = true;
      setReadyToLoad(true);
    }
    if (!data.isDestroyed) {
      setItems(data.items);
    }
    else {
      setItems([]);
    }
  }, []);

  const itemList = useMemo(() => {
    const _itemList = data.notification.createItemList();
    _itemList
      .init({ type: 'recent' })
      .then(itemCount => {
        itemList.addUpdateListener(listener);
        listener(itemList.state);
      });
    return _itemList;
  }, []);

  useEffect(() => {
    return () => {
      itemList.removeUpdateListener(listener);
    };
  }, [itemList, listener]);

  const [items, setItems] = useState<Models.Notification.Notification[]>(itemList.items);
  const { webSocketState } = useConnectionContext();
  const { openModal } = useCommunityJoinedContext();
  const { currentData, showTooltip } = useSidebarDataDisplayContext();
  const [readyToLoad, setReadyToLoad] = useState<boolean>(false);
  const [activeCommunityId, setActiveCommunityId] = useState<string | undefined>();
  const [activeChannelId, setActiveChannelId] = useState<string | undefined>();
  const [activeMessageId, setActiveMessageId] = useState<string | undefined>();
  const [activeArticleId, setActiveArticleId] = useState<string | undefined>();
  const [navigateWhenNotificationExists, setNavigateWhenNotificationExists] = useState<boolean>(false);
  const scrollableRef = useRef<ScrollableHandle>(null);
  const _readyToLoadRef = useRef<boolean>(false);
  const loadPreviousTriggered = useRef<boolean>(false);
  const ownUser = useOwnUser();

  // destroy itemList on final unmount
  useEffect(() => {
    return () => {
      itemList.destroy();
    };
  }, []);

  const communityIds = useMemo(() => {
    return Array.from(new Set(items.map(item => item.subjectCommunityId).filter(id => id !== null) as string[]))
  }, [items]);

  const communities = useMultipleCommunityListViews(Array.from(communityIds));

  const relevantChannels = useLiveQuery(() => {
    const ids = new Set<string>(items.map(item => item.extraData?.channelId).filter(id => id !== null) as string[]);
    if (ids.size > 0) {
      return data.community.getChannelsById(Array.from(ids));
    }
  }, [items]);

  const allRelevantUserIds = useMemo(() => {
    const ids = new Set<string>(items.map(item => item.subjectUserId).filter(id => id !== null) as string[]);
    return Array.from(ids);
  }, [items]);

  const allRelevantUsers = useMultipleUserData(allRelevantUserIds);

  const community = useLiveQuery(() => {
    if (!!activeCommunityId) {
      return data.community.getCommunityDetailView(activeCommunityId);
    }
  }, [activeCommunityId]);

  const channel = useLiveQuery(() => {
    if (!!activeCommunityId && !!activeChannelId) {
      return data.community.getChannel(activeCommunityId, activeChannelId);
    }
  }, [activeCommunityId, activeChannelId]);

  const area = useLiveQuery(() => {
    if (!!channel && channel.areaId !== null) {
      return data.community.getArea(channel.communityId, channel.areaId);
    }
  }, [channel]);

  const selectedId: string | undefined = useMemo(() => {
    return notificationShortUuid ? t.toUUID(notificationShortUuid) : undefined;
  }, [notificationShortUuid]);

  const { state } = itemList;

  const hasMoreItems = state.hasPreviousItemsLocally || state.hasPreviousItemsOnRemote || false;

  const events = useMemo(() => {
    let events = [...items].reverse();
    if (selectedNotificationType) {
      events = events.filter(ev => ev.type === selectedNotificationType);
    }

    if (hideRead) {
      events = events.filter(ev => !ev.read || ev.id === selectedId);
    }

    if (search) {
      events = filterNotifications(events, search, {
        channels: relevantChannels || [],
        communities: communities || {},
        userData: allRelevantUsers
      });
    }

    return events;
  }, [items, selectedNotificationType, hideRead, search, selectedId, relevantChannels, communities, allRelevantUsers]);

  useEffect(() => {
    if (!selectedId) {
      setActiveChannelId(undefined);
      setActiveCommunityId(undefined);
      setActiveMessageId(undefined);
    }
    else {
      const notification = events.find(n => n.id === selectedId);
      if (!!notification) {
        if (notification.read === false) {
          setTimeout(() => data.notification.markAsRead(selectedId), 0);
        }
        if (navigateWhenNotificationExists === false) {
          switch (notification.type) {
            case 'Mention':
            case 'Reply': {
              const channelId = notification.extraData?.channelId;
              const {
                subjectCommunityId: communityId,
                subjectItemId: messageId,
              } = notification;
              const articleId = notification.subjectArticleId || (notification.extraData && ('articleId' in notification.extraData) ? notification.extraData.articleId : undefined);
              if (!messageId || (!articleId && !communityId)) {
                throw new Error(`notification.extraData, subjectIds are missing, but is required in Reply and Mention notifications`);
              }

              if (notification.extraData?.type === 'articleData' && articleId && articleId !== activeArticleId) {
                if (notification.extraData.articleOwner.type === 'community') {
                  showTooltip({
                    type: 'article',
                    articleId,
                    communityId: notification.extraData.articleOwner.communityId,
                  });
                } else {
                  showTooltip({
                    type: 'user-article',
                    articleId,
                    userId: notification.extraData.articleOwner.userId,
                  });
                }
              }

              setActiveChannelId(channelId);
              setActiveCommunityId(communityId || undefined);
              setActiveMessageId(messageId);
              setActiveArticleId(articleId || undefined);
            }
          }
        }
      }
      else {
        if (navigateWhenNotificationExists !== isMobile) {
          setNavigateWhenNotificationExists(isMobile);
        }
        setActiveChannelId(undefined);
        setActiveCommunityId(undefined);
        setActiveMessageId(undefined);
      }
    }
  }, [activeArticleId, currentData, events, isMobile, navigateWhenNotificationExists, selectedId, showTooltip]);

  useEffect(() => {
    if (navigateWhenNotificationExists === true) {
      const notification = events.find(n => n.id === selectedId);
      if (!!notification) {
        switch (notification.type) {
          case 'Mention':
          case 'Reply': {
            const channelId = notification.extraData?.channelId;
            const {
              subjectCommunityId: communityId,
              subjectItemId: messageId,
              subjectArticleId: articleId,
            } = notification;
            if (!messageId || (!communityId && !articleId)) {
              throw new Error(`notification.extraData, subjectIds are missing, but is required in Reply and Mention notifications`);
            }
            if (!!community && !!channelId && community.id === communityId) {
              setNavigateWhenNotificationExists(false);
              navigate({
                pathname: getUrl({
                  type: "community-channel",
                  community,
                  channel: {
                    channelId,
                    url: null,
                  },
                }),
                search: createSearchParams({
                  messageId,
                  fromNotifications: 'true',
                }).toString()
              });
            }
            else {
              setActiveChannelId(channelId);
              setActiveCommunityId(communityId || undefined);
              setActiveMessageId(messageId);
              setActiveArticleId(articleId || undefined);
            }
          }
        }
      }
    }
  }, [community, events, navigate, navigateWhenNotificationExists, selectedId, showTooltip]);

  const onMemberListToggle = useCallback(() => { }, []);

  let notificationContent = useMemo(() => {
    if (
      !!community && community.id === activeCommunityId &&
      !!channel && channel.channelId === activeChannelId
    ) {
      return (
        <TextChannel
          key={activeChannelId}
          channel={channel}
          community={community}
          area={!!area && area.id === channel.areaId ? area : undefined}
          memberListIsExpanded={false}
          messageIdFocus={activeMessageId}
          onMemberListToggle={onMemberListToggle}
          showNotificationHeader
        />
      );
    }
    else {
      return (
        <div className='notifications-content-placeholder'>
          {/* <img src={EmptyNotifications} alt="Empty Notifications" />
          <span>Select something on the left to jump there in hyperspeed</span> */}
        </div>
      );
    }

  }, [activeChannelId, activeCommunityId, activeMessageId, area, channel, community, onMemberListToggle]);

  const onMessageClick = useCallback((notification: Models.Notification.Notification) => {
    return async () => {
      switch (notification.type) {
        case 'Mention':
          case 'Reply': {
          const articleId = notification.subjectArticleId || (notification.extraData && ('articleId' in notification.extraData) ? notification.extraData.articleId : undefined);
          const community = notification.subjectCommunityId !== null ? communities?.[notification.subjectCommunityId] : undefined;
          if (isMobile && !!community) {
            const channelId = notification.extraData?.channelId;
            const messageId = notification.subjectItemId;
            if (!channelId || !messageId) {
              throw new Error(`notification.extraData, subjectCommunityId or subjectItemId is missing, but is required in Reply notifications`);
            }
            navigate({
              pathname: getUrl({
                type: "community-channel",
                community,
                channel: {
                  channelId,
                  url: null,
                },
              }),
              search: createSearchParams({
                messageId,
                fromNotifications: 'true',
              }).toString()
            });
          } else if (articleId) {
            // const isAlreadyOpen = currentData?.type === 'article' && currentData.articleId === articleId;
            if (notification.extraData?.type === 'articleData' && articleId) {
              if (notification.extraData.articleOwner.type === 'community') {
                showTooltip({
                  type: 'article',
                  articleId,
                  communityId: notification.extraData.articleOwner.communityId,
                });
              } else {
                showTooltip({
                  type: 'user-article',
                  articleId,
                  userId: notification.extraData.articleOwner.userId,
                });
              }
            }
          } else {
            navigate(getUrl({ type: "notification", notification: { id: notification.id } }));
          }
          break;
        }
        case 'Approval': {
          const community = notification.subjectCommunityId !== null ? communities?.[notification.subjectCommunityId] : undefined;
          if (community) {
            navigate({
              pathname: getUrl({
                type: "community-lobby",
                community,
              })
            });

            if (notification.extraData?.type === 'approvalData' && notification.extraData.approved) {
              openModal(community.id);
            }
          }
        }
      }
      if (notification.read === false) {
        await data.notification.markAsRead(notification.id);
      }
    }
  }, [communities, isMobile, navigate, openModal, showTooltip]);

  const toggleHideRead = useCallback(() => {
    setHideRead(last => !last);
    navigate(getUrl({ type: "notifications" }));
  }, [navigate, setHideRead]);

  const loadMore = useCallback(() => {
    if (!loadPreviousTriggered.current) {
      loadPreviousTriggered.current = true;
      const { state: { hasPreviousItemsLocally, hasPreviousItemsOnRemote, rangeStart } } = itemList;
      if (hasPreviousItemsLocally) {
        itemList.update({ growStart: config.ITEMLIST_BATCH_SIZE })
          .then(() => {
            scrollableRef.current?.lockScrollForNextUpdate({ type: 'lockByVisibleItemDate', elementClassWithTimestamp: 'notificationMessage', dateOrder: 'DESC' });
          })
          .finally(() => {
            setTimeout(() => {
              loadPreviousTriggered.current = false;
            }, BETWEEN_LOADS_TIMEOUT);
          });
      }
      else if (hasPreviousItemsOnRemote && rangeStart) {
        data.notification.loadItems({ order: 'DESC', createdBefore: rangeStart })
          .then(() => {
            if (itemList.state.hasPreviousItemsLocally) {
              return itemList.update({ growStart: config.ITEMLIST_BATCH_SIZE })
                .then(() => {
                  scrollableRef.current?.lockScrollForNextUpdate({ type: 'lockByVisibleItemDate', elementClassWithTimestamp: 'notificationMessage', dateOrder: 'DESC' });
                });
            }
          })
          .finally(() => {
            setTimeout(() => {
              loadPreviousTriggered.current = false;
            }, BETWEEN_LOADS_TIMEOUT);
          });
      }
      else {
        console.log('NotificationBrowser: No more items to load');
        loadPreviousTriggered.current = false;
      }
    }

  }, [itemList]);

  const messageObserver = useMemo(() => {
    const observer = new IntersectionObserver(
      (results) => {
        for (const element of results) {
          if (element.isIntersecting) {
            loadMore();
          }
        }
      }
    );
    return observer;
  }, []);

  const loadingItem = useMemo(() => {
    return <div className='notifications-loading-item' ref={loadingRef}>
      <div className='spinner'>
        <SpinnerIcon />
      </div>
    </div>;
  }, []);

  useEffect(() => {
    const loadingDiv = loadingRef.current;
    if (loadingDiv && webSocketState === "connected") {
      setTimeout(() => {
        if (isElementOverlappingViewport(loadingDiv)) {
          loadMore();
        }
      }, 100);
      messageObserver.observe(loadingDiv);
      return () => {
        messageObserver.unobserve(loadingDiv);
      };
    }
  }, [messageObserver, hasMoreItems, readyToLoad, itemList, webSocketState]);

  const emptyMessage = useMemo(() => {
    return <EmptyState
      title='No notifications'
      description='Enjoy your day!'
    />
  }, []);

  return <div className='layout-notifications'>
    <div className="notifications-menu">
      {isMobile && <div className='notifications-mobile-header'>
        Notifications
      </div>}
      <div className='notifications-menu-header'>
        <div className='notifications-menu-header-top'>
          <NotificationsTypeSelector selectedOption={selectedNotificationType} setSelectedOption={setSelectedNotificationType} />
          <div className='notifications-read-toggle' onClick={toggleHideRead}>
            <ToggleInputField toggled={hideRead} />
            <span>Hide read</span>
          </div>
        </div>
        <SearchField value={search} onChange={setSearch} />
      </div>
      {!!ownUser && <NotificationBanner />}
      <Scrollable
        hideOnNoScroll={true}
        hideOnNoScrollDelay={600}
        ref={scrollableRef}
      >
        <div className='notifications-container'>
          {events.map(notification => <NotificationMessage
            key={notification.id}
            selected={notification.id === selectedId}
            notification={notification}
            onClick={onMessageClick(notification)}
          />)}
          {events.length === 0 && emptyMessage}
          {hasMoreItems && readyToLoad && webSocketState === "connected" && loadingItem}
        </div>
      </Scrollable>
    </div>
    {!isMobile && <div className="notifications-content">
      {notificationContent}
    </div>}
  </div>
}