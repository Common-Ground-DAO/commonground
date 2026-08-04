// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { FloatingDelayGroup } from "@floating-ui/react";
import dayjs from "dayjs";

import Jdenticon from "../../../atoms/Jdenticon/Jdenticon";
import UserTooltip from "../../../organisms/UserTooltip/UserTooltip";
import UsernameWithVerifiedIcon from "../../../../components/molecules/UsernameWithVerifiedIcon/UsernameWithVerifiedIcon";

import './ScrollingMessageList.css';
import { useOwnUser } from "context/OwnDataProvider";
import { useUserData } from "context/UserDataProvider";
import EmptyState from "components/molecules/EmptyState/EmptyState";
import { useConnectionContext } from "context/ConnectionProvider";
import config from "common/config";
import channelDatabaseManager from "data/databases/channel";
import MessageSkeletonPlaceholder from "../MessageSkeletonPlaceholder/MessageSkeletonPlaceholder";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import Scrollable, { PositionData, ScrollableHandle } from "../../../molecules/Scrollable/Scrollable";

export type RendererProps = {
  item: Models.Message.Message;
  replyClick: (id: string, senderId: string, body: Models.Message.Body) => void;
  editClick: (message: Models.Message.Message) => void;
  selected: boolean;
  editing: boolean;
  isolatedNewMsg: boolean;
  showTimestamp: boolean;
  allCurrentItemsByIdRef: React.MutableRefObject<Map<string, Models.Message.Message>>;
  scrollToMessage?: (messageId: string) => void;
  canReply: boolean;
}

type Props= {
  itemList: Models.ItemList.ItemList<Models.Message.Message>;
  identifierKey?: string;
  scrollHelper: React.JSX.Element;
  scrollHelperRef: React.RefObject<HTMLDivElement | null>;
  Renderer: React.FC<RendererProps>;
  replyClick: (id: string, senderId: string, body: Models.Message.Body) => void;
  editClick: (message: Models.Message.Message) => void;
  messageToEdit?: Models.Message.Message;
  targetFocusId?: string;
  lastFocusedIdRef: React.MutableRefObject<string | undefined>;
  onScroll?: (deltaY: number) => void;
  channelId: string;
  scrollableRef: React.RefObject<ScrollableHandle | null>;
  scrollableInnerRef: React.RefObject<HTMLDivElement | null>;
  loadingNextRef: React.MutableRefObject<Promise<void> | null>;
  loadingPreviousRef: React.MutableRefObject<Promise<void> | null>;
  initializingItemListRef: React.MutableRefObject<Promise<void> | null>;
  messages: Models.Message.Message[];
  setMessages: React.Dispatch<React.SetStateAction<Models.Message.Message[]>>;
  canReply: boolean;
}

type MessageGroupsArray = [string, ([string, string, Models.Message.Message[]])[]][];

const SCROLL_BOTTOM_THRESHOLD = 30;
const SOFT_ITEM_LIMIT = 200;
export const BETWEEN_LOADS_TIMEOUT = 500;

/**
 * 
 * @returns true if element was found an scrolled to, false otherwise
 */
export function scrollToMessageById(scrollableRef: React.RefObject<ScrollableHandle | null>, messageId: string): boolean {
  const element = document.getElementById(messageId);
  const scrollable = scrollableRef.current;
  if (!!scrollable && !!element) {
    scrollable.scrollToElementId(messageId);
    return true;
  }
  return false;
}

