// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Descendant } from 'slate';
import EditFieldThree from '../../organisms/EditField/EditField';
import { convertToFieldFormat } from '../../organisms/EditField/EditField.helpers';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import ScrollingMessageList, { RendererProps } from './ScrollingMessageList/ScrollingMessageList';
import './GenericMessageList.css';
import { useWindowSizeContext } from '../../../context/WindowSizeProvider';
import { useMobileLayoutContext } from '../../../views/Layout/MobileLayout';
import Button from 'components/atoms/Button/Button';
import { useNavigate, useSearchParams } from 'react-router';
import { ArrowLeftIcon } from '@heroicons/react/20/solid';
import { ArrowDownCircleIcon } from '@heroicons/react/24/solid';
import useLocalStorage from 'hooks/useLocalStorage';
import { getUrl } from 'common/util';
import { useConnectionContext } from 'context/ConnectionProvider';
import { useSafeCommunityContext } from 'context/CommunityProvider';
import JoinCommunityButton from 'components/atoms/JoinCommunityButton/JoinCommunityButton';
import { useTypingBroadcaster } from 'hooks/useTypingBroadcaster';
import TypingIndicator from 'components/molecules/TypingIndicator/TypingIndicator';
import { useSnackbarContext } from 'context/SnackbarContext';
import { ScrollableHandle } from '../../molecules/Scrollable/Scrollable';
import { chat } from 'data/chat/runtime';
import { WINDOW_ERROR, type ChannelWindow } from 'data/chat/types';
import { useChannelReadMarking } from 'hooks/useChannelReadMarking';
import { consumesIntent, leavesBottom, scrollActionForChange, type ResetIntent, type ScrollAction } from './scrollAnchoring';

type Props = {
  channelName?: string;
  channelId: string;
  Renderer: React.FC<RendererProps & {
    channelId: string;
  }>;
  // createItem returns true or false, stating whether to clear the input field
  createMessage: (body: Models.Message.Body, attachments: Models.Message.Attachment[]) => Promise<boolean>;
  replyClick: (id: string, senderId: string, body: Models.Message.Body) => void;
  editClick: (message: Models.Message.Message) => void;
  editMessage: (originalMessage: Models.Message.Message, body: Models.Message.Body, attachments: Models.Message.Attachment[]) => Promise<boolean>;
  messageToEdit?: Models.Message.Message;
  replyingTo: {
    id: string;
    senderId: string;
    body: Models.Message.Body;
  } | null;
  cancelReply: () => void;
  writingForbiddenMessage?: string;
  disableAttachments?: true;
  messageIdFocus?: string;
  hideInput?: boolean;
  onMobileFocus?: (focused: boolean) => void;
  callMode?: true;
};

/** a window together with its latest state (always from the same window) */
type WindowView = {
  window: ChannelWindow;
  state: Models.ItemList.ItemListState<Models.Message.Message>;
};

export const JOINCOMMUNITY_MUTED_MESSAGE = 'Join the community to chat here';
const BOTTOM_FIXED_MENU_TOGGLE = 50;

function slateHasText(nodes: Descendant[] | undefined): boolean {
  if (!nodes) {
    return false;
  }
  const collect = (node: any): string => {
    if (typeof node?.text === 'string') {
      return node.text;
    }
    if (Array.isArray(node?.children)) {
      return node.children.map(collect).join('');
    }
    return '';
  };
  return nodes.map(collect).join('').trim().length > 0;
}

