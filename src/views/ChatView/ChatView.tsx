// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useMemo } from 'react';
import { useParams } from 'react-router';
import './ChatView.css';
import { useGlobalDictionaryContext } from '../../context/GlobalDictionaryProvider';

import DirectMessageBar from '../../components/molecules/DirectMessageBar/DirectMessageBar';
import ChatsMenu from '../../components/organisms/ChatsMenu/ChatsMenu';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { createTranslator } from "short-uuid";
import { useChats, useOwnUser } from 'context/OwnDataProvider';
import MessageViewInner from 'views/MessageViewInner/MessageViewInner';

const t = createTranslator();

export default function ChatView(props: { chatId?: string }) {
  const { chatShortUuid } = useParams<'chatShortUuid'>();
  if (!chatShortUuid && !props.chatId) {
    throw new Error("Either chatId or chatShortUuid in URL required");
  }

  const chatId = chatShortUuid ? t.toUUID(chatShortUuid.replace('~', '')) : props.chatId as string;
  const { chats } = useChats();
  const ownUser = useOwnUser();
  const chat = chats.find(chat => chat.id === chatId);

  const { setEntry } = useGlobalDictionaryContext();
  const { isMobile, isTablet } = useWindowSizeContext();
  
  const otherUserId = useMemo(() => {
    if (!!ownUser?.id && !!chat) {
      return chat.userIds.find(id => id !== ownUser.id);
    }
  }, [ownUser?.id, chat]);
  
  useEffect(() => {
    setEntry('menu-visible', false);
    setEntry('conversations-menu-visible', false);
  }, [setEntry]);

  return (
    <div className="direct-messages">
      {!!chat && <DirectMessageBar contactPersonId={otherUserId} chat={chat} />}
        {!!chat && (
          <div className="direct-conversation">
            <MessageViewInner channelId={chat.channelId} />
          </div>
        )}
        {!isMobile && !isTablet && <ChatsMenu />}
    </div>
  );
}