export default function ScrollingMessageList(props: Props) {
  const {
    itemList,
    Renderer,
    replyClick,
    editClick,
    messageToEdit,
    targetFocusId,
    lastFocusedIdRef,
    onScroll,
    channelId,
    scrollableRef,
    scrollableInnerRef,
    messages,
    setMessages,
    loadingNextRef,
    loadingPreviousRef,
    initializingItemListRef,
    canReply,
    scrollHelper,
    scrollHelperRef,
  } = props;

  const [ showEmptyStateText, setShowEmptyStateText ] = useState<boolean>(false);
  const { webSocketState } = useConnectionContext();
  const loadTopTriggerRef = React.useRef<HTMLDivElement>(null);
  const loadBottomTriggerRef = React.useRef<HTMLDivElement>(null);
  const [ randomizeTrigger, setRandomizeTrigger ] = useState<string>('' + Math.random());
  const [nextStorage, setNextStorage] = useState<"local" | "remote" | null>(itemList.state.hasNextItemsLocally ? "local" : itemList.state.hasNextItemsOnRemote ? "remote" : null);
  const [previousStorage, setPreviousStorage] = useState<"local" | "remote" | null>(itemList.state.hasPreviousItemsLocally ? "local" : itemList.state.hasPreviousItemsOnRemote ? "remote" : null);
  const isCurrentlyScrollingRef = useRef<boolean>(false);
  const allCurrentItemsByIdRef = useRef(new Map(messages.map(m => [m.id, m])));
  const ownUser = useOwnUser();

  const showScrollHelperRef = useRef<boolean>(false);
  const setShowScrollHelper = useCallback((visible: boolean, skipCheck = false) => {
    if (showScrollHelperRef.current !== visible || skipCheck) {
      showScrollHelperRef.current = visible;
      const div = scrollHelperRef.current;
      if (!!div) {
        div.style.opacity = visible ? '1' : '0';
        div.style.pointerEvents = visible ? 'auto' : 'none';
        div.style.cursor = visible ? 'pointer' : 'default';
      }
    }
  }, []);

  useLayoutEffect(() => {
    setShowScrollHelper(showScrollHelperRef.current, true);
  }, [scrollHelper])

  const showLoadNext = useMemo(() => {
    if (messages.length > 0) {
      if (nextStorage === "local") {
        return true;
      }
      else if (nextStorage === "remote" && webSocketState === "connected") {
        return 'invisible';
      }
    }
    return false;
  }, [messages.length > 0, nextStorage, webSocketState === "connected"]);

  const showLoadPrevious = useMemo(() => {
    return messages.length > 0 && (previousStorage === "local" || (previousStorage === "remote" && webSocketState === "connected"));
  }, [messages.length > 0, previousStorage, webSocketState === "connected"]);

  const messageGroupsArray = useMemo(() => {
    const result: MessageGroupsArray = [];
    for (const message of messages) {
      const currentDay = dayjs(message.createdAt).format("MMMM DD, YYYY");
      let latestDayArray = result[result.length - 1] as typeof result[number] | undefined;
      if (!latestDayArray || latestDayArray[0] !== currentDay) {
        latestDayArray = [currentDay, []];
        result.push(latestDayArray);
      }
      let messageGroupArray = latestDayArray[1][latestDayArray[1].length - 1];
      if (!messageGroupArray || messageGroupArray[0] !== message.creatorId) {
        messageGroupArray = [message.creatorId, message.id, []];
        latestDayArray[1].push(messageGroupArray);
      }
      messageGroupArray[2].push(message);
    }
    return result;
  }, [messages]);

  const itemListStateUpdateHandler = useCallback((state: Models.ItemList.ItemListState<Models.Message.Message>) => {
    const {
      isDestroyed,
      isEmpty,
      items,
      hasNextItemsLocally,
      hasNextItemsOnRemote,
      hasPreviousItemsLocally,
      hasPreviousItemsOnRemote,
    } = state;

    if (isDestroyed) {
      console.warn("ItemList destroyed!");
      return;
    }

    if (messages !== items) {
      const allNewMessagesById = new Map(items.map(m => [m.id, m]));
      allCurrentItemsByIdRef.current = allNewMessagesById;
      setMessages(items);
      setRandomizeTrigger('' + Math.random());
    }

    if (isEmpty && items.length === 0) {
      if (!showEmptyStateText) {
        setShowEmptyStateText(true);
      }
    }
    else {
      if (showEmptyStateText) {
        setShowEmptyStateText(false);
      }
    }

    if (hasNextItemsLocally) {
      if (nextStorage !== "local") {
        setNextStorage("local");
      }
    }
    else if (hasNextItemsOnRemote) {
      if (nextStorage !== "remote") {
        setNextStorage("remote");
      }
    }
    else if (nextStorage !== null) {
      setNextStorage(null);
    }

    if (hasPreviousItemsLocally) {
      if (previousStorage !== "local") {
        setPreviousStorage("local");
      }
    }
    else if (hasPreviousItemsOnRemote) {
      if (previousStorage !== "remote") {
        setPreviousStorage("remote");
      }
    }
    else if (previousStorage !== null) {
      setPreviousStorage(null);
    }
  }, [messages, setMessages, showLoadNext, showLoadPrevious, showEmptyStateText, nextStorage, previousStorage]);

  useEffect(() => {
    itemList.addUpdateListener(itemListStateUpdateHandler);
    return () => {
      itemList.removeUpdateListener(itemListStateUpdateHandler);
    };
  }, [itemList, itemListStateUpdateHandler]);

  useEffect(() => {
    itemListStateUpdateHandler(itemList.state);
  }, [itemList]);

  const loadNext = useCallback(() => {
    if (showLoadNext && !loadingNextRef.current && !initializingItemListRef.current) {
      let promise: Promise<void> | undefined;
      const { state } = itemList;
      let shrink: number | undefined;
      if (state.items.length > SOFT_ITEM_LIMIT) {
        shrink = state.items.length - SOFT_ITEM_LIMIT;
      }
      if (state.hasNextItemsLocally) {
        promise = itemList.update({ growEnd: config.ITEMLIST_BATCH_SIZE, shrinkStart: shrink }).then(() => {
          scrollableRef.current?.lockScrollForNextUpdate({ type: 'lockByVisibleItemDate', elementClassWithTimestamp: 'message-item-content', dateOrder: 'ASC' });
        });
      }
      else if (state.hasNextItemsOnRemote && state.rangeEnd) {
        promise = channelDatabaseManager.loadItems({
          channelId,
          createdAfter: state.rangeEnd,
          order: "ASC",
        })
        .then(() => {
          // use the updated state (itemList.state can have changed) to check if we can load more
          if (itemList.state.hasNextItemsLocally) {
            scrollableRef.current?.lockScrollForNextUpdate({ type: 'lockByVisibleItemDate', elementClassWithTimestamp: 'message-item-content', dateOrder: 'ASC' });
            return itemList.update({ growEnd: config.ITEMLIST_BATCH_SIZE, shrinkStart: shrink });
          }
          else if (!itemList.state.withEndOfList) {
            console.warn("Remote items loaded but hasNextItemsLocally is still false, cannot load more");
          }
        });
      }
      if (!!promise) {
        loadingNextRef.current = promise.finally(async () => {
          await new Promise<void>(resolve => {
            setTimeout(() => {
              loadingNextRef.current = null;
              resolve();
            }, 0)
          });
        });
      }
    }
  }, [itemList, showLoadNext]);

  const loadPrevious = useCallback(() => {
    if (showLoadPrevious && !loadingPreviousRef.current && !initializingItemListRef.current) {
      let promise: Promise<void> | undefined;
      const { state } = itemList;
      let shrink: number | undefined;
      if (state.items.length > SOFT_ITEM_LIMIT) {
        shrink = state.items.length - SOFT_ITEM_LIMIT;
      }
      if (state.hasPreviousItemsLocally) {
        promise = itemList.update({ growStart: config.ITEMLIST_BATCH_SIZE, shrinkEnd: shrink }).then(() => {
          scrollableRef.current?.lockScrollForNextUpdate({ type: 'lockByVisibleItemDate', elementClassWithTimestamp: 'message-item-content', dateOrder: 'ASC' });
        });
      }
      else if (state.hasPreviousItemsOnRemote && state.rangeStart) {
        promise = channelDatabaseManager.loadItems({
          channelId,
          createdBefore: state.rangeStart,
          order: "DESC",
        })
        .then(() => {
          if (itemList.state.hasPreviousItemsLocally) {
            scrollableRef.current?.lockScrollForNextUpdate({ type: 'lockByVisibleItemDate', elementClassWithTimestamp: 'message-item-content', dateOrder: 'ASC' });
            return itemList.update({ growStart: config.ITEMLIST_BATCH_SIZE, shrinkEnd: shrink });
          }
          else if (!itemList.state.withStartOfList) {
            console.warn("Remote items loaded but hasPreviousItemsLocally is still false, cannot load more");
          }
        });
      }
      if (!!promise) {
        loadingPreviousRef.current = promise.finally(async () => {
          await new Promise<void>(resolve => {
            setTimeout(() => {
              loadingPreviousRef.current = null;
              resolve();
            }, 0)
          });
        });
      }
    }
  }, [itemList, showLoadPrevious]);

  const positionCallback: (data: PositionData) => void = useCallback((data) => {
    const scrollable = scrollableRef.current;
    const loadTopTrigger = loadTopTriggerRef.current;
    const loadBottomTrigger = loadBottomTriggerRef.current;

    if (!!scrollable) {
      if (!!loadTopTrigger && (loadTopTrigger.offsetTop + loadTopTrigger.clientHeight) > data.scrollTop && !loadingPreviousRef.current) {
        loadPrevious();
      }
      if (!!loadBottomTrigger && (data.scrollTop + data.visibleHeight) > loadBottomTrigger.offsetTop && !loadingNextRef.current) {
        loadNext();
      }

      const shouldShowScrollHelper = data.scrollTop + data.visibleHeight < data.contentHeight - SCROLL_BOTTOM_THRESHOLD;
      if (showScrollHelperRef.current !== shouldShowScrollHelper) setShowScrollHelper(shouldShowScrollHelper);
    }

    const deltaY = data.contentHeight - data.scrollTop - data.visibleHeight;
    onScroll?.(deltaY);
  }, [loadNext, loadPrevious, onScroll]);

  useLayoutEffect(() => {
    if (!targetFocusId) scrollableRef.current?.scrollToBottom();
  }, []);

  const messageGroups = useMemo(() => {
    return messageGroupsArray.map(([dateString, messageGroupsData]) => (
      <MessagesPerDay
        messageGroupsData={messageGroupsData}
        dateString={dateString}
        Renderer={Renderer}
        replyClick={replyClick}
        editClick={editClick}
        key={dateString}
        messageToEdit={messageToEdit}
        messageIdFocus={targetFocusId}
        allCurrentItemsByIdRef={allCurrentItemsByIdRef}
        canReply={canReply}
        ownUserId={ownUser?.id}
      />
    ));
  }, [messageGroupsArray, Renderer, replyClick, editClick, messageToEdit, targetFocusId, allCurrentItemsByIdRef, canReply, ownUser?.id]);

  return (
    <FloatingDelayGroup delay={{ open: 100, close: 100 }}>
      <Scrollable
        ref={scrollableRef}
        autoScroll={true}
        hideOnNoScroll={true}
        positionCallback={positionCallback}
      >
        <div
          className="scrolling-message-list-inner-container"
          ref={scrollableInnerRef}
        >
          <MessagesLoadingIndicator
            visible={showLoadPrevious}
            divRef={loadTopTriggerRef}
            randomizePlaceholderTrigger={randomizeTrigger}
          />
          {messageGroups}
          {showEmptyStateText && <div className="py-4"><EmptyState title="No messages in this chat yet" description="Be the first!" /></div>}
          <MessagesLoadingIndicator
            visible={showLoadNext}
            divRef={loadBottomTriggerRef}
            randomizePlaceholderTrigger={randomizeTrigger}
          />
        </div>
      </Scrollable>
    </FloatingDelayGroup>
  );
}

