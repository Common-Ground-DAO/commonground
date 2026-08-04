// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
  Announcements,
  CollisionDetection,
  closestCorners,
  KeyboardCode,
  KeyboardCoordinateGetter,
  KeyboardSensor,
  MouseSensor,
  pointerWithin,
  rectIntersection,
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
  // methods reject a non-Map receiver — so delegate explicitly. The two-method
  // shape is an internal contract of @dnd-kit/sortable (verified against
  // 10.0.0); if a future bump starts calling anything else, the catch below
  // degrades to the stock getter instead of breaking keyboard drags.
  const scoped = {
    get: (id: Parameters<typeof containers.get>[0]) => containers.get(id),
    getEnabled: () => containers.getEnabled()
      .filter(entry => entry.data.current?.type === activeType),
  } as typeof containers;
  try {
    return sortableKeyboardCoordinates(event, {
      ...args,
      context: { ...args.context, droppableContainers: scoped },
    });
  } catch {
    return sortableKeyboardCoordinates(event, args);
  }
};

/**
 * Collision detection for a single flat sortable list, shaped after
 * react-beautiful-dnd's hit testing:
 *
 * - pointer inside a row wins outright;
 * - otherwise the *dragged row's rect* is intersected with the rows, which is
 *   what covers the flex gaps between rows — rbd hit-tested the dragged item's
 *   rect, so it had no dead zones there;
 * - a pointer drop with no intersection at all (dragged well away from the
 *   list) resolves to nothing, which is rbd's `destination: null` — a cancel,
 *   not a snap to the nearest row (`closestCenter` would never return empty);
 * - keyboard drags have no pointer position; their virtual rect was aligned to
 *   a target by the coordinate getter, and `closestCorners` — the getter's own
 *   ranking metric — re-identifies it.
 */
export const listCollisionDetection: CollisionDetection = (args) => {
  if (!args.pointerCoordinates) {
    return closestCorners(args);
  }
  const pointerHit = pointerWithin(args);
  if (pointerHit.length > 0) {
    return pointerHit;
  }
  return rectIntersection(args);
};

/**
 * Positional screen-reader announcements, replacing dnd-kit's defaults —
 * which read out raw droppable ids (UUIDs here) and would have made keyboard
 * dragging unusable non-visually. react-beautiful-dnd announced positions
 * ("You have moved the item to position 4 of 6"); this restores that. Every
 * `useSortable`/`useDroppable` on a drag surface passes `data.label` so the
 * announcements can name the thing being moved instead of its id.
 */
export const dragAnnouncements: Announcements = {
  onDragStart({ active }) {
    const label = active.data.current?.label ?? 'item';
    const sortable = active.data.current?.sortable;
    return sortable
      ? `Picked up ${label}, position ${sortable.index + 1} of ${sortable.items.length}.`
      : `Picked up ${label}.`;
  },
  onDragOver({ active, over }) {
    const label = active.data.current?.label ?? 'item';
    if (!over) {
      return `${label} is no longer over a drop target.`;
    }
    const sortable = over.data.current?.sortable;
    if (sortable) {
      return `${label} was moved to position ${sortable.index + 1} of ${sortable.items.length}.`;
    }
    return `${label} was moved into ${over.data.current?.label ?? 'another list'}.`;
  },
  onDragEnd({ active, over }) {
    const label = active.data.current?.label ?? 'item';
    if (!over) {
      return `${label} was dropped without a target and returned to its position.`;
    }
    const sortable = over.data.current?.sortable;
    if (sortable) {
      return `${label} was dropped at position ${sortable.index + 1} of ${sortable.items.length}.`;
    }
    return `${label} was dropped into ${over.data.current?.label ?? 'another list'}.`;
  },
  onDragCancel({ active }) {
    const label = active.data.current?.label ?? 'item';
    return `Dragging was cancelled. ${label} returned to its position.`;
  },
};

// Hoisted so `useSensor`'s identity-based memoization holds — fresh option
// literals per render would produce a new sensors array (and with it new
// synthetic `listeners` objects) every render, defeating the `useMemo`/
// `React.memo` layers of the components that spread them.
const MOUSE_OPTIONS = { activationConstraint: { distance: 5 } };
const TOUCH_OPTIONS = { activationConstraint: { delay: 120, tolerance: 5 } };
const KEYBOARD_OPTIONS = {
  coordinateGetter: typedSortableKeyboardCoordinates,
  keyboardCodes: {
    start: [KeyboardCode.Space],
    cancel: [KeyboardCode.Esc],
    end: [KeyboardCode.Space],
  },
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
    useSensor(MouseSensor, MOUSE_OPTIONS),
    useSensor(TouchSensor, TOUCH_OPTIONS),
    useSensor(KeyboardSensor, KEYBOARD_OPTIONS),
  );
}
