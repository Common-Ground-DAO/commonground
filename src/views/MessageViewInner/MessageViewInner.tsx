// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { chat } from 'data/chat/runtime';
import GenericMessageList from '../../components/molecules/GenericMessageList/GenericMessageList';
import Message from '../../components/molecules/Message/Message';
import { type RendererProps } from '../../components/molecules/GenericMessageList/ScrollingMessageList/ScrollingMessageList';
import { useOwnUser } from 'context/OwnDataProvider';
import serviceWorkerManager from 'data/appstate/serviceWorker';
import communityDatabase from 'data/databases/community';

/**
 * Reply parent of a list item: from the loaded items when there, otherwise
 * watched in the store (works without the parent being in the window).
 */
function useReplyParent(
  channelId: string,
  parentMessageId: string | null,
  allCurrentItemsByIdRef: React.MutableRefObject<Map<string, Models.Message.Message>>,
): Models.Message.Message | undefined {
  const [parentMessage, setParentMessage] = useState<Models.Message.Message | undefined>(
    !!parentMessageId ? allCurrentItemsByIdRef.current?.get(parentMessageId) : undefined,
  );

  useEffect(() => {
    if (!parentMessageId || !channelId) {
      setParentMessage(undefined);
      return;
    }
    const loaded = allCurrentItemsByIdRef.current?.get(parentMessageId);
    if (loaded) setParentMessage(loaded);
    // the watcher keeps it current (edits, deletion) also when it leaves the window
    return chat.channels.watchMessage(channelId, parentMessageId, setParentMessage);
  }, [parentMessageId, channelId, allCurrentItemsByIdRef]);

  return parentMessage;
}

function MessageRenderer(props: RendererProps & {
  channelId: string;
}) {
  const { item, channelId, replyClick, allCurrentItemsByIdRef, scrollToMessage, canReply } = props;
  const parentMessage = useReplyParent(channelId, item.parentMessageId, allCurrentItemsByIdRef);
  const itemId = item.id;

  const setReaction = useCallback((reaction: string): void => {
    if (!!channelId) {
      chat.channels.setReaction(channelId, itemId, reaction).catch(e => {
        console.error('Error setting reaction', e);
      });
    }
  }, [channelId, itemId]);

  const unsetReaction = useCallback(() => {
    chat.channels.unsetReaction(channelId, itemId).catch(e => {
      console.error('Error removing reaction', e);
    });
  }, [channelId, itemId]);

  const failed = item.sendStatus === 'error-send' || item.sendStatus === 'error-update';
  const retrySend = useCallback(() => {
    chat.channels.retrySend(channelId, itemId);
  }, [channelId, itemId]);
  const discardPending = useCallback(() => {
    chat.channels.discardPending(channelId, itemId);
  }, [channelId, itemId]);

  const repliedTo = useMemo(() => {
    if (!!parentMessage) {
      return {
        id: parentMessage.id,
        creatorId: parentMessage.creatorId,
        body: parentMessage.body
      };
    }
    else {
      return null;
    }
  }, [parentMessage]);

  return (
    <Message
      message={item}
      channelId={item.channelId}
      attachments={item.attachments}
      key={item.id}
      setReaction={setReaction}
      unsetReaction={unsetReaction}
      repliedTo={repliedTo}
      replyClick={replyClick}
      editClick={props.editClick}
      retrySend={failed ? retrySend : undefined}
      discardPending={failed ? discardPending : undefined}
      selected={props.selected}
      editing={props.editing}
      isolatedNewMsg={props.isolatedNewMsg}
      showTimestamp={props.showTimestamp}
      scrollToMessage={scrollToMessage}
      canReply={canReply}
    />
  );
}

