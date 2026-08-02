// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';

import { getDisplayName } from "../../../util";
import ReplyIcon from '../../atoms/icons/16/Reply.svg?react';
import CloseIcon from '../../atoms/icons/16/Close-1.svg?react';
import Jdenticon from '../../atoms/Jdenticon/Jdenticon';
import { convertContentToPlainText } from '../../../common/converters';

import "./EditFieldReplyPreview.css";
import { useUserData } from 'context/UserDataProvider';
import BotBadge from 'components/atoms/BotBadge/BotBadge';

export default function EditFieldReplyPreview(props: {
  replyingTo: {
    id: string;
    senderId: string;
    body: Models.Message.Body;
  },
  cancelReply: () => void
}) {
  const { replyingTo, cancelReply } = props;
  const userData = useUserData(replyingTo.senderId);

  const scrollToLocation = () => {
    const element = document.getElementById(replyingTo.id);
    if (element) {
      setTimeout(() => element.scrollIntoView(), 0);

      // briefly highlight message
      element.className += ' selected';
      setTimeout(() => {
        element.classList.remove('selected');
      }, 2500);
    } else {
      setTimeout(() => {
        const firstMessage = document.getElementById("message-group-container-0");
        firstMessage?.scrollIntoView();
        scrollToLocation();
      }, 100);
    }
  }

  const onCancelClick = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    ev.preventDefault();
    cancelReply();
  }

  return (
    <div className="replying-to-content" onClick={() => scrollToLocation()}>
      <ReplyIcon />
      <Jdenticon userId={replyingTo.senderId} />
      <div className="sender-display-name flex items-center gap-1">
        {userData ? getDisplayName(userData) : replyingTo.senderId}
        {userData?.isBot && <BotBadge />}
      </div>
      <div className="reply-preview-message">
        {convertContentToPlainText(replyingTo.body.content as any)}
      </div>
      <CloseIcon className="reply-close" onClick={onCancelClick} />
    </div>
  )
}
