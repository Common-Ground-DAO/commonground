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
import { useConnectionContext } from 'context/ConnectionProvider';
import config from 'common/config';
import { chat } from 'data/chat/runtime';
import { WINDOW_ERROR, type ChannelWindow } from 'data/chat/types';
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
  const { webSocketState } = useConnectionContext();
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
  const [channelWindow, setChannelWindow] = useState<ChannelWindow | null>(null);
  const [listState, setListState] = useState<Models.ItemList.ItemListState<Models.Message.Message> | null>(null);
  /** an init that failed (offline, server error): retried once live again */
  const retryInitRef = useRef<(() => void) | null>(null);
  const webSocketConnectedRef = useRef(webSocketState === 'connected');
  webSocketConnectedRef.current = webSocketState === 'connected';
  const showSnackbarRef = useRef(showSnackbar);
  showSnackbarRef.current = showSnackbar;
  const [replyTo, setReplyTo] = useState<{
    id: string,
    senderId: string,
    body: Models.Message.Body
  } | null>(null);

  // ascending (server items, then own pending sends); rendered newest first
  const messages = useMemo(() => listState?.items ?? [], [listState]);
  const showLoadMoreSentinel = !listState || listState.hasPreviousItemsLocally || listState.hasPreviousItemsOnRemote;
  const allCurrentItemsByIdRef = useRef(new Map<string, Models.Message.Message>());
  useMemo(() => {
    allCurrentItemsByIdRef.current = new Map(messages.map(m => [m.id, m]));
  }, [messages]);
  const endOfListRef = useRef<HTMLDivElement>(null);

  const initRecent = useCallback((w: ChannelWindow) => {
    retryInitRef.current = null;
    w.init({ type: 'recent' }).catch((e: unknown) => {
      if (e instanceof Error && e.message === WINDOW_ERROR.SUPERSEDED) return;
      if (webSocketConnectedRef.current) {
        showSnackbarRef.current({ text: "Could not load comments", type: 'warning' });
      }
      console.error("Error loading comments", e);
      if (!w.state.ready) retryInitRef.current = () => initRecent(w);
    });
  }, []);

  useEffect(() => {
    const w = chat.channels.openWindow(channelId);
    setChannelWindow(w);
    setListState(w.state);
    const unsubscribe = w.subscribe(state => {
      setListState(state);
    });
    // no scroll anchoring here: the list is part of the page and grows downwards
    initRecent(w);
    return () => {
      unsubscribe();
      w.destroy();
      retryInitRef.current = null;
    };
  }, [channelId, initRecent]);

  // a failed init is retried once the socket is live again
  useEffect(() => {
    if (webSocketState === 'connected' && retryInitRef.current) {
      const retry = retryInitRef.current;
      retryInitRef.current = null;
      retry();
    }
  }, [webSocketState]);

  // localStorage read marker of the article: newest server comment shown
  const newestCommentAt = listState?.rangeEnd?.toISOString();
  useEffect(() => {
    if (newestCommentAt) {
      setContentCommentReadState(oldState => {
        if (oldState[articleId] === newestCommentAt) return oldState;
        const newState = { ...oldState };
        newState[articleId] = newestCommentAt;
        return newState;
      });
    }
  }, [articleId, newestCommentAt, setContentCommentReadState]);

  //   const mentionableUsersSource = useMemo(() => {
  //     if (communityContext.state === 'loaded') {
  //       return {
  //         type: 'community-channel' as 'community-channel',
  //         communityId: communityContext.community.id,
  //         channelId,
  //       };
  //     }
  //   }, [communityContext.state, channelId, 'community' in communityContext ? communityContext.community.id : undefined]);

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
    if (!channelWindow) {
      return false;
    }
    // the pending comment is shown at once at the latest end
    const result = await createMessage(body, attachments, replyTo?.id || null);
    setReplyTo(null);
    setMessageStateLocalStorage(undefined);
    if (result && !channelWindow.state.withEndOfList) {
      channelWindow.jumpToLatest().catch((e: unknown) => {
        if (e instanceof Error && e.message === WINDOW_ERROR.SUPERSEDED) return;
        console.error("Error showing the latest comments", e);
      });
    }
    return result;
  }, [channelWindow, createMessage, replyTo?.id, setMessageStateLocalStorage]);

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
    if (channelWindow && channelWindow.state.ready && !loadingPreviousRef.current) {
      const { state } = channelWindow;
      if (state.hasPreviousItemsLocally || state.hasPreviousItemsOnRemote) {
        loadingPreviousRef.current = channelWindow.loadOlder(config.ITEMLIST_BATCH_SIZE)
          .catch(e => {
            console.error("Error loading older comments", e);
          })
          .finally(async () => {
            await new Promise<void>(resolve => {
              setTimeout(() => {
                loadingPreviousRef.current = null;
                resolve();
              }, 0)
            });
          });
      }
    }
  // ready / item count: re-arm the sentinel observer after each load, so a
  // sentinel that is still in view loads the next page
  }, [channelWindow, listState?.ready, messages.length]);

  useSentinelLoadMore(endOfListRef, true, fetchMore);

  const retrySend = useCallback((messageId: string) => {
    chat.channels.retrySend(channelId, messageId);
  }, [channelId]);
  const discardPending = useCallback((messageId: string) => {
    chat.channels.discardPending(channelId, messageId);
  }, [channelId]);

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
      {!!channelWindow && <div className='flex flex-col-reverse gap-2'>
        {/* TODO: On edit, do something (onEditClickHandler, editMessage) */}
        {messages.map(message => <CommentMessage
          key={message.id}
          message={message}
          channelId={channelId}
          onDeleteMessage={deleteMessage}
          onRetrySend={retrySend}
          onDiscardPending={discardPending}
          replyClick={(id, senderId, body) => setReplyTo({ id, senderId, body })}
          allCurrentItemsByIdRef={allCurrentItemsByIdRef}
        />)}
      </div>}
      {/* {<div ref={endOfListRef} />} */}
      {/* isEmpty counts server items only: a pending comment is shown in an empty list */}
      {!!listState?.isEmpty && messages.length === 0 && <EmptyState
        title='No comments yet'
        description='Be the first to comment on this article!'
      />}
      {showLoadMoreSentinel && <div ref={endOfListRef} id='end-of-comment-list' />}
    </div>
  );
}
