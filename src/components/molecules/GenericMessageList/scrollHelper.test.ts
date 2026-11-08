// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import { scrollPositionData } from '../Scrollable/scrollPosition';
import { SCROLL_BOTTOM_THRESHOLD, createScrollHelperControl, showsScrollHelper, type ScrollHelperNode } from './scrollHelper';

/** a helper element as React mounts it: no inline style, i.e. visible */
function freshNode(): ScrollHelperNode {
  return { style: { opacity: '', pointerEvents: '', cursor: '' } };
}

const shown = (node: ScrollHelperNode) => node.style.opacity === '1' && node.style.pointerEvents === 'auto';
const hidden = (node: ScrollHelperNode) => node.style.opacity === '0' && node.style.pointerEvents === 'none';

describe('scroll helper control', () => {
  it('hides a helper that mounts while the list is at the bottom', () => {
    const control = createScrollHelperControl();
    const node = freshNode();
    control.attach(node);
    expect(hidden(node)).toBe(true);
    expect(control.visible).toBe(false);
  });

  it('a re-mounted helper (composer area re-mounted, e.g. after joining) takes the current level', () => {
    const control = createScrollHelperControl();
    const first = freshNode();
    control.attach(first);
    control.set(false);
    // the composer area unmounts and mounts again: React calls the ref with null, then the new node
    control.attach(null);
    const second = freshNode();
    control.attach(second);
    // the list did not report a change in between (it is still at the bottom)
    control.set(false);
    expect(hidden(second)).toBe(true);
  });

  it('a re-mounted helper shows when the list is scrolled up', () => {
    const control = createScrollHelperControl();
    control.attach(freshNode());
    control.set(true);
    control.attach(null);
    const next = freshNode();
    control.attach(next);
    expect(shown(next)).toBe(true);
  });

  it('follows level changes; without a node only the level is kept', () => {
    const control = createScrollHelperControl();
    control.set(true);
    expect(control.visible).toBe(true);
    const node = freshNode();
    control.attach(node);
    expect(shown(node)).toBe(true);
    control.set(false);
    expect(hidden(node)).toBe(true);
    expect(node.style.cursor).toBe('default');
  });
});

describe('position reports and the helper level', () => {
  it('shows only when farther than the threshold from the bottom', () => {
    expect(showsScrollHelper({ scrollTop: 1000, visibleHeight: 700, contentHeight: 1700 })).toBe(false);
    expect(showsScrollHelper({ scrollTop: 975, visibleHeight: 700, contentHeight: 1700 })).toBe(false);
    expect(showsScrollHelper({ scrollTop: 960, visibleHeight: 700, contentHeight: 1700 })).toBe(true);
  });

  it('a short list (not scrollable) is at the bottom', () => {
    const data = scrollPositionData(0, 729, 600, SCROLL_BOTTOM_THRESHOLD);
    expect(data.isBottom).toBe(true);
    expect(showsScrollHelper(data)).toBe(false);
  });

  it('the message list Scrollable and the helper agree on the bottom at every distance', () => {
    for (let distance = 0; distance <= 60; distance++) {
      const data = scrollPositionData(1000 - distance, 700, 1700, SCROLL_BOTTOM_THRESHOLD);
      expect(showsScrollHelper(data)).toBe(!data.isBottom);
    }
  });
});
