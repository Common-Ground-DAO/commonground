// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './Message.css';
import React, { useCallback, useEffect, useMemo, useState, useRef } from "react";
import MessageAttachments from "./MessageAttachments/MessageAttachments";
import MessageBodyRenderer from "../MesssageBodyRenderer/MessageBodyRenderer";
import MessageToolTip from "./MessageTooltip/MessageTooltip";
import ReactionsDisplay from "./ReactionsDisplay/ReactionsDisplay";
import ReplyContentRenderer from "./ReplyContentRenderer/ReplyContentRenderer";
import ReactDOM from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import {
  useFloating,
  useInteractions,
  useHover,
  useDelayGroupContext,
  useDelayGroup,
  useFloatingParentNodeId,
  FloatingTree,
  offset,
  useDismiss,
  FloatingContext,
  useClick
} from "@floating-ui/react-dom-interactions";
import { useWindowSizeContext } from "../../../context/WindowSizeProvider";
import { useOwnUser } from "context/OwnDataProvider";
import MessageTimestamp from "./MessageTimestamp/MessageTimestamp";
import UserTooltip from 'components/organisms/UserTooltip/UserTooltip';
import { UserTooltipHandle } from 'components/atoms/Tooltip/UserProfilePopover';
import { useSafeCommunityContext } from 'context/CommunityProvider';
import ReplyIcon from 'components/atoms/icons/20/Reply.svg?react';

type Props = {
  message: Models.Message.Message;
  attachments?: Models.Message.Attachment[];
  repliedTo: {
    id: string;
    creatorId: string;
    body: Models.Message.Body;
  } | null;
  channelId: string;
  setReaction: (reaction: string) => void;
  unsetReaction: () => void;
  replyClick: (id: string, creatorId: string, body: Models.Message.Body) => void;
  editClick: (message: Models.Message.Message) => void;
  visibilityObserver: IntersectionObserver;
  selected?: boolean;
  editing?: boolean;
  isolatedNewMsg?: boolean;
  showTimestamp?: boolean;
  scrollToMessage?: (messageId: string) => void;
  canReply: boolean;
}

// maximum the arcus tangens result will asymptotically approach
const REPLY_CLIENTX_TRIGGER = 45;
const REPLY_CLIENTX_DEBOUNCE = 4;
const REPLY_CLIENTY_CANCEL_TRIGGER = 60; // will trigger if ymove > this AND xmove < ymove
const ATAN_ASYMPTOTE_MAX = 60;
const MAGIC_FACTOR = ATAN_ASYMPTOTE_MAX / (Math.PI / 2);
const getEasedDragDistance = (dragDistance: number) => {
  return Math.atan((dragDistance) / MAGIC_FACTOR) * MAGIC_FACTOR;
};

