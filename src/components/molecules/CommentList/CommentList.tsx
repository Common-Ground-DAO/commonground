// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Descendant } from 'slate';
import EditFieldThree from '../../organisms/EditField/EditField';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import './CommentList.css';
import { useWindowSizeContext } from '../../../context/WindowSizeProvider';
import { useMobileLayoutContext } from '../../../views/Layout/MobileLayout';
import useLocalStorage, { ReadLatestArticleCommentsState } from 'hooks/useLocalStorage';
import data from 'data';
import { useConnectionContext } from 'context/ConnectionProvider';
import channelDatabaseManager from 'data/databases/channel';
import config from 'common/config';
import { useSnackbarContext } from 'context/SnackbarContext';
import { useSentinelLoadMore } from 'hooks/useSentinelLoadMore';
import CommentMessage from '../CommentMessage/CommentMessage';
import EmptyState from '../EmptyState/EmptyState';
import { useOwnUser } from 'context/OwnDataProvider';
import { useUserOnboardingContext } from 'context/UserOnboarding';
import JoinCommunityButton from 'components/atoms/JoinCommunityButton/JoinCommunityButton';

type Props = {
  articleId: string;
  channelId: string;
  // createItem returns true or false, stating whether to clear the input field
  cannotCommentReason: {
    type: 'notJoined';
    community: Models.Community.DetailView | undefined;
  } | {
    type:   'muted' | 'banned';
  } | null;
  createMessage: (body: Models.Message.Body, attachments: Models.Message.Attachment[], parentMessageId: string | null) => Promise<boolean>;
  deleteMessage: (messageId: string) => void;
  hideInput?: boolean;
  onMobileFocus?: (focused: boolean) => void;
};

