// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Scroll anchoring of a message window (chat-sync). The window listener gets
 * `(state, change)` synchronously; the list decides here what the Scrollable
 * has to do and sets its lock BEFORE the new items are rendered. Pure, so it
 * is unit-tested without a DOM.
 *
 * Scrollable applies a lock on the next DOM mutation of its content. A lock
 * whose change renders no different items would wait for an unrelated later
 * mutation (and block scrolling meanwhile), so a change that keeps the item
 * sequence never sets a lock; a reset with an intent then acts at once.
 */

import type { WindowChange } from 'data/chat/types';
import type { ScrollLockOptions } from '../Scrollable/Scrollable';

/** CSS class of the element that carries `data-timestamp` on every list item */
export const MESSAGE_TIMESTAMP_CLASS = 'message-item-content';

/** What the list asked for when it started an init / jump / jumpToLatest. */
export type ResetIntent =
  | { type: 'bottom' }
  | { type: 'element'; elementId: string };

export type ScrollAction =
  | { type: 'none' }
  | { type: 'lock'; lock: ScrollLockOptions }
  | { type: 'scrollToBottom' }
  | { type: 'scrollToElement'; elementId: string };

export type ScrollActionInput = {
  change: WindowChange;
  prevItems: readonly Models.ItemList.Item[];
  nextItems: readonly Models.ItemList.Item[];
  /** pending intent of the list (consumed by resets of cause init/jump/latest) */
  intent: ResetIntent | null;
  /** the list is scrolled to the bottom right now */
  atBottom: boolean;
  /** `withEndOfList` of the previous state */
  wasAtLatest: boolean;
};

const BY_DATE: ScrollLockOptions = {
  type: 'lockByVisibleItemDate',
  elementClassWithTimestamp: MESSAGE_TIMESTAMP_CLASS,
  dateOrder: 'ASC',
};
const TO_BOTTOM: ScrollLockOptions = { type: 'scrollToBottom' };

export function sameItemSequence(a: readonly Models.ItemList.Item[], b: readonly Models.ItemList.Item[]): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i].id !== b[i].id) return false;
  }
  return true;
}

/** a reset of this cause answers the list's own init / jump / jumpToLatest */
export function consumesIntent(change: WindowChange): boolean {
  return change.kind === 'reset' && change.cause !== 'resync';
}

function intentLock(intent: ResetIntent): ScrollLockOptions {
  return intent.type === 'bottom' ? TO_BOTTOM : { type: 'scrollToElementId', elementId: intent.elementId };
}

function intentNow(intent: ResetIntent): ScrollAction {
  return intent.type === 'bottom' ? { type: 'scrollToBottom' } : { type: 'scrollToElement', elementId: intent.elementId };
}

export function scrollActionForChange(input: ScrollActionInput): ScrollAction {
  const { change, prevItems, nextItems, atBottom, wasAtLatest } = input;
  const intent = consumesIntent(change) ? input.intent : null;
  const itemsChange = !sameItemSequence(prevItems, nextItems);

  if (!itemsChange) {
    return intent ? intentNow(intent) : { type: 'none' };
  }

  switch (change.kind) {
    case 'reset': {
      if (intent) return { type: 'lock', lock: intentLock(intent) };
      if (change.cause === 'init' || change.cause === 'latest') return { type: 'lock', lock: TO_BOTTOM };
      if (change.cause === 'resync' && wasAtLatest && atBottom) return { type: 'lock', lock: TO_BOTTOM };
      // 'jump' without intent, 'resync' while reading older messages: keep the reading position
      return { type: 'lock', lock: BY_DATE };
    }
    case 'prepend':
    case 'append-page':
      return change.count > 0 ? { type: 'lock', lock: BY_DATE } : { type: 'none' };
    case 'append-live':
      // own send: always show it; others: stick to the bottom only when there
      // (scrolled up: appending below the viewport does not move it)
      return change.own || atBottom ? { type: 'lock', lock: TO_BOTTOM } : { type: 'none' };
    case 'trim':
      // items removed above the viewport shift it; removed below do not
      return change.from === 'start' && change.count > 0 ? { type: 'lock', lock: BY_DATE } : { type: 'none' };
    case 'update':
      // an item removed in place (delete): keep the reading position; at the
      // bottom the Scrollable's autoScroll keeps it there
      return atBottom ? { type: 'none' } : { type: 'lock', lock: BY_DATE };
  }
}

function scrollsToBottom(action: ScrollAction): boolean {
  return action.type === 'scrollToBottom' || (action.type === 'lock' && action.lock.type === 'scrollToBottom');
}

/**
 * Whether the list has to stop reporting "at the bottom" for this change
 * until the Scrollable reports its position again (after the render).
 *
 * A page appended below (`append-page`, also the one that re-attaches the
 * window to the latest messages) or a reset that does not scroll to the
 * bottom (keeps the reading position by date, or goes to an element) can add
 * items at or below the end while the viewport stays where it was. Reporting
 * the old `atBottom` together with the new state would mark items read the
 * user has not seen; the next position report restores the real level.
 */
export function leavesBottom(change: WindowChange, action: ScrollAction): boolean {
  if (action.type === 'none' || scrollsToBottom(action)) return false;
  return change.kind === 'append-page' || change.kind === 'reset';
}