export default function MessageViewInner(props: {
  channelId: string;
  communityId?: string;
  updateAutoPin?: boolean;
  writingForbiddenMessage?: string;
  channelName?: string;
  messageIdFocus?: string;
  hideInput?: boolean;
  onMobileFocus?: (focused: boolean) => void;
  callMode?: true;
}) {
  const {
    channelId,
    communityId,
    updateAutoPin,
    writingForbiddenMessage,
    channelName,
    messageIdFocus,
    hideInput,
    onMobileFocus,
    callMode
  } = props;
  const [replyTo, setReplyTo] = useState<{
    id: string,
    senderId: string,
    body: Models.Message.Body
  } | null>(null);
  const [messageToEdit, setMessageToEdit] = useState<Models.Message.Message | undefined>(undefined);
  const ownUser = useOwnUser();

  // Hide reply when changing channels
  useEffect(() => {
    setReplyTo(null);
    !!channelId && serviceWorkerManager.channelVisited(channelId);
  }, [channelId]);

  const createMessage = useCallback(async (body: Models.Message.Body, attachments: Models.Message.Attachment[]) => {
    if (
      !!channelId && !!ownUser?.id &&
      (body.content.length > 0 || attachments.length > 0)
    ) {
      setReplyTo(null);
      if (updateAutoPin && communityId) {
        communityDatabase.setChannelPinState({
          channelId,
          communityId,
          pinType: 'autopin',
          pinnedUntil: (new Date(Date.now() + (24 * 3600 * 1000))).toISOString(),
        }).catch(e => {
          console.error('Error setting autopin', e);
        });
      }
      // resolves once the pending item is shown; failures show on the item
      await chat.channels.createMessage({
        body,
        parentMessageId: replyTo?.id || null,
        attachments,
        channelId,
      });
      return true;
    }
    return false;
  }, [channelId, ownUser?.id, replyTo?.id, communityId, updateAutoPin]);

  const editMessage = useCallback(async (originalMessage: Models.Message.Message, body: Models.Message.Body, attachments: Models.Message.Attachment[]) => {
    if (
      !!ownUser?.id &&
      (body.content.length > 0 || attachments.length > 0)
    ) {
      // resolves once the edit overlay is shown; failures show on the item
      await chat.channels.editMessage(originalMessage, {
        body,
        attachments,
        parentMessageId: replyTo?.id || null,
      });
      setReplyTo(null);
      setMessageToEdit(undefined);
      return true;
    } else {
      setReplyTo(null);
      setMessageToEdit(undefined);
      return false;
    }
    
  }, [ownUser?.id, replyTo?.id]);

  const handleReplyClick = useCallback((id: string, senderId: string, body: Models.Message.Body) => {
    setReplyTo({ id, senderId, body });
  }, []);

  const handleCancelReply = useCallback(() => {
    setReplyTo(null);
  }, []);

  // prefill of the reply when editing a reply: watch the parent until it is known
  const editParentWatchRef = useRef<(() => void) | null>(null);
  const stopEditParentWatch = useCallback(() => {
    editParentWatchRef.current?.();
    editParentWatchRef.current = null;
  }, []);
  useEffect(() => stopEditParentWatch, [channelId, stopEditParentWatch]);

  const handleEditClick = useCallback((message: Models.Message.Message) => {
    stopEditParentWatch();
    setMessageToEdit(message);
    if (message.parentMessageId) {
      let done = false;
      const unsubscribe = chat.channels.watchMessage(channelId, message.parentMessageId, item => {
        if (done) return;
        done = true;
        if (item) {
          setReplyTo({
            id: item.id,
            body: item.body,
            senderId: item.creatorId,
          });
        }
        // may run synchronously inside watchMessage (parent in memory)
        queueMicrotask(stopEditParentWatch);
      });
      editParentWatchRef.current = unsubscribe;
      if (done) stopEditParentWatch();
    }
  }, [channelId, stopEditParentWatch]);

  return (
    <GenericMessageList
      channelId={channelId}
      channelName={channelName}
      createMessage={createMessage}
      Renderer={MessageRenderer}
      replyClick={handleReplyClick}
      editClick={handleEditClick}
      replyingTo={replyTo}
      cancelReply={handleCancelReply}
      messageToEdit={messageToEdit}
      editMessage={editMessage}
      writingForbiddenMessage={writingForbiddenMessage}
      messageIdFocus={messageIdFocus}
      hideInput={hideInput}
      onMobileFocus={onMobileFocus}
      callMode={callMode}
    />
  );
}