// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import './SendStatusNotice.css';
import { convertContentToPlainText } from '../../../common/converters';

type Kind = 'message' | 'comment';
type FailedStatus = 'error-send' | 'error-update';

const EXCERPT_LENGTH = 40;

/** the containers that hold a list of chat items together with its composer */
const LIST_SCOPE_SELECTOR = '.generic-message-list, .comment-list';
const COMPOSER_SELECTOR = '[data-slate-editor="true"]';

const NOTICE_TEXT: Record<Kind, Record<FailedStatus, string>> = {
  message: { 'error-send': 'Message not sent', 'error-update': 'Edit not saved' },
  comment: { 'error-send': 'Comment not posted', 'error-update': 'Edit not saved' },
};

/** short plain-text excerpt of a message body, for accessible names */
export function messageExcerpt(content: Models.Message.Body['content']): string {
  const text = convertContentToPlainText(content).replace(/\s+/g, ' ').trim();
  return text.length > EXCERPT_LENGTH ? `${text.slice(0, EXCERPT_LENGTH - 1)}…` : text;
}

/**
 * The accessible names of the notice's actions. They start with the visible
 * label and name the message, so each failed item's buttons are distinct.
 */
export function sendStatusActionLabels(sendStatus: FailedStatus, excerpt: string) {
  const subject = excerpt ? `“${excerpt}”` : 'message';
  return {
    retry: sendStatus === 'error-send' ? `Retry sending ${subject}` : `Retry saving the edit of ${subject}`,
    discard: sendStatus === 'error-send' ? `Discard ${subject}` : `Undo edit of ${subject}`,
  };
}

/**
 * Discarding removes the item and with it the focused button: move focus to
 * the composer of the same list, or to the list itself when there is none
 * (input hidden, writing not allowed) or on touch devices, where focusing the
 * composer would open the on-screen keyboard.
 */
export function moveFocusAfterDiscard(from: HTMLElement) {
  const ownerDocument = from.ownerDocument;
  if (ownerDocument.activeElement !== from) return; // focus is elsewhere: leave it
  const scope = from.closest<HTMLElement>(LIST_SCOPE_SELECTOR);
  if (!scope) return;
  const coarsePointer = !!ownerDocument.defaultView?.matchMedia?.('(pointer: coarse)').matches;
  const composer = coarsePointer ? null : scope.querySelector<HTMLElement>(COMPOSER_SELECTOR);
  if (composer) {
    composer.focus();
    return;
  }
  if (!scope.hasAttribute('tabindex')) scope.tabIndex = -1;
  scope.focus({ preventScroll: true });
}

/**
 * Outcome of a failed own send or edit (chat-sync `sendStatus`), with the
 * actions the store offers: retry (same id), discard the send / revert the edit.
 *
 * `role="status"` (polite): an item list remounts its items (channel switch,
 * paging), and every remount of a failed item must not interrupt again.
 */
export default function SendStatusNotice(props: {
  messageId: string;
  content: Models.Message.Body['content'];
  sendStatus: FailedStatus;
  kind?: Kind;
  onRetry?: () => void;
  onDiscard?: () => void;
}) {
  const { messageId, content, sendStatus, kind = 'message', onRetry, onDiscard } = props;
  const textId = `${messageId}-send-status`;
  const labels = sendStatusActionLabels(sendStatus, messageExcerpt(content));
  // the message item toggles its tooltip on click (mobile): keep the action's click
  const retry = (event: React.MouseEvent) => {
    event.stopPropagation();
    onRetry?.();
  };
  const discard = (event: React.MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    moveFocusAfterDiscard(event.currentTarget);
    onDiscard?.();
  };
  return (
    <div className="message-send-status" role="status">
      <span id={textId}>{NOTICE_TEXT[kind][sendStatus]}</span>
      {!!onRetry && <button
        type="button"
        className="message-send-status-action"
        aria-label={labels.retry}
        aria-describedby={textId}
        onClick={retry}
      >
        Retry
      </button>}
      {!!onDiscard && <button
        type="button"
        className="message-send-status-action"
        aria-label={labels.discard}
        aria-describedby={textId}
        onClick={discard}
      >
        {sendStatus === 'error-send' ? 'Discard' : 'Undo edit'}
      </button>}
    </div>
  );
}
