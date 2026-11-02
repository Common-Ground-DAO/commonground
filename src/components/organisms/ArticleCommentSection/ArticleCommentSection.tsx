// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef } from 'react';
import { useOwnCommunities, useOwnUser } from 'context/OwnDataProvider';
import messageApi from 'data/api/messages';
import webSocketManager from 'data/appstate/webSocket';
import { chat } from 'data/chat/runtime';
import CommentList from 'components/molecules/CommentList/CommentList';
import data from 'data';
import { useLiveQuery } from 'dexie-react-hooks';

type Props = {
  articleId: string;
  channelId: string;
  articleCommunityId?: string;
  articleUserId?: string;
};

const ArticleCommentSection: React.FC<Props> = (props) => {
  const { articleId, channelId, articleCommunityId, articleUserId } = props;
  const ownUser = useOwnUser();
  const ownCommunities = useOwnCommunities();
  const userId = ownUser?.id;
  const registeredChannel = useRef(false);

  const access = useMemo(() => {
    if (articleCommunityId) {
      return { articleId, channelId, articleCommunityId }
    } else if (articleUserId) {
      return { articleId, channelId, articleUserId }
    }
    return null;
  }, [articleCommunityId, articleId, articleUserId, channelId]);

  if (!registeredChannel.current && access) {
    chat.channels.registerAccessForChannel(access);
    registeredChannel.current = true;
  }

  const community = useLiveQuery(() => {
    if (!articleCommunityId) return undefined;
    return data.community.getCommunityDetailView(articleCommunityId);
  }, [articleCommunityId]);

  const cannotCommentReason = useMemo(() => {
    if (articleCommunityId && ownCommunities.every(comm => comm.id !== articleCommunityId)) {
      return {
        type: 'notJoined' as const,
        community: community
      }
    }
    
    if (!community) return null;

    if (community.blockState.state === 'BANNED') {
      return {
        type: 'banned' as const
      };
    }

    if (community.blockState.state === 'CHAT_MUTED') {
      return {
        type: 'muted' as const
      };
    }

    return null;
  }, [articleCommunityId, community, ownCommunities]);

  // Event room of the article comments: per socket on the server, so it is
  // joined while live and joined again on every live transition (new socket,
  // or the socket's user changed); left on unmount.
  useEffect(() => {
    if (!userId || !access) return;
    let mounted = true;
    let joined = false;
    const leave = () => {
      joined = false;
      if (!webSocketManager.live) return; // the socket that joined is gone
      messageApi.leaveArticleEventRoom({ access }).catch(() => {
        console.error('Failed to leave article event room');
      });
    };
    const join = () => {
      if (!webSocketManager.live) return;
      messageApi.joinArticleEventRoom({ access }).then(() => {
        joined = true;
        if (!mounted) leave();
      }).catch(() => {
        console.error('Failed to join article event room');
      });
    };
    join();
    const unsubscribe = webSocketManager.onLive(join);
    return () => {
      mounted = false;
      unsubscribe();
      if (joined) leave();
    };
  }, [userId, access]);

  const createMessage = useCallback(async (
    body: Models.Message.Body,
    attachments: Models.Message.Attachment[],
    parentMessageId: string | null = null
  ) => {
    if (
      !!channelId && !!ownUser?.id &&
      (body.content.length > 0 || attachments.length > 0)
    ) {
      // resolves once the pending comment is shown; failures show on it
      await chat.channels.createMessage({
        body,
        parentMessageId,
        attachments,
        channelId,
      });
      return true;
    }
    return false;
  }, [channelId, ownUser?.id]);

  const deleteMessage = useCallback((messageId: string) => {
    if (access) {
      chat.channels.deleteMessage(channelId, messageId, ownUser?.id || '').catch(() => {
        console.error('Failed to delete message');
      });
    }
  }, [access, channelId, ownUser?.id]);

  return (<div className='flex flex-col gap-4 w-full'>
    {registeredChannel.current && <CommentList
      articleId={articleId}
      channelId={channelId}
      createMessage={createMessage}
      deleteMessage={deleteMessage}
      cannotCommentReason={cannotCommentReason}
    />}
  </div>);
}

export default ArticleCommentSection