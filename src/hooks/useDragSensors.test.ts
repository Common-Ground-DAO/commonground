// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The click that trails a pointer drop must not follow a link.
 *
 * Models the event path of a mouse drop on a draggable `<a href>` (the
 * sidebar's community NavLinks). dnd-kit's own guard — a document capture
 * listener that only calls `stopPropagation()` (@dnd-kit/core 6.3.1,
 * `AbstractPointerSensor.handleStart`) — keeps the click away from React, and
 * with it from React Router, whose handler is what normally
 * `preventDefault()`s a link click. So without `suppressClickAfterDrag` the
 * click arrives at the browser's default action un-prevented: the browser
 * follows the href natively, i.e. a full page load.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CLICK_AFTER_DRAG_WINDOW_MS, suppressClickAfterDrag } from './useDragSensors';

type ClickOutcome = {
  /** Default action cancelled before React saw the click (i.e. by the helper). */
  preventedBeforeReact: boolean;
  /** Whether the click got past the document to React / React Router. */
  reachedReact: boolean;
  /** Whether the browser's default action (following the href) is cancelled. */
  defaultPrevented: boolean;
};

/**
 * A click's capture path: window, then document, then "below" (React's root
 * listener, where React Router's NavLink handler prevents the default and
 * navigates client-side). Node's EventTarget has no tree, so the hops are
 * walked by hand and stop when a listener stopped propagation.
 */
function makeClickPath(options: { dndKitGuard: boolean }) {
  const win = new EventTarget();
  const doc = new EventTarget();
  if (options.dndKitGuard) {
    doc.addEventListener('click', event => event.stopPropagation(), { capture: true });
  }

  const click = (): ClickOutcome => {
    const event = new Event('click', { cancelable: true });
    let stopped = false;
    const stop = event.stopPropagation.bind(event);
    event.stopPropagation = () => { stopped = true; stop(); };

    for (const target of [win, doc]) {
      target.dispatchEvent(event);
      if (stopped) {
        return { preventedBeforeReact: event.defaultPrevented, reachedReact: false, defaultPrevented: event.defaultPrevented };
      }
    }
    const preventedBeforeReact = event.defaultPrevented;
    event.preventDefault();
    return { preventedBeforeReact, reachedReact: true, defaultPrevented: event.defaultPrevented };
  };
  return { win, click };
}

describe('suppressClickAfterDrag', () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a plain click reaches React Router, which prevents the native navigation', () => {
    const { click } = makeClickPath({ dndKitGuard: false });
    expect(click()).toEqual({ preventedBeforeReact: false, reachedReact: true, defaultPrevented: true });
  });

  it('after a drop, dnd-kit alone swallows the click but leaves its default action — the reload', () => {
    const { click } = makeClickPath({ dndKitGuard: true });
    expect(click()).toEqual({ preventedBeforeReact: false, reachedReact: false, defaultPrevented: false });
  });

  it('cancels the default action of the click right after a mouse drop', () => {
    const { win, click } = makeClickPath({ dndKitGuard: true });
    suppressClickAfterDrag(new Event('mousedown'), win);
    expect(click()).toEqual({ preventedBeforeReact: true, reachedReact: false, defaultPrevented: true });
  });

  it('only prevents the default — swallowing the click stays dnd-kit\'s job', () => {
    const { win, click } = makeClickPath({ dndKitGuard: false });
    suppressClickAfterDrag(new Event('mousedown'), win);
    expect(click()).toMatchObject({ preventedBeforeReact: true, reachedReact: true });
  });

  it('cancels only one click', () => {
    const { win, click } = makeClickPath({ dndKitGuard: false });
    suppressClickAfterDrag(new Event('mousedown'), win);
    expect(click().preventedBeforeReact).toBe(true);
    expect(click().preventedBeforeReact).toBe(false);
  });

  it("expires with dnd-kit's own guard window, so later clicks behave normally", () => {
    const { win, click } = makeClickPath({ dndKitGuard: false });
    suppressClickAfterDrag(new Event('touchstart'), win);
    vi.advanceTimersByTime(CLICK_AFTER_DRAG_WINDOW_MS + 1);
    expect(click().preventedBeforeReact).toBe(false);
  });

  it('leaves keyboard drags alone (Space produces no trailing click)', () => {
    const { win, click } = makeClickPath({ dndKitGuard: false });
    suppressClickAfterDrag(new Event('keydown'), win);
    expect(click().preventedBeforeReact).toBe(false);
  });
});
