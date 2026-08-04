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
import { useNavigate, useSearchParams } from 'react-router-dom';
import { ArrowLeftIcon } from '@heroicons/react/20/solid';
import { ArrowDownCircleIcon } from '@heroicons/react/24/solid';
import useLocalStorage from 'hooks/useLocalStorage';
import data from 'data';
import { getUrl } from 'common/util';
import { useConnectionContext } from 'context/ConnectionProvider';
import { useSafeCommunityContext } from 'context/CommunityProvider';
import JoinCommunityButton from 'components/atoms/JoinCommunityButton/JoinCommunityButton';
import channelDatabaseManager from 'data/databases/channel';
import config from 'common/config';
import loginManager from 'data/appstate/login';
import { useSnackbarContext } from 'context/SnackbarContext';
import { ScrollableHandle } from '../../molecules/Scrollable/Scrollable';

type Props = {
  channelName?: string;
  channelId: string;
  Renderer: React.FC<RendererProps & {
    visibilityObserver: IntersectionObserver;
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

export const JOINCOMMUNITY_MUTED_MESSAGE = 'Join the community to chat here';
const BOTTOM_FIXED_MENU_TOGGLE = 50;

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
  const { webSocketState, onlineState } = useConnectionContext();
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
  const initializingItemListRef = useRef<Promise<void> | null>(null);
  const messageObserverRootRef = useRef<HTMLDivElement>(null);
  const [itemList, setItemList] = useState<Models.ItemList.ItemList<Models.Message.Message> | null>(null);

  const [targetFocusId, _setTargetFocusId] = useState<string | undefined>(props.messageIdFocus);
  const lastFocusedIdRef = useRef<string | undefined>(undefined);
  const lastScrollToMessageRef = useRef<string | undefined>(undefined);

  const setTargetFocusId = useCallback((id: string | undefined) => {
    lastFocusedIdRef.current = undefined;
    if (id !== targetFocusId) {
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
  }, [targetFocusId]);

  useEffect(() => {
    if (props.messageIdFocus !== targetFocusId) {
      lastFocusedIdRef.current = undefined;
      _setTargetFocusId(props.messageIdFocus);
    }
  // do not include targetFocusId here, this should only trigger
  // if the one from props changes
  }, [props.messageIdFocus]);

  useEffect(() => {
    let mounted = true;
    // create database
    const { database, onUnmount: onDatabaseUnmount } =  data.channelManager.getMountedChannelDatabase(channelId);
    // create itemList
    let timeout: any = null;
    const itemRangeUpdateJobs: Models.ItemList.ItemRangeUpdateJob[] = [];
    if (!!itemList) {
      // destroy old itemList
      itemList.destroy(false);
    }
    const newItemList = database.createItemList(updateJob => {
      if (!mounted) return;
      if (!itemRangeUpdateJobs.some(job => job.rangeStart.getTime() === updateJob.rangeStart.getTime() && job.rangeEnd.getTime() === updateJob.rangeEnd.getTime())) {
        itemRangeUpdateJobs.push(updateJob);
      }
      if (timeout === null) {
        timeout = setTimeout(() => {
          const updateJobs = itemRangeUpdateJobs.splice(0);
          channelDatabaseManager.loadUpdates({ channelId, itemRangeUpdateJobs: updateJobs });
          timeout = null;
        }, 0);
      }
    });
    setItemList(newItemList);
    setMessages(newItemList.items);
    return() => {
      mounted = false;
      onDatabaseUnmount();
    };
  }, [channelId]); // do not include itemList! it is set here and must not re-execute the effect

  const [messages, setMessages] = useState<Models.Message.Message[]>([]);
  const messagesRef = useRef(messages);
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  const mentionableUsersSource = useMemo(() => {
    if (communityContext.state === 'loaded') {
      return {
        type: 'community-channel' as 'community-channel',
        communityId: communityContext.community.id,
        channelId,
      };
    }
  }, [communityContext.state, channelId, 'community' in communityContext ? communityContext.community.id : undefined]);

  const scrollToMessage = useCallback((messageId: string) => {
    if (!itemList) {
      throw new Error("itemList is not set");
    }
    if (messagesRef.current.some(message => message.id === messageId)) {
      scrollableRef.current?.scrollToElementId(messageId);
      setTargetFocusId(messageId);
    }
    else if (!initializingItemListRef.current) {
      initializingItemListRef.current = new Promise<void>(async (resolve, reject) => {
        let rejected: any;
        if (!!loadingNextRef.current || !!loadingPreviousRef.current) {
          await Promise.allSettled([loadingNextRef.current, loadingPreviousRef.current]);
        }
        itemList
          .init({ type: 'atItemId', itemId: messageId })
          .catch(e => {
            return channelDatabaseManager.loadItemWithNeighbours({ channelId, itemId: messageId })
            .then(() => {
              return itemList.init({ type: 'atItemId', itemId: messageId });
            });
          })
          .then((itemCount) => {
            if (itemCount > 0) {
              scrollableRef.current?.lockScrollForNextUpdate({ type: 'scrollToElementId', elementId: messageId });
              setTargetFocusId(messageId);
            }
          })
          .catch(e => {
            showSnackbar({ text: "Could not load target message", type: 'warning' });
            console.error("Error loading itemList at itemId", e);
            rejected = e;
          })
          .finally(() => {
            setTimeout(() => {
              if (!!rejected) {
                reject(rejected);
              }
              else {
                resolve();
              }
              initializingItemListRef.current = null;
            }, 0);
          });
      });
    }
  }, [itemList, channelId]);

  useEffect(() => {
    if (!!itemList && !!targetFocusId && lastScrollToMessageRef.current !== targetFocusId) {
      lastScrollToMessageRef.current = targetFocusId;
      scrollToMessage(targetFocusId);
    }
  }, [itemList, targetFocusId, messages, scrollToMessage]);

  const mountedRef = useRef(true);
  useEffect(() => {
    return () => {
      mountedRef.current = false;
    }
  }, []);

  const initializeItemListRecent = useCallback(() => {
    if (!itemList) {
      throw new Error("itemList is not set");
    }
    if (!initializingItemListRef.current) {
      initializingItemListRef.current = new Promise<void>(async (resolve, reject) => {
        let rejected: any;
        if (!!loadingNextRef.current || !!loadingPreviousRef.current) {
          await Promise.allSettled([loadingNextRef.current, loadingPreviousRef.current]);
        }
        if (!mountedRef.current) return;
        itemList
          .init({ type: 'recent' })
          .then((itemCount) => {
            if (itemCount > 0) {
              scrollableRef.current?.lockScrollForNextUpdate({ type: 'scrollToBottom' });
            }
            const { withEndOfList, withStartOfList, rangeStart } = itemList.state;
            if (!withEndOfList || (itemCount < config.ITEMLIST_BATCH_SIZE && !withStartOfList)) {
              // Todo: Fix this, should wait for connection, but first fix reconnect speed
              if (webSocketState === "connected" || onlineState === "online") {
                if (!mountedRef.current) return;
                return channelDatabaseManager.loadItems({
                  channelId,
                  createdBefore: withEndOfList ? rangeStart || undefined : undefined,
                  order: "DESC",
                })
                .then(() => {
                  if (!mountedRef.current) return;
                  return itemList.init({ type: 'recent' })
                  .then((itemCount) => {
                    if (itemCount > 0) {
                      scrollableRef.current?.lockScrollForNextUpdate({ type: 'scrollToBottom' });
                    }
                  });
                });
              }
              else {
                rejected = new Error("Disconnected");
              }
            }
          })
          .catch(e => {
            showSnackbar({ text: "Could not load channel", type: 'warning' });
            console.error("Error loading itemList recent", e);
            rejected = e;
          })
          .finally(() => {
            setTimeout(() => {
              if (!!rejected) {
                reject(rejected);
              }
              else {
                resolve();
              }
              initializingItemListRef.current = null;
            }, 0);
          });
      });
    }
  }, [itemList, webSocketState === "connected", channelId]);

  useEffect(() => {
    let mounted = true;
    if (itemList) {
      itemList.ready.then(() => {
        if (!mounted) return;
        if (targetFocusId) {
          scrollToMessage(targetFocusId);
        }
        else {
          initializeItemListRecent();
        }
      });
    }
    return () => {
      mounted = false;
    }
  }, [itemList]);

  const changeHandler = useCallback((data: Descendant[]) => {
    messageDataRef.current = data;
    if (!!messageDataUpdateRef.current) {
      clearTimeout(messageDataUpdateRef.current);
    }
    messageDataUpdateRef.current = setTimeout(() => {
      if (!!messageDataRef.current) {
        setMessageStateLocalStorage(messageDataRef.current);
      }
    }, 2000);
  }, [setMessageStateLocalStorage]);

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
    if (!itemList) {
      throw new Error("itemList is not set");
    }
    if (!!messageToEdit) {
      return await editMessage(messageToEdit, body, attachments);
    }
    else {
      return createMessage(body, attachments)
      .then((result) => {
        if (itemList.state.withEndOfList) {
          scrollableRef.current?.lockScrollForNextUpdate({ type: 'scrollToBottom' });
        }
        else {
          initializeItemListRecent();
        }
        return result;
      });
    }
  }, [createMessage, editMessage, messageToEdit, itemList, initializeItemListRecent]);

  const scrollDownHandler = useCallback(() => {
    if (!itemList) {
      throw new Error("itemList is not set");
    }
    if (itemList.state.withEndOfList) {
      scrollableRef.current?.scrollToBottom();
    }
    else {
      initializeItemListRecent();
    }
  }, [itemList, initializeItemListRecent]);

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
  }, [isMobile, setMenuHidden, onMobileFocus]);

  useEffect(() => {
    if (!!messageToEdit) {
      editFieldRef.current?.setCurrentValue(convertToFieldFormat(messageToEdit.body.content));
      editFieldRef.current?.setCurrentAttachments(messageToEdit.attachments);
    }
  }, [messageToEdit]);

  const [messageObserver, setMessageObserver] = useState<IntersectionObserver | null>(null);
  useEffect(() => {
    const observer = new IntersectionObserver(
      (results) => {
        let latest: string | null = null;
        for (const element of results) {
          const currLatest: string | undefined = (element.target as any).dataset?.timestamp;
          if (!!currLatest && element.isIntersecting && (!latest || currLatest > latest)) {
            latest = currLatest;
          }
        }
        if (latest && loginManager.state === "loggedin") {
          data.channelManager.setChannelLastRead(channelId, new Date(latest));
        }
      },
      {
        root: messageObserverRootRef.current,
      }
    );
    setMessageObserver(observer);
    return () => {
      observer.disconnect();
    }
  }, [channelId]);

  const RendererExtended = useMemo(() => {
    if (messageObserver) {
      return (messageProps: RendererProps) => {
        return (
          <Renderer {...messageProps}
            visibilityObserver={messageObserver}
            channelId={channelId}
            scrollToMessage={scrollToMessage}
          />
        );
      };
    }
    else {
      return null;
    }
  }, [Renderer, scrollToMessage, messageObserver, channelId]);

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
    <div className="generic-message-list" ref={messageObserverRootRef}>
      {isMobile && fromNotifications && <div className={`fromNotificationsBanner${hideNotificationBanner ? ' hidden' : ''}`}>
        <Button role='primary' text='Back to Notifications' iconLeft={<ArrowLeftIcon className='w-5 h-5' />} onClick={() => navigate(getUrl({ type: 'notifications' }))} />
      </div>}
      {(!RendererExtended || !itemList) && <div style={{height: "100%"}} />}
      {(!!RendererExtended && !!itemList) && <ScrollingMessageList
        itemList={itemList}
        Renderer={RendererExtended}
        replyClick={(id, sender, body) => {
          replyClick(id, sender, body);
          editFieldRef.current?.focus();
        }}
        editClick={editClickHandler}
        messageToEdit={messageToEdit}
        targetFocusId={targetFocusId}
        lastFocusedIdRef={lastFocusedIdRef}
        identifierKey={`scrollingmessagelist-${channelId}`}
        onScroll={onListScroll}
        channelId={channelId}
        scrollableRef={scrollableRef}
        scrollableInnerRef={scrollableInnerRef}
        loadingNextRef={loadingNextRef}
        loadingPreviousRef={loadingPreviousRef}
        initializingItemListRef={initializingItemListRef}
        messages={messages}
        setMessages={setMessages}
        canReply={!writingForbiddenMessage}
        scrollHelper={scrollHelper}
        scrollHelperRef={scrollHelperRef}
      />}
      {!hideInput && <div className='edit-container-container'>
        {editContainer}
      </div>}
    </div>
  );
}
