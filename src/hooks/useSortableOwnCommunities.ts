// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import data from 'data';
import { useOwnCommunities, useOwnUser } from 'context/OwnDataProvider';
import { isSameOrder, moveInCommunityOrder } from 'util/communityOrder';

/**
 * The own communities for the drag & drop lists (sidebar `GroupsMenu`, mobile
 * `OwnCommunitiesBrowser`), plus the move they apply on drop.
 *
 * The base list is `useOwnCommunities()` as is — already in `communityOrder`,
 * with communities missing from it appended, so a newly joined community is
 * never hidden. A move is applied locally at once (`pendingOrder`, laid over
 * the base list) and saved after `saveDelayMs` (debounced, so a burst of
 * moves is one request). Previously each list re-sorted itself from the
 * *stored* order whenever `ownCommunities` changed (any community update,
 * e.g. an unread counter), so during the save delay a dropped community
 * snapped back to its old place and jumped again once the save landed.
 *
 * `pendingOrder` is dropped when the stored order equals it, when the save
 * fails, or when the stored order changes to something else while no save is
 * scheduled or in flight (another tab, an out-of-order echo, a reconnect
 * write) — the store wins, the local order can't get stuck.
 */
export function useSortableOwnCommunities(saveDelayMs: number) {
  const ownUser = useOwnUser();
  const ownCommunities = useOwnCommunities();
  const storedOrder = ownUser?.communityOrder;
  const hasOwnUser = !!ownUser;
  const [pendingOrder, setPendingOrder] = useState<string[] | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const savesInFlightRef = useRef(0);

  useEffect(() => {
    if (!pendingOrder || !storedOrder) {
      return;
    }
    if (isSameOrder(storedOrder, pendingOrder)) {
      setPendingOrder(null);
    } else if (!saveTimeoutRef.current && savesInFlightRef.current === 0) {
      setPendingOrder(null);
    }
  }, [storedOrder, pendingOrder]);

  const sortedCommunities = useMemo(() => {
    if (!pendingOrder) {
      return ownCommunities;
    }
    const byId = new Map(ownCommunities.map(community => [community.id, community]));
    const placed = new Set<string>();
    const result: Models.Community.DetailView[] = [];
    for (const id of pendingOrder) {
      const community = byId.get(id);
      if (community && !placed.has(id)) {
        placed.add(id);
        result.push(community);
      }
    }
    for (const community of ownCommunities) {
      if (!placed.has(community.id)) {
        result.push(community);
      }
    }
    return result;
  }, [pendingOrder, ownCommunities]);

  const communityIds = useMemo(() => sortedCommunities.map(community => community.id), [sortedCommunities]);

  const moveCommunity = useCallback((sourceIndex: number, destinationIndex: number) => {
    const nextOrder = moveInCommunityOrder(pendingOrder ?? storedOrder ?? [], communityIds, sourceIndex, destinationIndex);

    if (saveTimeoutRef.current) {
      clearTimeout(saveTimeoutRef.current);
    }
    saveTimeoutRef.current = setTimeout(() => {
      saveTimeoutRef.current = null;
      if (!hasOwnUser) {
        return;
      }
      savesInFlightRef.current += 1;
      data.user.updateOwnData({ communityOrder: nextOrder })
        .catch(error => {
          console.error('Saving the community order failed', error);
          setPendingOrder(current => current === nextOrder ? null : current);
        })
        .finally(() => {
          savesInFlightRef.current -= 1;
        });
    }, saveDelayMs);
    setPendingOrder(nextOrder);
  }, [pendingOrder, storedOrder, communityIds, hasOwnUser, saveDelayMs]);

  return { sortedCommunities, communityIds, moveCommunity };
}
