// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { getDisplayName } from "../../../../util";
import ReplyIcon from "../../../atoms/icons/20/Reply.svg?react";
import { convertContentToPlainText } from "../../../../common/converters";
import { useOwnUser } from "context/OwnDataProvider";

import "./ReplyContentRenderer.css";
import { useUserData } from "context/UserDataProvider";
import BotBadge from "components/atoms/BotBadge/BotBadge";

export default function ReplyContentRenderer(props: {
  id: string;
  senderId: string;
  body: Models.Message.Body;
  scrollToMessage?: (messageId: string) => void;
}) {
  const { id, senderId, body, scrollToMessage } = props;
  const ownData = useOwnUser();
  const isSelf = !!ownData && senderId === ownData.id;

  const user = useUserData(senderId);

  const scrollToLocation = () => {
    if (scrollToMessage) {
      scrollToMessage(id);
    }
    else {
      console.warn("No scrollToMessage function provided.");
      // const element = document.getElementById(id);
      // if (element) {
      //   setTimeout(() => element.scrollIntoView(), 0);

      //   // briefly highlight message
      //   element.className += ' selected';
      //   setTimeout(() => {
      //     element.classList.remove('selected');
      //   }, 5000);
      // } else {
      //   setTimeout(() => {
      //     const firstMessage = document.getElementById("message-group-container-0");
      //     firstMessage?.scrollIntoView();
      //     scrollToLocation();
      //   }, 100);
      // }
    }
  }

  const replyMessage = convertContentToPlainText(body.content).replaceAll(/\s/g, ' ');
  return (
    <div className="replied-to-message" onClick={scrollToLocation}>
      <div className="replied-to-message-display-name">
        <ReplyIcon />
        {isSelf ? getDisplayName(ownData) : user ? getDisplayName(user) : senderId}
        {!isSelf && user?.isBot && <BotBadge />}
      </div>
      <div className="replied-to-message-message">
        {replyMessage}
      </div>
    </div>
  );
}
