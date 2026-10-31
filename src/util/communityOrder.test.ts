// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, it, expect } from 'vitest';
import { isSameOrder, moveInCommunityOrder } from './communityOrder';

describe('moveInCommunityOrder', () => {
  it('moves within a clean order like a plain array move', () => {
    const order = ['a', 'b', 'c', 'd'];
    expect(moveInCommunityOrder(order, order, 0, 2)).toEqual(['b', 'c', 'a', 'd']);
    expect(moveInCommunityOrder(order, order, 3, 0)).toEqual(['d', 'a', 'b', 'c']);
  });

  it('lands at the visible drop position when unrendered ids sit in front of it', () => {
    // 'x' is in the stored order but not rendered (left/deleted community).
    const order = ['a', 'x', 'b', 'c'];
    const visible = ['a', 'b', 'c'];
    // Drag 'a' below 'c'. The old splice on `communityOrder` with list
    // indices produced ['x', 'b', 'a', 'c'] — rendered as b, a, c.
    const result = moveInCommunityOrder(order, visible, 0, 2);
    expect(result.filter(id => visible.includes(id))).toEqual(['b', 'c', 'a']);
    expect(result).toHaveLength(order.length);
    expect(result).toContain('x');
  });

  it('keeps unrendered ids in their slots', () => {
    expect(moveInCommunityOrder(['x', 'a', 'b', 'y'], ['a', 'b'], 1, 0)).toEqual(['x', 'b', 'a', 'y']);
  });

  it('appends visible ids that are missing from the stored order', () => {
    expect(moveInCommunityOrder(['a'], ['a', 'n'], 1, 0)).toEqual(['n', 'a']);
  });

  it('returns an unchanged copy for out-of-range indices', () => {
    const order = ['a', 'b'];
    const result = moveInCommunityOrder(order, order, 0, 5);
    expect(result).toEqual(order);
    expect(result).not.toBe(order);
  });
});

describe('isSameOrder', () => {
  it('compares element-wise', () => {
    expect(isSameOrder(['a', 'b'], ['a', 'b'])).toBe(true);
    expect(isSameOrder(['a', 'b'], ['b', 'a'])).toBe(false);
    expect(isSameOrder(['a'], ['a', 'b'])).toBe(false);
  });
});