export default function CommentList(props: Props) {
  const {
    articleId,
    channelId,
    createMessage,
    deleteMessage,
    hideInput,
    onMobileFocus,
    cannotCommentReason,
  } = props;
  const { isMobile } = useWindowSizeContext();
  const { setMenuHidden } = useMobileLayoutContext();
  const { webSocketState, onlineState } = useConnectionContext();
  const { showSnackbar } = useSnackbarContext();
  const { setUserOnboardingVisibility } = useUserOnboardingContext();
  const ownUser = useOwnUser();

  const [isInputFocused, _setInputFocused] = useState(false);
  const editFieldRef = useRef<React.ElementRef<typeof EditFieldThree>>(null);
  const [messageStateLocalStorage, setMessageStateLocalStorage] = useLocalStorage<undefined | Descendant[]>(undefined, `_message_state_of_channel_${channelId}`);
  const [, setContentCommentReadState] = useLocalStorage<ReadLatestArticleCommentsState>({}, 'content-comment-read-state');
  const messageDataRef = useRef<undefined | Descendant[]>(undefined);
  const messageDataUpdateRef = useRef<any>(null);
  const loadingPreviousRef = useRef<Promise<void> | null>(null);
  const initializingItemListRef = useRef<Promise<void> | null>(null);
  const [itemList, setItemList] = useState<Models.ItemList.ItemList<Models.Message.Message> | null>(null);
  const [messages, setMessages] = useState<Models.Message.Message[]>([]);
  const [showLoadMoreSentinel, setShowLoadMoreSentinel] = useState(true);
  const [replyTo, setReplyTo] = useState<{
    id: string,
    senderId: string,
    body: Models.Message.Body
  } | null>(null);

  const allCurrentItemsByIdRef = useRef(new Map(messages.map(m => [m.id, m])));
  const endOfListRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let mounted = true;
    // create database
    const { database, onUnmount: onDatabaseUnmount } = data.channelManager.getMountedChannelDatabase(channelId);
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
    return () => {
      mounted = false;
      onDatabaseUnmount();
    };
  }, [channelId]); // do not include itemList! it is set here and must not re-execute the effect

  useEffect(() => {
    const lastMessage = messages[messages.length - 1];
    if (lastMessage) {
      setContentCommentReadState(oldState => {
        const newState = { ...oldState };
        newState[articleId] = lastMessage.createdAt.toISOString();
        return newState;
      });
    }
  }, [articleId, messages, setContentCommentReadState]);

  //   const mentionableUsersSource = useMemo(() => {
  //     if (communityContext.state === 'loaded') {
  //       return {
  //         type: 'community-channel' as 'community-channel',
  //         communityId: communityContext.community.id,
  //         channelId,
  //       };
  //     }
  //   }, [communityContext.state, channelId, 'community' in communityContext ? communityContext.community.id : undefined]);

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
        if (!!loadingPreviousRef.current) {
          await Promise.allSettled([loadingPreviousRef.current]);
        }
        if (!mountedRef.current) return;
        itemList
          .init({ type: 'recent' })
          .then((itemCount) => {
            const { withEndOfList, withStartOfList, rangeStart, rangeEnd } = itemList.state;
            if (!withEndOfList || (itemCount < config.ITEMLIST_BATCH_SIZE && !withStartOfList)) {
              // Todo: Fix this, should wait for connection, but first fix reconnect speed
              if (webSocketState === "connected" || onlineState === "online") {
                if (!mountedRef.current) return;
                console.log('initializingState', itemList.state);

                return channelDatabaseManager.loadItems({
                  channelId,
                  createdAfter: withEndOfList ? rangeEnd || undefined : undefined,
                  order: "DESC",
                })
                  .then(() => {
                    if (!mountedRef.current) return;
                    return itemList.init({ type: 'recent' })
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
        initializeItemListRecent();
      });
    }
    return () => {
      mounted = false;
    }
  }, [itemList]);

  useEffect(() => {
    const listener = (data: Models.ItemList.ItemListState<Models.Message.Message>) => {
      setMessages(data.items);
      setShowLoadMoreSentinel(data.hasPreviousItemsLocally || data.hasPreviousItemsOnRemote);
      const allNewMessagesById = new Map(data.items.map(m => [m.id, m]));
      allCurrentItemsByIdRef.current = allNewMessagesById;
    }

    itemList?.addUpdateListener(listener);
    return () => {
      itemList?.removeUpdateListener(listener);
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

  const handleSend = useCallback(async (body: Models.Message.Body, attachments: Models.Message.Attachment[]): Promise<boolean> => {
    if (!itemList) {
      throw new Error("itemList is not set");
    }
    else {
      return createMessage(body, attachments, replyTo?.id || null)
        .then((result) => {
          setReplyTo(null);
          setMessageStateLocalStorage(undefined);
          initializeItemListRecent();
          return result;
        });
    }
  }, [itemList, createMessage, replyTo?.id, setMessageStateLocalStorage, initializeItemListRecent]);

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

  const editContainer = useMemo(() => {
    if (!ownUser) {
      return <div className='flex flex-col w-full items-center justify-center'>
        <div
          role='button'
          className='p-4 cg-border-l cg-content-stack'
          onClick={() => setUserOnboardingVisibility(true)}
        >
          <p>Wanna leave a comment? <span className='underline'>Try logging in!</span></p>
        </div>
      </div>;
    }

    if (cannotCommentReason?.type === 'notJoined') {
      return <div className='flex flex-col w-full items-center justify-center gap-4 cg-content-stack p-4 cg-border-xl'>
        <p>Join this community to leave a comment.</p>
        <JoinCommunityButton
          community={cannotCommentReason.community}
          className='w-full max-w-xs mx-auto'
        />
      </div>;
    }

    if (cannotCommentReason?.type === 'banned' || cannotCommentReason?.type === 'muted') {
      return <div className='flex flex-col w-full items-center justify-center cg-text-warning cg-content-stack p-4 cg-border-xl'>
        <p>You cannot leave a comment because you are {cannotCommentReason.type}.</p>
      </div>;
    }

    return <div className="edit-container">
      {/* // key forces editField to re-render whenever channel changes */}
      <EditFieldThree
        ref={editFieldRef}
        key={`editfield-${channelId}`}
        onChange={changeHandler}
        placeholder={'Write a comment...'}
        initialValue={messageStateLocalStorage}
        send={handleSend}
        replyingTo={replyTo}
        cancelReply={() => setReplyTo(null)}
        attachmentLimit={5}
        //overridePlaceholderClassName='generic-message-list-placeholder'   placeholder render provides placeholder to edit on focus to input field

        isFocused={isInputFocused}
        setFocused={setInputFocused}
      />
    </div>
  }, [changeHandler, channelId, handleSend, isInputFocused, messageStateLocalStorage, ownUser, replyTo, setInputFocused, setUserOnboardingVisibility, cannotCommentReason]);

  const fetchMore = useCallback(() => {
    if (itemList && !loadingPreviousRef.current && !initializingItemListRef.current) {
      let promise: Promise<void> | undefined;
      const { state } = itemList;
      if (state.hasPreviousItemsLocally) {
        promise = itemList.update({ growStart: config.ITEMLIST_BATCH_SIZE })
      }
      else if (state.hasPreviousItemsOnRemote && state.rangeStart) {
        promise = channelDatabaseManager.loadItems({
          channelId,
          createdBefore: state.rangeStart,
          order: "DESC",
        })
          .then(() => {
            if (itemList.state.hasPreviousItemsLocally) {
              return itemList.update({ growStart: config.ITEMLIST_BATCH_SIZE });
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
  }, [channelId, itemList]);

  useSentinelLoadMore(endOfListRef, true, fetchMore);

  return (
    <div className={`flex flex-col gap-2 comment-list`}>
      {/* {(!!itemList) && <ScrollingMessageList
        itemList={itemList}
        Renderer={RendererExtended}
        replyClick={(id, sender, body) => {
          replyClick(id, sender, body);
          editFieldRef.current?.focus();
        }}
        editClick={editClickHandler}
        messageToEdit={messageToEdit}
        lastFocusedIdRef={lastFocusedIdRef}
        identifierKey={`scrollingmessagelist-${channelId}`}
        onScroll={onListScroll}
        channelId={channelId}
        loadingNextRef={loadingNextRef}
        loadingPreviousRef={loadingPreviousRef}
        initializingItemListRef={initializingItemListRef}
        messages={messages}
        setMessages={setMessages}
        canReply={!writingForbiddenMessage}
        scrollHelper={scrollHelper}
        scrollHelperRef={scrollHelperRef}
      />} */}
      {!hideInput && <div className='edit-container-container'>
        {editContainer}
      </div>}
      {!!itemList && <div className='flex flex-col-reverse gap-2'>
        {/* TODO: On edit, do something (onEditClickHandler, editMessage) */}
        {messages.map(message => <CommentMessage
          key={message.id}
          message={message}
          channelId={channelId}
          onDeleteMessage={deleteMessage}
          replyClick={(id, senderId, body) => setReplyTo({ id, senderId, body })}
          allCurrentItemsByIdRef={allCurrentItemsByIdRef}
        />)}
      </div>}
      {/* {<div ref={endOfListRef} />} */}
      {!showLoadMoreSentinel && messages.length === 0 && <EmptyState
        title='No comments yet'
        description='Be the first to comment on this article!'
      />}
      {showLoadMoreSentinel && <div ref={endOfListRef} id='end-of-comment-list' />}
    </div>
  );
}
