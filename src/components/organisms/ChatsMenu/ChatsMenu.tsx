// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import './ChatsMenu.css';
import { FloatingDelayGroup } from '@floating-ui/react';
import { useNavigate } from "react-router-dom";
import { useGlobalDictionaryContext } from '../../../context/GlobalDictionaryProvider';
import ChatElement from './ChatElement/ChatElement';
import Scrollable from '../../molecules/Scrollable/Scrollable';

import { getUrl } from 'common/util';
import { useChats } from 'context/OwnDataProvider';
import EmptyState from 'components/molecules/EmptyState/EmptyState';

function ChatsMenu(props: { highlightedChatId?: string }) {
  const navigate = useNavigate();
  const conversationsMenuRef = React.useRef<HTMLDivElement>(null);

  const { chats } = useChats();
  const { dict } = useGlobalDictionaryContext();

  return (
    <FloatingDelayGroup delay={{ open: 500, close: 100 }}>
      <div className='conversations-menu-container'>
        <div className={`conversations-menu ${dict["mobile-menu-visible"] === true ? "mobile-menu-visible" : ""} ${dict["conversations-menu-visible"] === true ? "conversations-menu-visible" : ""}`} ref={conversationsMenuRef}>
          <Scrollable className="conversations-list" innerClassName="px-2">
            <div>
              {chats.map(chat => (
                <div
                  key={chat.id}
                  onClick={() => navigate(getUrl({ type: 'chat', chat }))}
                >
                  <ChatElement
                    chat={chat}
                    highlighted={chat.id === props.highlightedChatId}
                  />
                </div>
              ))}
              {chats.length === 0 && <EmptyState title='Your inbox is empty' description="To message someone, you must follow them, and they must follow you back!"/>}
            </div>
          </Scrollable>
        </div>
      </div>
    </FloatingDelayGroup>
  );
}

export default React.memo(ChatsMenu);