const MessagesLoadingIndicator = (props: {
  visible: boolean | 'invisible';
  divRef: React.RefObject<HTMLDivElement | null>;
  randomizePlaceholderTrigger: string;
}) => {
  const {
    visible,
    divRef,
    randomizePlaceholderTrigger,
  } = props;
  const { isMobile } = useWindowSizeContext();

  const placeholders = useMemo(() => {
    return Array(isMobile ? 4 : 5).fill(null).map((_, index) => (
      <MessageSkeletonPlaceholder key={randomizePlaceholderTrigger + index} />
    ));
  }, [isMobile, randomizePlaceholderTrigger]);

  let style: React.CSSProperties | undefined;
  if (visible === 'invisible') {
    style = { height: '1px', marginTop: '-1px', opacity: 0 };
  }

  if (!visible) {
    return null;
  }

  return (
    <div
      ref={divRef}
      style={style}
      className="message-group-container-placeholders"
    >
      {visible === true ? placeholders : null}
    </div>
  );
}

const MessagesPerDay = (props: {
  dateString: string;
  messageGroupsData: [string, string, Models.Message.Message[]][];
  Renderer: React.FC<RendererProps>,
  replyClick: (id: string, senderId: string, body: Models.Message.Body) => void,
  editClick: (message: Models.Message.Message) => void,
  messageToEdit?: Models.Message.Message;
  messageIdFocus?: string;
  allCurrentItemsByIdRef: React.MutableRefObject<Map<string, Models.Message.Message>>;
  canReply: boolean;
  ownUserId?: string;
}) => {
  const {
    dateString,
    messageGroupsData,
    Renderer,
    replyClick,
    editClick,
    messageToEdit,
    messageIdFocus,
    allCurrentItemsByIdRef,
    canReply,
    ownUserId,
  } = props;

  const messageGroups = useMemo(() => {
    return messageGroupsData.map(([creatorId, messageId, messages]) => (
      <MessagesPerUserList
        messages={messages}
        Renderer={Renderer}
        replyClick={replyClick}
        editClick={editClick}
        key={`${creatorId} ${messageId}`}
        messageToEdit={messageToEdit}
        messageIdFocus={messageIdFocus}
        allCurrentItemsByIdRef={allCurrentItemsByIdRef}
        canReply={canReply}
        ownUserId={ownUserId}
      />
    ));
  }, [messageGroupsData, Renderer, replyClick, editClick, messageToEdit, messageIdFocus, canReply, ownUserId]);

  return (
    <div key={dateString} id={`message-group-container-${dateString}`}>
      <div className="message-group-date">{dateString}</div>
      {messageGroups}
    </div>
  )
}

