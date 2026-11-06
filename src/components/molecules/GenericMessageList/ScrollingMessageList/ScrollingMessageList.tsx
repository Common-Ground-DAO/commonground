// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useLayoutEffect, useMemo, useRef } from "react";
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
import type { ChannelWindow } from "data/chat/types";
import MessageSkeletonPlaceholder from "../MessageSkeletonPlaceholder/MessageSkeletonPlaceholder";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import Scrollable, { PositionData, ScrollableHandle } from "../../../molecules/Scrollable/Scrollable";
import { SCROLL_BOTTOM_THRESHOLD, showsScrollHelper } from "../scrollHelper";

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
  /** the window the list shows; `state` is its current state */
  channelWindow: ChannelWindow;
  state: Models.ItemList.ItemListState<Models.Message.Message>;
  identifierKey?: string;
  /** shows / hides the scroll-down helper (stable; GenericMessageList's `scrollHelper.ts` control) */
  setShowScrollHelper: (visible: boolean) => void;
  Renderer: React.FC<RendererProps>;
  replyClick: (id: string, senderId: string, body: Models.Message.Body) => void;
  editClick: (message: Models.Message.Message) => void;
  messageToEdit?: Models.Message.Message;
  targetFocusId?: string;
  onScroll?: (deltaY: number) => void;
  /** reports whether the list is scrolled to the bottom (on every change) */
  onAtBottomChange?: (atBottom: boolean) => void;
  scrollableRef: React.RefObject<ScrollableHandle | null>;
  scrollableInnerRef: React.RefObject<HTMLDivElement | null>;
  loadingNextRef: React.MutableRefObject<Promise<void> | null>;
  loadingPreviousRef: React.MutableRefObject<Promise<void> | null>;
  /** number of the list's own inits / jumps in flight (no paging meanwhile) */
  initializingRef: React.MutableRefObject<number>;
  canReply: boolean;
}

type MessageGroupsArray = [string, ([string, string, Models.Message.Message[]])[]][];

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

/** paging sentinel of one end: items trimmed off in memory, more on the server, or none */
function pagingSource(hasLocally: boolean, hasOnRemote: boolean): "local" | "remote" | null {
  return hasLocally ? "local" : hasOnRemote ? "remote" : null;
}

export default function ScrollingMessageList(props: Props) {
  const {
    channelWindow,
    state,
    Renderer,
    replyClick,
    editClick,
    messageToEdit,
    targetFocusId,
    onScroll,
    onAtBottomChange,
    scrollableRef,
    scrollableInnerRef,
    loadingNextRef,
    loadingPreviousRef,
    initializingRef,
    canReply,
    setShowScrollHelper,
  } = props;

  const messages = state.items;
  const { webSocketState } = useConnectionContext();
  const loadTopTriggerRef = React.useRef<HTMLDivElement>(null);
  const loadBottomTriggerRef = React.useRef<HTMLDivElement>(null);
  const nextStorage = pagingSource(state.hasNextItemsLocally, state.hasNextItemsOnRemote);
  const previousStorage = pagingSource(state.hasPreviousItemsLocally, state.hasPreviousItemsOnRemote);
  // isEmpty counts server items only: a pending send is shown in an empty channel
  const showEmptyStateText = state.isEmpty && messages.length === 0;
  const ownUser = useOwnUser();

  // reply-parent lookup of the renderers; current before they render
  const allCurrentItemsByIdRef = useRef(new Map<string, Models.Message.Message>());
  const randomizeTrigger = useMemo(() => {
    allCurrentItemsByIdRef.current = new Map(messages.map(m => [m.id, m]));
    return '' + Math.random();
  }, [messages]);

  // a list (of a new channel) starts hidden until its first position report
  useLayoutEffect(() => {
    setShowScrollHelper(false);
  }, [setShowScrollHelper]);

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

  /** one load per end at a time; the scroll lock is set by the window listener */
  const startLoad = useCallback((
    ref: React.MutableRefObject<Promise<void> | null>,
    load: () => Promise<void>,
    trimFrom: 'start' | 'end',
  ) => {
    ref.current = load()
      .then(() => {
        // keep the rendered list bounded: drop the far end once it grew too long
        if (channelWindow.state.items.length > SOFT_ITEM_LIMIT) {
          channelWindow.trim({ keep: SOFT_ITEM_LIMIT, from: trimFrom });
        }
      })
      .catch(e => {
        console.error("Error loading messages", e);
      })
      .finally(async () => {
        await new Promise<void>(resolve => {
          setTimeout(() => {
            ref.current = null;
            resolve();
          }, 0);
        });
      });
  }, [channelWindow]);

  const loadNext = useCallback(() => {
    if (showLoadNext && !loadingNextRef.current && initializingRef.current === 0) {
      startLoad(loadingNextRef, () => channelWindow.loadNewer(config.ITEMLIST_BATCH_SIZE), 'start');
    }
  }, [channelWindow, showLoadNext, startLoad]);

  const loadPrevious = useCallback(() => {
    if (showLoadPrevious && !loadingPreviousRef.current && initializingRef.current === 0) {
      startLoad(loadingPreviousRef, () => channelWindow.loadOlder(config.ITEMLIST_BATCH_SIZE), 'end');
    }
  }, [channelWindow, showLoadPrevious, startLoad]);

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

      const shouldShowScrollHelper = showsScrollHelper(data);
      // both receivers ignore repeats
      setShowScrollHelper(shouldShowScrollHelper);
      onAtBottomChange?.(!shouldShowScrollHelper);
    }

    const deltaY = data.contentHeight - data.scrollTop - data.visibleHeight;
    onScroll?.(deltaY);
  }, [loadNext, loadPrevious, onScroll, onAtBottomChange, setShowScrollHelper]);

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
        topAndBottomThreshold={SCROLL_BOTTOM_THRESHOLD}
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