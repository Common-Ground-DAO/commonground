// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
  KeyboardCode,
  KeyboardCoordinateGetter,
  KeyboardSensor,
  MouseSensor,
  TouchSensor,
  useSensor,
  useSensors,
} from '@dnd-kit/core';
import { sortableKeyboardCoordinates } from '@dnd-kit/sortable';

/**
 * `sortableKeyboardCoordinates` with the candidate set scoped to droppables of
 * the active drag's `data.type`.
 *
 * The stock getter walks towards the *geometrically* nearest droppable of any
 * kind. On surfaces with more than one droppable type that breaks keyboard
 * drags outright: arrow-down from an area header lands on the area's own
 * channel list (the nearest rect below), the typed collision detection then
 * resolves right back to the same area, and the drop is a no-op.
 * react-beautiful-dnd never had the problem because its keyboard mode moved by
 * list index within the scoped droppable type. Scoping the candidates restores
 * that behavior; on single-type surfaces the filter matches everything
 * (both sides' `type` is undefined) and the getter behaves like the stock one.
 */
export const typedSortableKeyboardCoordinates: KeyboardCoordinateGetter = (event, args) => {
  const containers = args.context.droppableContainers;
  const activeType = args.context.active?.data.current?.type;
  // The getter only calls `getEnabled()` and `get(id)`. A prototype-chained
  // wrapper does not work here — DroppableContainersMap extends Map, whose
  // methods reject a non-Map receiver — so delegate explicitly.
  const scoped = {
    get: (id: Parameters<typeof containers.get>[0]) => containers.get(id),
    getEnabled: () => containers.getEnabled()
      .filter(entry => entry.data.current?.type === activeType),
  } as typeof containers;
  return sortableKeyboardCoordinates(event, {
    ...args,
    context: { ...args.context, droppableContainers: scoped },
  });
};

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
      coordinateGetter: typedSortableKeyboardCoordinates,
      keyboardCodes: {
        start: [KeyboardCode.Space],
        cancel: [KeyboardCode.Esc],
        end: [KeyboardCode.Space],
      },
    }),
  );
}