const MessagesPerUserList = (props: {
  messages: Models.Message.Message[],
  Renderer: React.FC<RendererProps>,
  replyClick: (id: string, senderId: string, body: Models.Message.Body) => void,
  editClick: (message: Models.Message.Message) => void,
  messageToEdit?: Models.Message.Message;
  messageIdFocus?: string;
  allCurrentItemsByIdRef: React.MutableRefObject<Map<string, Models.Message.Message>>;
  canReply: boolean;
  ownUserId?: string;
}) => {
  const { messages, Renderer, replyClick, editClick, allCurrentItemsByIdRef, canReply, ownUserId } = props;
  const { creatorId } = messages[0];
  const isSelf = creatorId === ownUserId;
  const firstPostItem = messages[0];
  const channelId = firstPostItem.channelId || '';
  const creator = useUserData(creatorId);

  const messageElements = React.useMemo(() => {
    return props.messages.map((i, index) => {
      let isolatedNewMsg = false;
      let showTimestamp = false;
      const lastItem = props.messages[index - 1];
      const nextItem = props.messages[index + 1];

      // Add top spacing if it has been 5 minutes or more since last message
      if (lastItem) {
        const lastTimeCreated = dayjs(lastItem.createdAt);
        const currCreated = dayjs(i.createdAt);
        const minutesDiff = currCreated.diff(lastTimeCreated, 'minutes');
        isolatedNewMsg = minutesDiff >= 5;
      }

      if (nextItem) {
        const nextTimeCreated = dayjs(nextItem.createdAt);
        const currCreated = dayjs(i.createdAt);
        const minutesDiff = nextTimeCreated.diff(currCreated, 'minutes');
        showTimestamp = minutesDiff >= 5;
      }

      return (
        <Renderer
          selected={i.id === props.messageIdFocus}
          editing={i.id === props.messageToEdit?.id}
          item={i}
          key={i.id}
          replyClick={replyClick}
          editClick={editClick}
          isolatedNewMsg={isolatedNewMsg}
          showTimestamp={showTimestamp}
          allCurrentItemsByIdRef={allCurrentItemsByIdRef}
          canReply={canReply}
        />
      )
    });
  }, [props.messages, props.messageIdFocus, props.messageToEdit?.id, Renderer, replyClick, editClick, allCurrentItemsByIdRef, canReply]);

  return (
    <div className={`message-group${isSelf ? ' self-group' : ''}`}>
      <div className="message-group-inner">
        <div className="message-group-icon">
          <UserTooltip
            userId={creatorId}
            isMessageTooltip={false}
            placement='right'
            channelId={channelId}
            openDelay={500}
            closeDelay={100}
          >
            <Jdenticon userId={creatorId} onlineStatus={creator?.onlineStatus} />
          </UserTooltip>
        </div>
        <div className="message-group-content">
          <div className="message-group-header">
            <UserTooltip
              userId={creatorId}
              isMessageTooltip={false}
              placement='right'
              channelId={channelId}
              openDelay={500}
              closeDelay={100}
            >
              <div className="message-group-display-name">
                <span className="flex items-center gap-1 overflow-hidden text-ellipsis">
                <UsernameWithVerifiedIcon
                  userId={creator?.id}
                  userData={creator}
                />
                </span>
              </div>
            </UserTooltip>
          </div>
          <div className="message-container">
            {messageElements}
          </div>
        </div>
      </div>
    </div>
  );
}