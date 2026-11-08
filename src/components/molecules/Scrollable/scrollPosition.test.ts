// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import { shouldStickToBottom, type StickToBottomInput } from './scrollPosition';

const base: StickToBottomInput = {
  autoScroll: true,
  executeAutoScroll: false,
  sizeChanged: false,
  wasAtBottom: true,
  scrolledUp: false,
};
const stick = (overrides: Partial<StickToBottomInput>) => shouldStickToBottom({ ...base, ...overrides });

describe('shouldStickToBottom', () => {
  it('a size change keeps a list at the bottom, whichever event runs the pass', () => {
    // e.g. a mouse pass after the window shrank, before the ResizeObserver callback
    expect(stick({ sizeChanged: true })).toBe(true);
  });

  it('a mutation or resize request keeps the bottom', () => {
    expect(stick({ executeAutoScroll: true })).toBe(true);
  });

  it('nothing to do without a change or request', () => {
    expect(stick({})).toBe(false);
  });

  it('a list that was not at the bottom is never moved', () => {
    expect(stick({ wasAtBottom: false, sizeChanged: true })).toBe(false);
    expect(stick({ wasAtBottom: false, executeAutoScroll: true })).toBe(false);
  });

  it('a scroll up in the same pass wins over growing content (image, embed)', () => {
    expect(stick({ sizeChanged: true, scrolledUp: true })).toBe(false);
    expect(stick({ executeAutoScroll: true, scrolledUp: true })).toBe(false);
  });

  it('a size change alone does not stick without autoScroll', () => {
    expect(stick({ autoScroll: false, sizeChanged: true })).toBe(false);
  });
});
