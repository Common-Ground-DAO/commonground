// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useEffect, useRef } from "react";

export const useSentinelLoadMore = (sentinelRef: React.RefObject<HTMLDivElement | null>, loadingMore: boolean, loadMore: () => void) => {
  const didFirstLoad = useRef(false);

  if (!didFirstLoad.current && loadingMore) {
    didFirstLoad.current = true;
    loadMore();
  }

  useEffect(() => {
    const sentinel = sentinelRef.current;
    if (!sentinel) return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries[0].isIntersecting && loadingMore) {
          loadMore();
        }
      },
      { threshold: 1.0 }
    );

    if (sentinel) {
      observer.observe(sentinel);
    }

    return () => {
      if (sentinel) {
        observer.unobserve(sentinel);
      }
    };
  }, [loadMore, loadingMore, sentinelRef]);
}