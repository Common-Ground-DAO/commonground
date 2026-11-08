// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import Button from "../../../../components/atoms/Button/Button";
import ReplyIcon from "../../../atoms/icons/20/Reply.svg?react";

export default function ReplyTooltip(props: {
    id: string,
    senderId: string,
    body: Models.Message.Body,
    onReplyClick: (id: string, senderId: string, body: Models.Message.Body) => void
  }) {
    const { id, senderId, body, onReplyClick } = props;
  
    const handleReplyClick = () => {
      onReplyClick(id, senderId, body);
    }
  
    return (
      <Button iconLeft={<ReplyIcon />} role="borderless" onClick={handleReplyClick} />
    );
}