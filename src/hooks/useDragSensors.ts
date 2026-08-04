// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
  KeyboardCode,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

/**
 * The sensor set every drag & drop surface in the app shares.
 *
 * The constants reproduce `react-beautiful-dnd`'s defaults, which is what all
 * of these lists were built against (rbd was replaced in the React-19
 * dependency wave; it is deprecated and has no React 19 support):
 *
 *  - **Mouse: a 5px drag threshold** (rbd's `sloppyClickThreshold`). Every one
 *    of our draggables is also clickable — a community icon is a link, an area
 *    header toggles its channel list, a channel row opens its settings — so the
 *    pointer has to travel before a press counts as a lift. Below the threshold
 *    the click goes through untouched; above it, dnd-kit swallows the trailing
 *    `click` on the document for 50ms after the drop, exactly as rbd did.
 *  - **Touch: a 120ms long press with a 5px tolerance** (rbd's
 *    `timeForLongPress`). This is load-bearing on mobile: `MouseSensor` +
 *    `TouchSensor` instead of the unified `PointerSensor` is what keeps a
 *    finger swipe scrolling the sidebar instead of lifting a community.
 *  - **Keyboard: Space to lift, arrows to move, Space to drop, Escape to
 *    cancel** — rbd's key map (dnd-kit's default would also lift on Enter,
 *    which rbd never did and which would collide with activating the link
 *    inside a draggable).
 */
export function useDragSensors() {
  return useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 5 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 120, tolerance: 5 } }),
    useSensor(KeyboardSensor, {
      coordinateGetter: sortableKeyboardCoordinates,
      keyboardCodes: {
        start: [KeyboardCode.Space],
        cancel: [KeyboardCode.Esc],
        end: [KeyboardCode.Space],
      },
    }),
  );
}
