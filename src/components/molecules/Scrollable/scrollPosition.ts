// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/** what `Scrollable` reports to its `positionCallback` */
export type PositionData = {
  /** the content's real (browser-clamped) scroll position */
  scrollTop: number;
  visibleHeight: number;
  contentHeight: number;
  isTop: boolean;
  isBottom: boolean;
};

/**
 * Position report of a `Scrollable`. `scrollTop` must be the content's real
 * `scrollTop` read after any scroll was applied, never a computed target:
 * the browser clamps a target outside `[0, scrollHeight - clientHeight]`.
 */
export function scrollPositionData(scrollTop: number, visibleHeight: number, contentHeight: number, threshold: number): PositionData {
  return {
    scrollTop,
    visibleHeight,
    contentHeight,
    isTop: scrollTop < threshold,
    // the exact complement of the message list's "scroll down" helper rule
    isBottom: scrollTop + visibleHeight >= contentHeight - threshold,
  };
}

export type StickToBottomInput = {
  /** the Scrollable keeps a list at the bottom (`autoScroll` prop) */
  autoScroll: boolean;
  /** a mutation, or a resize while at the bottom, asked for the bottom since the last pass */
  executeAutoScroll: boolean;
  /** content or viewport height differs from the last pass */
  sizeChanged: boolean;
  /** the list was at the bottom at the last pass */
  wasAtBottom: boolean;
  /** a scroll event moved the content up since the last pass (the user leaves the bottom) */
  scrolledUp: boolean;
};

/**
 * Whether a pass of `Scrollable` scrolls to the bottom (no lock, no grab).
 * A size change keeps a list at the bottom whichever event runs the pass: a
 * pass for a mouse or scroll event can run after the layout change but before
 * the ResizeObserver callback, which would then no longer find the list at
 * the bottom. A scroll up in the same pass wins: the user's first wheel or
 * drag step while an image or embed grows the content is not undone.
 */
export function shouldStickToBottom(input: StickToBottomInput): boolean {
  const { autoScroll, executeAutoScroll, sizeChanged, wasAtBottom, scrolledUp } = input;
  if (!wasAtBottom || scrolledUp) return false;
  return executeAutoScroll || (autoScroll && sizeChanged);
}
