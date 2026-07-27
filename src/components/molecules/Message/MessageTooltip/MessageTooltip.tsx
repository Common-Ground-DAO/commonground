// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback, useEffect } from "react";
import config from "common/config";
import { useSafeCommunityContext } from "../../../../context/CommunityProvider";

import Button from "../../../../components/atoms/Button/Button";
import EmojiPickerTooltip from "../../EmojiPickerTooltip/EmojiPickerTooltip";
import ReplyTooltip from "../ReplyTooltip/ReplyTooltip";

import { ReactComponent as ModIcon } from '../../../../components/atoms/icons/20/Mod.svg';
import { ReactComponent as DeleteIcon } from '../../../../components/atoms/icons/20/Delete.svg';
import { ReactComponent as EditIcon } from '../../../../components/atoms/icons/20/Edit.svg';

import "./MessageTooltip.css";
import { useOwnUser } from "context/OwnDataProvider";
import { useCommunityModerationContext } from "context/CommunityModerationContext";
import { useReportModalContext } from "context/ReportModalProvider";
import { ReportType } from "common/enums";
import { Flag, PushPin } from "@phosphor-icons/react";
import { useSnackbarContext } from "context/SnackbarContext";
import data from "data";

export default function MessageToolTip(props: {
  channelId: string;
  setReaction: (reaction: string) => void;
  replyClick: (id: string, senderId: string, body: Models.Message.Body) => void;
  replyTo: {
    id: string;
    senderId: string;
    body: Models.Message.Body;
  };
  updatePosition?: () => void;
  senderId: string;
  messageId: string;
  isSpecialMessage: boolean;
  onEditClick: () => void;
  stickTooltip: (isSticked: boolean) => void;
  onOpenUserTooltip: () => void;
}) {
  const communityState = useSafeCommunityContext();
  const { setReaction, replyClick, replyTo, channelId, updatePosition, senderId, messageId, isSpecialMessage, onEditClick } = props;
  const { deleteMessage } = useCommunityModerationContext();
  const { showSnackbar } = useSnackbarContext();
  const commContext = useSafeCommunityContext();

  const handleEmojiClick = (value: string) => {
    try {
      setReaction(value);
    } catch (err) {
      console.error(err);
    }
  }

  useEffect(() => {
    updatePosition?.();
  }, [updatePosition]);

  const onPinMessage = useCallback(async () => {
    // FIXME: Only pins for community channel, doesn't work for chats or calls right now
    if (commContext.state === 'loaded') {
      const { community, channelsById } = commContext;
      const channel = channelsById.get(props.channelId);
      if (!channel) return;

      if (channel.pinnedMessageIds?.includes(messageId)) {
        try {
          await data.community.updateChannel(community.id, props.channelId, {
            pinnedMessageIds: (channel.pinnedMessageIds || []).filter(mId => mId !== messageId)
          });
          showSnackbar({ type: 'success', text: 'Message unpinned' });
        } catch (e) {
          console.error(e);
        }
      } else {
        if ((channel.pinnedMessageIds?.length || 0) >= 2) {
          showSnackbar({ type: 'warning', text: 'Only 2 messages can be pinned' });
          return;
        }
  
        try {
          await data.community.updateChannel(community.id, props.channelId, {
            pinnedMessageIds: [...channel.pinnedMessageIds || [], messageId]
          });
          showSnackbar({ type: 'success', text: 'Message pinned' });
        } catch (e) {
          console.error(e);
        }
      }
    }
  }, [commContext, messageId, props.channelId, showSnackbar]);

  const { showReportModal } = useReportModalContext();
  const ownUser = useOwnUser();

  const isSelf = !!ownUser && senderId === ownUser.id;
  const canModerateUser = communityState.state === "loaded" && communityState.communityPermissions.has('COMMUNITY_MODERATE');
  const canManageChannel = communityState.state === "loaded" && communityState.communityPermissions.has('COMMUNITY_MANAGE_CHANNELS');

  return (
    <div className="message-tooltip cg-box-shadow-md">
      <FeaturedEmojiList onEmojiClick={handleEmojiClick} />
      <EmojiPickerTooltip onEmojiClick={handleEmojiClick} isTooltipOpen={props.stickTooltip} />
      <div className="cg-separator-vertical h-10" />
      <ReplyTooltip id={messageId} senderId={replyTo.senderId} body={replyTo.body} onReplyClick={replyClick} />
      {isSelf && !isSpecialMessage && <>
        <div className="cg-separator-vertical h-10" />
        <Button iconLeft={<EditIcon />} role="borderless" onClick={onEditClick} />
      </>}
      {isSelf && !isSpecialMessage && <>
        <div className="cg-separator-vertical h-10" />
        <Button iconLeft={<DeleteIcon />} role="borderless" onClick={() => deleteMessage(messageId, senderId, channelId)} />
      </>}
      {canModerateUser && !isSelf && (<>
        <div className="cg-separator-vertical h-10" />
        <Button
          iconLeft={<ModIcon />}
          role="borderless"
          onClick={props.onOpenUserTooltip}
        />
      </>)}
      {canManageChannel && <>
        <div className="cg-separator-vertical h-10" />
        <Button
          iconLeft={<PushPin weight="duotone" className="w-5 h-5 cg-text-warning" />}
          role="borderless"
          onClick={onPinMessage}
        />
      </>}
      {!!ownUser && !isSelf && <>
        <div className="cg-separator-vertical h-10" />
        <Button
          iconLeft={<Flag weight="duotone" className="w-5 h-5" />}
          role="borderless"
          onClick={() => showReportModal({ type: ReportType.MESSAGE, targetId: messageId })}
        />
      </>}
    </div>
  );
}

function FeaturedEmojiList(props: { onEmojiClick: (emoji: string) => void }) {
  const { onEmojiClick } = props;

  return (
    <div className="emoji-featured-list">
      {config.REACTION_EMOJIS.map(emoji => (<span key={emoji} className='emoji' onClick={() => onEmojiClick(emoji)}>{emoji}</span>))}
    </div>
  )
}