export default function GenericMessageList(props: Props) {
  const {
    channelId,
    Renderer,
    createMessage,
    replyClick,
    messageToEdit,
    replyingTo,
    cancelReply,
    writingForbiddenMessage,
    editClick,
    editMessage,
    disableAttachments,
    hideInput,
    onMobileFocus,
    callMode
  } = props;
  const { isMobile } = useWindowSizeContext();
  const { isMenuHiddenRef, setMenuHidden } = useMobileLayoutContext();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const communityContext = useSafeCommunityContext();
  const { webSocketState } = useConnectionContext();
  const { showSnackbar } = useSnackbarContext();
  const fromNotifications = !!searchParams.get('fromNotifications');

  const [isInputFocused, _setInputFocused] = useState(false);
  const [hideNotificationBanner, setHideNotificationBanner] = useState(false);
  const editFieldRef = useRef<React.ElementRef<typeof EditFieldThree>>(null);
  const [messageStateLocalStorage, setMessageStateLocalStorage] = useLocalStorage<undefined | Descendant[]>(undefined, `_message_state_of_channel_${channelId}`);
  const messageDataRef = useRef<undefined | Descendant[]>(undefined);
  const messageDataUpdateRef = useRef<any>(null);
  const scrollableRef = useRef<ScrollableHandle>(null);
  const scrollableInnerRef = useRef<HTMLDivElement>(null);
  const loadingNextRef = useRef<Promise<void> | null>(null);
  const loadingPreviousRef = useRef<Promise<void> | null>(null);
  /** the list's own inits / jumps in flight (paging waits) */
  const initializingRef = useRef<number>(0);

  const [view, setView] = useState<WindowView | null>(null);
  /** the newest view, updated synchronously in the window listener */
  const viewRef = useRef<WindowView | null>(null);
  /** what the list's pending init / jump / jumpToLatest should scroll to */
  const resetIntentRef = useRef<ResetIntent | null>(null);
  /** an init that failed (offline, server error): retried once live again */
  const retryInitRef = useRef<(() => void) | null>(null);
  const atBottomRef = useRef<boolean>(true);
  const [atBottom, setAtBottom] = useState<boolean>(true);
  const webSocketConnectedRef = useRef(webSocketState === 'connected');
  webSocketConnectedRef.current = webSocketState === 'connected';
  const showSnackbarRef = useRef(showSnackbar);
  showSnackbarRef.current = showSnackbar;

  const [targetFocusId, _setTargetFocusId] = useState<string | undefined>(props.messageIdFocus);
  const targetFocusIdRef = useRef(targetFocusId);
  targetFocusIdRef.current = targetFocusId;
  const messageIdFocusRef = useRef(props.messageIdFocus);
  messageIdFocusRef.current = props.messageIdFocus;
  const lastFocusedIdRef = useRef<string | undefined>(undefined);
  const lastScrollToMessageRef = useRef<string | undefined>(undefined);

  const setTargetFocusId = useCallback((id: string | undefined) => {
    lastFocusedIdRef.current = undefined;
    if (id !== targetFocusIdRef.current) {
      _setTargetFocusId(id);
    }
    else {
      _setTargetFocusId(undefined);
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          _setTargetFocusId(id);
        });
      });
    }
  }, []);

  useEffect(() => {
    if (props.messageIdFocus !== targetFocusId) {
      lastFocusedIdRef.current = undefined;
      _setTargetFocusId(props.messageIdFocus);
    }
  // do not include targetFocusId here, this should only trigger
  // if the one from props changes
  }, [props.messageIdFocus]);

  const mentionableUsersSource = useMemo(() => {
    if (communityContext.state === 'loaded') {
      return {
        type: 'community-channel' as 'community-channel',
        communityId: communityContext.community.id,
        channelId,
      };
    }
  }, [communityContext.state, channelId, 'community' in communityContext ? communityContext.community.id : undefined]);

  const applyScrollAction = useCallback((action: ScrollAction) => {
    const scrollable = scrollableRef.current;
    switch (action.type) {
      case 'lock':
        scrollable?.lockScrollForNextUpdate(action.lock);
        break;
      case 'scrollToBottom':
        scrollable?.scrollToBottom();
        break;
      case 'scrollToElement':
        scrollable?.scrollToElementId(action.elementId);
        break;
    }
  }, []);

  /**
   * init / jump of the current window. Resolves with the item count, or
   * null when it did not apply (superseded, unmounted, failed).
   */
  const runInit = useCallback((
    options: Models.ItemList.ItemListInitOptions,
    intent: ResetIntent,
  ): Promise<number | null> => {
    const current = viewRef.current;
    if (!current) return Promise.resolve(null);
    const w = current.window;
    retryInitRef.current = null;
    resetIntentRef.current = intent;
    initializingRef.current++;
    const isJump = options.type === 'atItemId';
    return w.init(options)
      .then(count => count as number | null, (e: unknown) => {
        const message = e instanceof Error ? e.message : '';
        if (message === WINDOW_ERROR.SUPERSEDED || viewRef.current?.window !== w) return null;
        if (resetIntentRef.current === intent) resetIntentRef.current = null;
        if (message === WINDOW_ERROR.NOT_FOUND) {
          showSnackbarRef.current({ text: "This message could not be found", type: 'warning' });
        }
        else {
          if (webSocketConnectedRef.current) {
            showSnackbarRef.current({ text: isJump ? "Could not load target message" : "Could not load channel", type: 'warning' });
          }
          console.error("Error initializing message window", e);
        }
        if (!w.state.ready) {
          // nothing shown yet: fall back to the latest messages, or retry once live
          if (isJump && message === WINDOW_ERROR.NOT_FOUND) {
            queueMicrotask(() => initRecentRef.current());
          }
          else {
            retryInitRef.current = () => {
              if (viewRef.current?.window === w) runInitRef.current(options, intent);
            };
          }
        }
        return null;
      })
      .finally(() => {
        initializingRef.current--;
      });
  }, []);
  const runInitRef = useRef(runInit);
  runInitRef.current = runInit;

  const initRecent = useCallback(() => {
    void runInit({ type: 'recent' }, { type: 'bottom' });
  }, [runInit]);
  const initRecentRef = useRef(initRecent);
  initRecentRef.current = initRecent;

  const jumpToLatest = useCallback(() => {
    const current = viewRef.current;
    if (!current) return;
    if (!current.state.ready) {
      initRecent();
      return;
    }
    resetIntentRef.current = { type: 'bottom' };
    current.window.jumpToLatest().catch((e: unknown) => {
      if (e instanceof Error && e.message === WINDOW_ERROR.SUPERSEDED) return;
      console.error("Error jumping to the latest messages", e);
    });
  }, [initRecent]);

  const scrollToMessage = useCallback((messageId: string) => {
    const current = viewRef.current;
    if (!current) return;
    if (current.state.items.some(message => message.id === messageId)) {
      scrollableRef.current?.scrollToElementId(messageId);
      setTargetFocusId(messageId);
      return;
    }
    const w = current.window;
    // until the list reports its position again: not reading at the bottom
    atBottomRef.current = false;
    setAtBottom(false);
    void runInit({ type: 'atItemId', itemId: messageId }, { type: 'element', elementId: messageId })
      .then(count => {
        if (!!count && viewRef.current?.window === w) {
          setTargetFocusId(messageId);
        }
      });
  }, [runInit, setTargetFocusId]);

  // one window per mounted channel; its listener sets the scroll lock before rendering
  useEffect(() => {
    const w = chat.channels.openWindow(channelId);
    const initial: WindowView = { window: w, state: w.state };
    viewRef.current = initial;
    resetIntentRef.current = null;
    retryInitRef.current = null;
    setView(initial);

    const unsubscribe = w.subscribe((state, change) => {
      const prev = viewRef.current;
      if (!prev || prev.window !== w) return;
      const action = scrollActionForChange({
        change,
        prevItems: prev.state.items,
        nextItems: state.items,
        intent: resetIntentRef.current,
        atBottom: atBottomRef.current,
        wasAtLatest: prev.state.withEndOfList,
      });
      if (consumesIntent(change)) resetIntentRef.current = null;
      applyScrollAction(action);
      if (leavesBottom(change, action)) {
        // items may have arrived below the viewport: not read until the list
        // reports the bottom again (like jumps)
        atBottomRef.current = false;
        setAtBottom(false);
      }
      const next: WindowView = { window: w, state };
      viewRef.current = next;
      // logout: the store empties the window and the runtime re-inits it
      // (`chat` runtime `clear()`); that reset arrives here as cause `latest`
      setView(next);
    });

    return () => {
      unsubscribe();
      w.destroy();
      if (viewRef.current?.window === w) viewRef.current = null;
    };
  }, [channelId, applyScrollAction]);

  // the window rendered into this list (never the previous channel's one)
  const shownView = view && view.window.channelId === channelId && !view.window.state.isDestroyed ? view : null;
  const shownWindow = shownView?.window;

  // Initial load, once the (empty) list of this window is mounted, so the
  // Scrollable sees the first items as a mutation and applies the lock:
  // at the focus target if one is given, else the latest messages.
  const initStartedForRef = useRef<ChannelWindow | null>(null);
  useEffect(() => {
    const w = shownWindow;
    if (!w || initStartedForRef.current === w || viewRef.current?.window !== w) return;
    initStartedForRef.current = w;
    const focusId = messageIdFocusRef.current;
    lastScrollToMessageRef.current = focusId;
    if (focusId) {
      atBottomRef.current = false;
      setAtBottom(false);
      void runInitRef.current({ type: 'atItemId', itemId: focusId }, { type: 'element', elementId: focusId })
        .then(count => {
          if (!!count && viewRef.current?.window === w) setTargetFocusId(focusId);
        });
    }
    else {
      initRecentRef.current();
    }
  }, [shownWindow, setTargetFocusId]);

  // later focus targets (notification, pin, `?messageId=`) on the same channel
  useEffect(() => {
    const current = viewRef.current;
    if (!current || initStartedForRef.current !== current.window) return;
    if (!!targetFocusId && lastScrollToMessageRef.current !== targetFocusId) {
      lastScrollToMessageRef.current = targetFocusId;
      scrollToMessage(targetFocusId);
    }
  }, [targetFocusId, scrollToMessage]);

  // a failed init is retried once the socket is live again
  useEffect(() => {
    if (webSocketState === 'connected' && retryInitRef.current) {
      const retry = retryInitRef.current;
      retryInitRef.current = null;
      retry();
    }
  }, [webSocketState]);

  const onAtBottomChange = useCallback((value: boolean) => {
    if (atBottomRef.current === value) return;
    atBottomRef.current = value;
    setAtBottom(value);
  }, []);

  // level-triggered read marking (no marking for call chats)
  useChannelReadMarking(shownView?.window.channelId, shownView?.state ?? null, atBottom, !callMode);

  const typingBroadcaster = useTypingBroadcaster(channelId);

  const changeHandler = useCallback((data: Descendant[]) => {
    messageDataRef.current = data;
    // Don't broadcast typing while editing an existing message.
    if (!messageToEdit) {
      typingBroadcaster.notify(slateHasText(data));
    }
    if (!!messageDataUpdateRef.current) {
      clearTimeout(messageDataUpdateRef.current);
    }
    messageDataUpdateRef.current = setTimeout(() => {
      if (!!messageDataRef.current) {
        setMessageStateLocalStorage(messageDataRef.current);
      }
    }, 2000);
  }, [setMessageStateLocalStorage, typingBroadcaster, messageToEdit]);

  useEffect(() => {
    return () => {
      if (!!messageDataUpdateRef.current) {
        clearTimeout(messageDataUpdateRef.current);
      }
      if (!!messageDataRef.current) {
        setMessageStateLocalStorage(messageDataRef.current);
      }
    }
  }, [setMessageStateLocalStorage]);

  const editClickHandler = (message: Models.Message.Message) => {
    editClick(message);
  }

  const handleSend = useCallback(async (body: Models.Message.Body, attachments: Models.Message.Attachment[]): Promise<boolean> => {
    typingBroadcaster.stop();
    if (!!messageToEdit) {
      return await editMessage(messageToEdit, body, attachments);
    }
    else {
      // at the latest end the pending item arrives as `append-live` (own) and
      // the listener scrolls to it; a detached window shows the latest first
      const result = await createMessage(body, attachments);
      if (result && !viewRef.current?.state.withEndOfList) {
        jumpToLatest();
      }
      return result;
    }
  }, [createMessage, editMessage, messageToEdit, jumpToLatest, typingBroadcaster]);

  const scrollDownHandler = useCallback(() => {
    if (viewRef.current?.state.withEndOfList) {
      scrollableRef.current?.scrollToBottom();
    }
    else {
      jumpToLatest();
    }
  }, [jumpToLatest]);

  const scrollHelperRef = useRef<HTMLDivElement>(null);
  const scrollHelper = useMemo(() => {
    return (
      <div className="scroll-helper" ref={scrollHelperRef}>
        <ArrowDownCircleIcon className='h-12 w-12' onClick={scrollDownHandler} />
      </div>
    );
  }, [scrollDownHandler]);

  /* const MAX_SCROLL_ACCUMULATED = 150;
  const lastDistanceFromBottomRef = useRef<number | undefined>(undefined);
  const distanceAccRef = useRef<number>(-MAX_SCROLL_ACCUMULATED); */
  const onListScroll = useCallback((scrollDistanceFromBottom: number) => {
    // show / hide mobile menu depending on scroll direction
    /* if (isMobile) {
      if (lastDistanceFromBottomRef.current === undefined) {
        lastDistanceFromBottomRef.current = scrollDistanceFromBottom;
      }
      const diff = scrollDistanceFromBottom - lastDistanceFromBottomRef.current;
      lastDistanceFromBottomRef.current = scrollDistanceFromBottom;

      distanceAccRef.current += diff;
      if (distanceAccRef.current > MAX_SCROLL_ACCUMULATED) {
        distanceAccRef.current = MAX_SCROLL_ACCUMULATED;
      }
      else if (distanceAccRef.current < -MAX_SCROLL_ACCUMULATED || scrollDistanceFromBottom < BOTTOM_FIXED_MENU_TOGGLE) {
        distanceAccRef.current = -MAX_SCROLL_ACCUMULATED;
      }

      if (!!isMenuHiddenRef?.current && !isInputFocused && distanceAccRef.current < 0) {
        setMenuHidden(false);
      }
      else if (!isMenuHiddenRef?.current && (isInputFocused || distanceAccRef.current >= 0)) {
        setMenuHidden(true);
      }
    } */

    if (scrollDistanceFromBottom > 0) {
      setHideNotificationBanner(true);
    }
  }, [isInputFocused, isMobile, setMenuHidden]);

  let nextInputFocusTimeoutRef = useRef<any>(undefined);
  const setInputFocused = useCallback((value: boolean) => {
    // Blur stops typing on every platform (the mobile-only menu logic follows).
    if (!value) {
      typingBroadcaster.stop();
    }
    if (!isMobile) return;
    // Delay slightly to allow field to focus on click
    clearTimeout(nextInputFocusTimeoutRef.current);
    nextInputFocusTimeoutRef.current = setTimeout(() => {
      onMobileFocus?.(value);
      _setInputFocused(value);
      setMenuHidden(value);
      // fix scroll event handler / enforce state for show / hide mobile bottom menu
      /* if (!value) {
        distanceAccRef.current = -Infinity;
      } */
    }, 2);
  }, [isMobile, setMenuHidden, onMobileFocus, typingBroadcaster]);

  useEffect(() => {
    if (!!messageToEdit) {
      editFieldRef.current?.setCurrentValue(convertToFieldFormat(messageToEdit.body.content));
      editFieldRef.current?.setCurrentAttachments(messageToEdit.attachments);
    }
  }, [messageToEdit]);

  const RendererExtended = useMemo(() => {
    return (messageProps: RendererProps) => {
      return (
        <Renderer {...messageProps}
          channelId={channelId}
          scrollToMessage={scrollToMessage}
        />
      );
    };
  }, [Renderer, scrollToMessage, channelId]);

  const placeholderText = props.replyingTo ? 'Add a reply' : props.channelName ? `Message #${props.channelName}` : 'Type something';

  const joinCommunityButton = useMemo(() => {
    if (!isMobile && writingForbiddenMessage === JOINCOMMUNITY_MUTED_MESSAGE) {
      return <JoinCommunityButton
        community={communityContext.state === 'loaded' ? communityContext.community : undefined}
        className='w-full max-w-xs mx-auto'
      />
    }
    return null;
  }, [isMobile, writingForbiddenMessage, communityContext.state === 'loaded' ? communityContext.community : undefined]);

  const editContainer = useMemo(() => {
    if (!!joinCommunityButton) {
      return joinCommunityButton;
    }

    return <div className="edit-container">
      {!!writingForbiddenMessage ? (<div className="you-are-muted">
        <div>
          <svg width="17" height="17" viewBox="0 0 17 17" fill="none" xmlns="http://www.w3.org/2000/svg">
            <path d="M16.6738 8.92188C16.6738 11.0436 15.831 13.0784 14.3307 14.5787C12.8304 16.079 10.7956 16.9219 8.67383 16.9219C6.5521 16.9219 4.51726 16.079 3.01697 14.5787C1.51668 13.0784 0.673828 11.0436 0.673828 8.92188C0.673828 6.80014 1.51668 4.76531 3.01697 3.26502C4.51726 1.76473 6.5521 0.921875 8.67383 0.921875C10.7956 0.921875 12.8304 1.76473 14.3307 3.26502C15.831 4.76531 16.6738 6.80014 16.6738 8.92188ZM14.6738 8.92188C14.6738 7.62587 14.2638 6.42587 13.5638 5.44487L5.19683 13.8129C6.09447 14.4512 7.15048 14.83 8.24915 14.908C9.34782 14.986 10.4468 14.76 11.4255 14.2548C12.4043 13.7497 13.2251 12.9849 13.7981 12.0442C14.3711 11.1035 14.674 10.0233 14.6738 8.92188ZM12.1498 4.03187C10.9941 3.20988 9.5846 2.82384 8.17134 2.94224C6.75808 3.06064 5.43244 3.67583 4.42961 4.67866C3.42678 5.68149 2.8116 7.00712 2.6932 8.42039C2.5748 9.83365 2.96084 11.2432 3.78283 12.3989L12.1508 4.03087L12.1498 4.03187Z" fill="#E46C6C" />
          </svg>
          <div className="ml-2">
            {writingForbiddenMessage}
          </div>
        </div>
      </div>
      ) : (
        // key forces editField to re-render whenever channel changes
        <EditFieldThree
          ref={editFieldRef}
          key={`editfield-${channelId}`}
          replyingTo={replyingTo}
          cancelReply={cancelReply}
          onChange={changeHandler}
          placeholder={placeholderText}
          initialValue={messageStateLocalStorage}
          initialAttachments={messageToEdit?.attachments}
          send={handleSend}
          mentionableUsersSource={mentionableUsersSource}
          disableAttachments={disableAttachments}
          isEditing={!!messageToEdit}
          callMode={callMode}
          //overridePlaceholderClassName='generic-message-list-placeholder'   placeholder render provides placeholder to edit on focus to input field

          isFocused={isInputFocused}
          setFocused={setInputFocused}
        />
      )}
      {scrollHelper}
    </div>
  }, [joinCommunityButton, cancelReply, changeHandler, channelId, disableAttachments, handleSend, isInputFocused, mentionableUsersSource, messageStateLocalStorage, messageToEdit, placeholderText, replyingTo, scrollHelper, setInputFocused, writingForbiddenMessage, callMode]);

  return (
    <div className="generic-message-list">
      {isMobile && fromNotifications && <div className={`fromNotificationsBanner${hideNotificationBanner ? ' hidden' : ''}`}>
        <Button role='primary' text='Back to Notifications' iconLeft={<ArrowLeftIcon className='w-5 h-5' />} onClick={() => navigate(getUrl({ type: 'notifications' }))} />
      </div>}
      {!shownView && <div style={{height: "100%"}} />}
      {!!shownView && <ScrollingMessageList
        key={`scrollingmessagelist-${channelId}`}
        channelWindow={shownView.window}
        state={shownView.state}
        Renderer={RendererExtended}
        replyClick={(id, sender, body) => {
          replyClick(id, sender, body);
          editFieldRef.current?.focus();
        }}
        editClick={editClickHandler}
        messageToEdit={messageToEdit}
        targetFocusId={targetFocusId}
        identifierKey={`scrollingmessagelist-${channelId}`}
        onScroll={onListScroll}
        onAtBottomChange={onAtBottomChange}
        scrollableRef={scrollableRef}
        scrollableInnerRef={scrollableInnerRef}
        loadingNextRef={loadingNextRef}
        loadingPreviousRef={loadingPreviousRef}
        initializingRef={initializingRef}
        canReply={!writingForbiddenMessage}
        scrollHelper={scrollHelper}
        scrollHelperRef={scrollHelperRef}
      />}
      {!hideInput && <div className='edit-container-container'>
        <TypingIndicator channelId={channelId} />
        {editContainer}
      </div>}
    </div>
  );
}