export default function Message(props: Props) {
  const {
    message,
    repliedTo,
    setReaction,
    unsetReaction,
    replyClick,
    channelId,
    attachments,
    editClick,
    visibilityObserver,
    selected,
    editing,
    isolatedNewMsg,
    showTimestamp,
    scrollToMessage,
    canReply,
  } = props;
  const { isMobile } = useWindowSizeContext();
  const [messageIsHovered, setMessageIsHovered] = useState<boolean>(false);
  const [isTooltipSticked, setTooltipSticked] = useState(false);
  const [isImageModalOpen, setIsImageModalOpen] = useState(false);
  const [showReplyIndicator, setShowReplyIndicator] = useState(false);
  const { delay, currentId, setCurrentId } = useDelayGroupContext();
  const parentId = useFloatingParentNodeId();
  const tooltipRoot = useMemo(() => document.getElementById("tooltip-root") as HTMLElement, []);
  const messageRef = useRef<HTMLDivElement>(null);
  const delayedCloseTimeoutRef = useRef<any>(null);
  const ownUser = useOwnUser();
  const userTooltipRef = useRef<UserTooltipHandle>(null);
  const replyIndicatorDivRef = useRef<HTMLDivElement>(null);
  const communityState = useSafeCommunityContext();

  const canModerateUser = communityState.state === "loaded" && communityState.communityPermissions.has('COMMUNITY_MODERATE');
  const ownMessage = !!ownUser && ownUser?.id === message.creatorId;

  useEffect(() => {
    const element = messageRef.current;
    if (element) {
      visibilityObserver.observe(element);

      return () => visibilityObserver.unobserve(element);
    }
  }, [visibilityObserver]);

  const onOpenChange = useCallback(
    (open: boolean) => {
      if (open) {
        setMessageIsHovered(true);
        setCurrentId(message.id);
      } else {
        if (isMobile || message.id !== currentId) {
          setMessageIsHovered(false);
        } else {
          if (delayedCloseTimeoutRef.current) {
            clearTimeout(delayedCloseTimeoutRef.current);
          }
          setMessageIsHovered(false);
        }
      }
    }
  , [message.id, currentId, isMobile, setCurrentId, setMessageIsHovered]);

  const { x, y, reference, floating, strategy, context, update } = useFloating({
    placement: "top-end",
    open: messageIsHovered && !isImageModalOpen,
    onOpenChange,
    middleware: [
      offset({ mainAxis: -6 })
    ]
  });

  useEffect(() => {
    window.requestAnimationFrame(() => {
      const current = context.refs.reference.current as HTMLDivElement | null;
      if (
        current &&
        current.style.opacity === '' &&
        current.style.transform === ''
      ) {
        current.style.opacity = '1';
        current.style.transform = 'scale(1.0)';
      }
    });
  }, [context.refs.reference.current]);

  const { getReferenceProps } = useInteractions([
    useDelayGroup(context, { id: message.id }),
    useHover(context, {
      enabled: !isMobile,
      delay,
      handleClose: (() => {
        const fn = ({ onClose, refs }: FloatingContext & { onClose: () => void }) => (event: PointerEvent) => {
          if (isTooltipSticked) return;

          const path = event.composedPath();
          const triggerEl = refs.reference.current;
          const floatEl = refs.floating.current;
          const isNotTriggerElement = !path.includes(triggerEl as any);
          const isNotFloatElement = !path.includes(floatEl as any);
          const isNotRootElement = !path.includes(tooltipRoot);
          if (refs.floating.current && isNotTriggerElement && isNotFloatElement && isNotRootElement) {
            onClose();
          }
        };
        fn.__options = {
          blockPointerEvents: false
        }
        return fn;
      })()
    }),
    useClick(context, {
      enabled: isMobile
    }),
    useDismiss(context, {
      enabled: true,
      ancestorScroll: true,
      outsidePressEvent: 'click'
    }),
  ]);

  const touchOngoingRef = useRef<boolean>(false);
  const touchTriggeredRef = useRef<boolean>(false);
  const touchCanceledRef = useRef<boolean>(false);
  const touchStartXRef = useRef<number>(0);
  const touchStartYRef = useRef<number>(0);
  const touchShiftRef = useRef<number>(0);
  const touchListener = useCallback((type: 'start' | 'move' | 'end' | 'cancel', event: React.TouchEvent<HTMLDivElement>) => {
    const current = context.refs.reference.current as HTMLDivElement | null;
    const replyDiv = replyIndicatorDivRef.current;
    if (canReply && current && replyDiv && !!ownUser?.id) {
      switch (type) {
        case 'start': {
          touchOngoingRef.current = true;
          touchTriggeredRef.current = false;
          touchCanceledRef.current = false;
          touchShiftRef.current = 0;
          const touch = event.touches[0];
          if (touch) {
            touchStartXRef.current = touch.clientX;
            touchStartYRef.current = touch.clientY;
          }
          break;
        }
        case 'move': {
          if (touchCanceledRef.current === true) {
            return; // cancel is already handled
          }
          const touch = event.touches[0];
          if (touch && touchOngoingRef.current === true) {
            const dragDistance = touch.clientX - touchStartXRef.current;
            const yDistance = Math.abs(touch.clientY - touchStartYRef.current);
            if (dragDistance < yDistance && yDistance > REPLY_CLIENTY_CANCEL_TRIGGER) {
              touchCanceledRef.current = true;
              break;
            }
            if (dragDistance <= 0) {
              touchShiftRef.current = 0;
            }
            else {
              touchShiftRef.current = getEasedDragDistance(dragDistance);
            }
          }
          break;
        }
        case 'cancel':
        case 'end': {
          if (touchCanceledRef.current === true) {
            return; // cancel is already handled
          }
          if (type === 'end' && touchTriggeredRef.current === true) {
            replyClick(message.id, message.creatorId, message.body);
          }
          touchOngoingRef.current = false;
          touchTriggeredRef.current = false;
          setShowReplyIndicator(false);
          touchShiftRef.current = 0;
          break;
        }
      }
      // handle cancel once
      if (touchCanceledRef.current === true) {
        touchOngoingRef.current = false;
        touchTriggeredRef.current = false;
        setShowReplyIndicator(false);
        touchShiftRef.current = 0;
        replyDiv.style.opacity = '0';
      }
      if (touchShiftRef.current > REPLY_CLIENTX_TRIGGER && touchTriggeredRef.current === false) {
        touchTriggeredRef.current = true;
        setShowReplyIndicator(true);
        // keep these lines duplicate with the else, to execute it before trying to vibrate
        current.style.transform = `scale(1.0) translate(${touchShiftRef.current}px, 0px)`;
        replyDiv.style.transform = `translate(-${touchShiftRef.current}px, 0px) scale(1)`;
        replyDiv.style.opacity = '1';

        try {
          if (navigator.vibrate) {
            navigator.vibrate(2);
          }
        }
        catch (e) {}
      }
      else if (touchShiftRef.current < (REPLY_CLIENTX_TRIGGER - REPLY_CLIENTX_DEBOUNCE) && touchTriggeredRef.current === true) {
        touchTriggeredRef.current = false;
        setShowReplyIndicator(false);
        // keep these lines duplicate with the else, to execute it before trying to vibrate
        current.style.transform = `scale(1.0) translate(${touchShiftRef.current}px, 0px)`;
        replyDiv.style.transform = `translate(-${touchShiftRef.current}px, 0px)  scale(0.8)`;
        replyDiv.style.opacity = '0';

        try {
          if (navigator.vibrate) {
            navigator.vibrate(1);
          }
        }
        catch (e) {}
      }
      else {
        current.style.transform = `scale(1.0) translate(${touchShiftRef.current}px, 0px)`;
        replyDiv.style.transform = `translate(-${touchShiftRef.current}px, 0px) ${touchTriggeredRef.current ? 'scale(1)' : 'scale(0.8)'}`;
      }
    }
  }, [context.refs.reference.current, showReplyIndicator, replyClick, message.id, message.updatedAt.getTime(), canReply, ownUser?.id]);

  const tooltipSetReaction = React.useCallback((reaction: string) => {
    setReaction(reaction);
    setMessageIsHovered(false);
  }, [setReaction, setMessageIsHovered]);

  useEffect(() => {
    const listener = () => {
      let tooltipMinLeft = 0;
      if (messageRef.current) {
        let element: HTMLElement | null = messageRef.current;
        // Todo: fix fullscreen?
        while (!!element && typeof element.offsetLeft === 'number') {
          tooltipMinLeft += element.offsetLeft;
          if (!!element.offsetParent && document.body.contains(element.offsetParent)) {
            element = element.offsetParent as HTMLElement;
          }
          else {
            element = null;
          }
        }
      }
      setTooltipMinLeft(tooltipMinLeft);
    };
    listener();
    window.addEventListener('resize', listener);
    return () => window.removeEventListener('resize', listener);
  }, []);

  const [tooltipMinLeft, setTooltipMinLeft] = useState<number>(0);

  const floatingStyle = useMemo(() => {
    const result: React.CSSProperties = {
      position: strategy,
      top: y ?? 0,
      left: ownMessage ? x ?? 0 : Math.max(x ?? 0, tooltipMinLeft),
      visibility: x === null || y === null ? "hidden" : "visible",
      zIndex: 10,
      boxSizing: "border-box",
      border: "none",
      padding: "0",
    };
    return result;
  }, [strategy, x, y, tooltipMinLeft, ownMessage]);

  const hasReactions = useMemo(() => !!message.reactions && Object.keys(message.reactions).length > 0, [message.reactions]);
  const isSpecial = useMemo(() => message.body.content[0]?.type === "special", [message.body]);
  const messageItemClassname = [`message-item ${hasReactions ? 'message-item-with-reactions' : ''}`,
    ownMessage ? 'own-message' : '',
    isolatedNewMsg ? 'isolated-new-msg' : '',
    showTimestamp || isTooltipSticked ? 'show-timestamp' : '',
    selected ? 'selected' : '',
    editing ? 'editing' : '',
    isSpecial ? 'special' : '',
  ].join(' ').replace(/  +/, ' ').trim();

  const replyContent = useMemo(() => {
    return <>
      <ReplyIndicator
          show={showReplyIndicator}
          divRef={replyIndicatorDivRef}
        />
        {repliedTo &&
          <ReplyContentRenderer
            id={repliedTo.id}
            senderId={repliedTo.creatorId}
            body={repliedTo.body}
            scrollToMessage={scrollToMessage}
          />
        }
        {!repliedTo && message.parentMessageId !== null && // only briefly visible if the message is not within the loaded item range, to prevent resizing after load
          <div className='replied-to-message'>loading reply...</div>
        }
    </>;
  }, [repliedTo, message.parentMessageId, scrollToMessage, showReplyIndicator]);

  const messageContent = useMemo(() => {
    const extraMessageProps = message.sendStatus === undefined
      ? { "data-timestamp": message.createdAt.toISOString() }
      : {};

    return (
      <div className="message-item-content" ref={messageRef} {...extraMessageProps}>
        <div className="message-item-message">
          <MessageBodyRenderer message={message} key={`body-${message.id}`} hideTimestamp={attachments && attachments.length > 0} />
          {attachments && attachments.length > 0 && <>
            <MessageAttachments key={`attachments-${message.id}`} attachments={attachments} setImageModalOpen={setIsImageModalOpen} />
            <MessageTimestamp
              messageTimestamp={message.createdAt.toString()}
              lastUpdateTimestamp={message.updatedAt.toString()}
              isEdited={message.editedAt !== null}
            />
          </>}
          <ReactionsDisplay key={`reactions-${message.id}`} message={message} setReaction={setReaction} unsetReaction={unsetReaction} />
        </div>
        {canModerateUser && <UserTooltip
          ref={userTooltipRef}
          placement='right'
          userId={message.creatorId}
          isMessageTooltip={true}
          hoveredMessageId={message.id}
          channelId={channelId}
          defaultView="admin"
          openDelay={500}
          closeDelay={100}
        />}
      </div>
    );
  }, [message.id, message.updatedAt.getTime(), setReaction, unsetReaction, canModerateUser, channelId]);

  const messageHoveredContent = useMemo(() => {
    if (messageIsHovered) {
      return ReactDOM.createPortal((
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0, scale: 0.85 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ type: "spring", damping: 20, stiffness: 300, delay: 0.0 }}
            ref={floating}
            style={floatingStyle}
          >
            <MessageToolTip
              channelId={channelId}
              setReaction={tooltipSetReaction}
              replyClick={replyClick}
              replyTo={{
                id: message.id,
                senderId: message.creatorId,
                body: message.body,
              }}
              updatePosition={update}
              senderId={message.creatorId}
              messageId={message.id}
              isSpecialMessage={message.body.content.some(entry => entry.type === 'special')}
              onEditClick={() => editClick(message)}
              stickTooltip={setTooltipSticked}
              onOpenUserTooltip={() => userTooltipRef.current?.open()}
            />
          </motion.div>
        </AnimatePresence>
      ), document.getElementById("tooltip-root") as HTMLElement);
    }
    else {
      return null;
    }
  }, [messageIsHovered, message.body, message.id, message.updatedAt.getTime(), channelId, editClick, floating, floatingStyle, replyClick, tooltipSetReaction, update])

  const returnValue = useMemo(() => {
    const content = (
      <div
        {...getReferenceProps({ ref: reference, className: messageItemClassname })}
        id={message.id}
        onTouchStart={touchListener.bind(null, 'start')}
        onTouchMove={touchListener.bind(null, 'move')}
        onTouchEnd={touchListener.bind(null, 'end')}
        onTouchCancel={touchListener.bind(null, 'cancel')}
      >
        {replyContent}
        {messageContent}
        {messageHoveredContent}
      </div>
    );
  
    if (parentId === null) {
      return (
        <FloatingTree>
          {content}
        </FloatingTree>
      )
    } else {
      return content;
    }
  }, [reference, messageItemClassname, touchListener, replyContent, messageContent, messageHoveredContent, parentId]);
  
  return returnValue;
}

const ReplyIndicator: React.FC<{ show: boolean, divRef: React.RefObject<HTMLDivElement> }> = ({ show, divRef }) => {
  useEffect(() => {
    const current = divRef.current;
    if (current) {
      if (show) {
        current.style.opacity = '1';
      }
      else {
        current.style.opacity = '0';
      }
    }
  }, [show]);

  return (
    <div className="relative w-0 h-0">
      <div
        className="message-reply-toggle-indicator"
        ref={divRef}
      >
        <ReplyIcon />
      </div>
    </div>
  );
}