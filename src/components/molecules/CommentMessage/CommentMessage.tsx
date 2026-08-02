// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './CommentMessage.css';
import Jdenticon from 'components/atoms/Jdenticon/Jdenticon';
import { useUserData } from 'context/UserDataProvider';
import React, { useEffect, useState } from 'react';
import { getDisplayName } from '../../../util';
import { AllContentRenderer } from '../MesssageBodyRenderer/MessageBodyRenderer';
import { useOwnUser } from 'context/OwnDataProvider';
import Button from 'components/atoms/Button/Button';
import { Trash } from '@phosphor-icons/react';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { calculateAgeString } from 'views/TokenSale/TokenSale';
import ReplyIcon from "../../atoms/icons/20/Reply.svg?react";
import data from 'data';
import ReplyContentRenderer from '../Message/ReplyContentRenderer/ReplyContentRenderer';
import MessageAttachments from '../Message/MessageAttachments/MessageAttachments';
import { useSidebarDataDisplayContext } from 'context/SidebarDataDisplayProvider';
import { useReportModalContext } from 'context/ReportModalProvider';
import { ReportType } from 'common/enums';
import { Flag } from '@phosphor-icons/react';

type Props = {
  message: Models.Message.Message;
  channelId: string;
  onDeleteMessage: (messageId: string) => void;
  replyClick: (id: string, creatorId: string, body: Models.Message.Body) => void;
  allCurrentItemsByIdRef: React.MutableRefObject<Map<string, Models.Message.Message>>;
};

const CommentMessage: React.FC<Props> = (props) => {
  const { message, channelId, onDeleteMessage, replyClick, allCurrentItemsByIdRef } = props;
  const ownUser = useOwnUser();
  const creator = useUserData(message.creatorId);
  const { showTooltip } = useSidebarDataDisplayContext();
  const { showReportModal } = useReportModalContext();
  const { isMobile } = useWindowSizeContext();
  const isOwnMessage = ownUser && ownUser.id === message.creatorId;
  const [showDeleteModal, setShowDeleteModal] = useState(false);

  const { parentMessageId } = message;
  const [parentMessage, setParentMessage] = useState<Models.Message.Message | undefined>(!!parentMessageId ? allCurrentItemsByIdRef.current?.get(parentMessageId) : undefined);

  const scrollToMessage = (messageId: string) => {
    const foundMessage = document.getElementById(messageId)
    if (foundMessage) {
      foundMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
    } else {
      // Scroll to bottom if message not found
      document.getElementById('end-of-comment-list')?.scrollIntoView({ behavior: 'smooth' });
    }
  }

  useEffect(() => {
    if (!!parentMessageId) {
      if (!!channelId && parentMessage?.id !== parentMessageId) {
        const existing = !!parentMessageId ? allCurrentItemsByIdRef.current?.get(parentMessageId) : undefined;
        if (existing) {
          setParentMessage(existing);
        }
        else {
          const resultPromise = data.channelManager.getMessageById(channelId, parentMessageId, (updatedMessage) => {
            setParentMessage(updatedMessage);
          }).then(result => {
            if (!!result.item) {
              setParentMessage(result.item);
            }
            return result;
          });

          return () => {
            resultPromise.then(result => result.unsubscribe());
          };
        }
      }
    }
    else if (!!parentMessage) {
      setParentMessage(undefined);
    }
  }, [parentMessageId, channelId, parentMessage, allCurrentItemsByIdRef]);

  return <div className='w-full p-4 flex flex-col gap-2 cg-bg-2nd cg-border-xl cg-box-shadow-md' id={message.id}>
    <div className='flex items-center justify-between'>
      <div className='flex gap-2 items-start justify-start cursor-pointer' onClick={() => showTooltip({ type: 'user', userId: message.creatorId, showDeleteButton: false })}>
        <Jdenticon
          userId={message.creatorId}
          predefinedSize='40'
          hideStatus
        />
        <div className='flex flex-col'>
          <span className='cg-text-lg-500'>{creator && getDisplayName(creator)}</span>
          <span className='cg-text-secondary cg-text-md-400'>{calculateAgeString(new Date(message.createdAt))}</span>
        </div>
      </div>
      <div className='flex items-center gap-2'>
        <Button
          role='secondary'
          iconLeft={<ReplyIcon />}
          onClick={() => replyClick(message.id, message.creatorId, message.body)}
        />
        {ownUser && !isOwnMessage && <Button
          role='secondary'
          iconLeft={<Flag weight='duotone' className='w-5 h-5' />}
          onClick={() => showReportModal({ type: ReportType.MESSAGE, targetId: message.id })}
        />}
        {isOwnMessage && <>
          <Button
            role='secondary'
            iconLeft={<Trash weight='duotone' className='w-5 h-5' />}
            onClick={() => {
              setShowDeleteModal(true);
            }}
          />
          <ScreenAwareModal
            isOpen={showDeleteModal}
            onClose={() => setShowDeleteModal(false)}
            hideHeader
          >
            <div className={`flex flex-col gap-2 ${isMobile ? 'px-4' : ''}`}>
              <h3>Delete Comment</h3>
              <p>Are you sure you want to delete this comment?</p>
              <div className="flex flex-row gap-2 justify-end">
                <Button role="borderless" text="Cancel" onClick={() => setShowDeleteModal(false)} />
                <Button role="primary" text="Delete" onClick={() => {
                  onDeleteMessage(message.id);
                  setShowDeleteModal(false);
                }} />
              </div>
            </div>
          </ScreenAwareModal>
        </>}
      </div>

    </div>

    <div className='cg-separator' />
    {parentMessage &&
      <ReplyContentRenderer
        id={parentMessage.id}
        senderId={parentMessage.creatorId}
        body={parentMessage.body}
        scrollToMessage={scrollToMessage}
      />
    }
    <div className='break-words'>
      <AllContentRenderer
        content={message.body.content}
      />
      {message.attachments && message.attachments.length > 0 &&
        <MessageAttachments
          attachments={message.attachments}
          setImageModalOpen={() => { }}
        />}
    </div>
  </div>;
}

export default React.memo(CommentMessage);