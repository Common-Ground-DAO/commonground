// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

export function isSameOrder(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Applies a drag & drop move in the *rendered* community list to the stored
 * `communityOrder`.
 *
 * The drop indices are positions in `visibleIds` — the communities actually
 * rendered — but `communityOrder` can hold ids that are not rendered: leaving
 * a community removes its id server-side (`array_remove`), but the client
 * receives the order and the own-community list through separate updates, and
 * a deleted community can linger in the order (`OwnDataProvider` warns about
 * such ids). It can also lack rendered ids (`OwnDataProvider` appends own
 * communities missing from it). Splicing `communityOrder` with list indices
 * therefore put the dropped community at the wrong place whenever such an id
 * sat in front of the target. Instead, the move is done on the visible list,
 * and the visible slots of `communityOrder` are refilled in the new order;
 * ids that are not rendered keep their slots, visible ids missing from
 * `communityOrder` are appended.
 */
export function moveInCommunityOrder(
  communityOrder: readonly string[],
  visibleIds: readonly string[],
  sourceIndex: number,
  destinationIndex: number,
): string[] {
  if (
    sourceIndex < 0 || sourceIndex >= visibleIds.length ||
    destinationIndex < 0 || destinationIndex >= visibleIds.length
  ) {
    return [...communityOrder];
  }
  const reordered = [...visibleIds];
  const [moved] = reordered.splice(sourceIndex, 1);
  reordered.splice(destinationIndex, 0, moved);

  const visible = new Set(visibleIds);
  let next = 0;
  const result = communityOrder.map(id => (visible.has(id) && next < reordered.length) ? reordered[next++] : id);
  return [...result, ...reordered.slice(next)];
}
