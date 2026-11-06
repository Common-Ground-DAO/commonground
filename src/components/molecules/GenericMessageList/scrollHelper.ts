// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * Visibility of the message list's "scroll down" helper (`.scroll-helper`).
 *
 * The helper is shown and hidden through inline styles (no React render per
 * scroll position). It lives in the composer area, which mounts and unmounts
 * independently of the list: joining the community swaps the join button for
 * the composer, a call page hides and shows its input. A freshly mounted
 * helper has no inline style, i.e. it is visible. So the level is kept here
 * and applied to every node that attaches (`attach` is the element's
 * callback ref), not only when the level changes.
 */

import type { PositionData } from '../Scrollable/scrollPosition';

/** distance from the bottom (px) up to which the list counts as scrolled to the bottom */
export const SCROLL_BOTTOM_THRESHOLD = 30;

/**
 * The helper shows while the list is not scrolled to the bottom; the same
 * level, negated, is the list's at-bottom level for read marking.
 */
export function showsScrollHelper(data: Pick<PositionData, 'scrollTop' | 'visibleHeight' | 'contentHeight'>): boolean {
  return data.scrollTop + data.visibleHeight < data.contentHeight - SCROLL_BOTTOM_THRESHOLD;
}

export type ScrollHelperNode = {
  style: Pick<CSSStyleDeclaration, 'opacity' | 'pointerEvents' | 'cursor'>;
};

export type ScrollHelperControl = {
  /** callback ref of the helper element; applies the current level to a new node */
  attach: (node: ScrollHelperNode | null) => void;
  /** show or hide the helper */
  set: (visible: boolean) => void;
  /** the current level */
  readonly visible: boolean;
};

export function createScrollHelperControl(): ScrollHelperControl {
  let visible = false;
  let node: ScrollHelperNode | null = null;

  const apply = () => {
    if (!node) return;
    node.style.opacity = visible ? '1' : '0';
    node.style.pointerEvents = visible ? 'auto' : 'none';
    node.style.cursor = visible ? 'pointer' : 'default';
  };

  return {
    attach(next) {
      node = next;
      apply();
    },
    set(next) {
      if (next === visible) return;
      visible = next;
      apply();
    },
    get visible() {
      return visible;
    },
  };
}
