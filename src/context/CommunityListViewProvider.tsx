// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import data from "data";
import React, { ReactNode, useEffect, useMemo, useRef } from "react";
import { DataState } from "./GenericDataProvider";
import { useLiveQuery } from "dexie-react-hooks";
import uniqueDb from "data/databases/unique";

export const CommunityListViewContext = React.createContext<DataState<Models.Community.ListView>>({
  data: {},
});

const MAX_COMMUNITIES_IN_CACHE = 1_300;
const CLEAR_CACHE_TARGET_COMMUNITIES = 700;
const COMMUNITY_STALE_AFTER = 120_000;

const mountedCommunities = new Map<string, number>();
const updatedTimestamps = new Map<string, number>();
const fetchCalledTimestampMap = new Map<string, number>();

export function CommunityListViewProvider(props: { children: ReactNode }) {
  const allCommunitiesRef = useRef<Models.Community.ListView[] | undefined>(undefined);
  const ownCommunityIdsRef = useRef<Set<string> | undefined>(undefined);

  useEffect(() => {
    uniqueDb.uniques.get("CommunityListViewUpdateTimestamps").then((result) => {
      if (!!result && result.key === "CommunityListViewUpdateTimestamps") {
        for (const id of Object.keys(result.data)) {
          updatedTimestamps.set(id, Math.max(updatedTimestamps.get(id) || 0, result.data[id]));
        }
      }
    });
  }, []);

  const listViewUpdateTimestamps = useLiveQuery(async () => {
    const resultObject = (await uniqueDb.uniques.get("CommunityListViewUpdateTimestamps")) as Unique.CommunityListViewUpdateTimestamps | undefined;
    const result = resultObject?.data || {};
    for (const id of Object.keys(result)) {
      updatedTimestamps.set(id, result[id]);
    }
    return result;
  });

  useLiveQuery(() => {
    return uniqueDb.uniques.get("OwnCommunityIds").then((result) => {
      if (!!result && result.key === "OwnCommunityIds") {
        ownCommunityIdsRef.current = new Set(result.ids);
      }
    });
  });

  const allCommunities = useLiveQuery(() => {
    return data.community.getAllCommunityListViews().then(communities => {
      allCommunitiesRef.current = communities;
      return communities;
    });
  });

  useEffect(() => {
    const interval = setInterval(() => {
      const _allCommunities = allCommunitiesRef.current;
      if (!!_allCommunities) {
        const allCommunities = [..._allCommunities];
        allCommunities.sort((a, b) => {
          return (updatedTimestamps.get(b.id) || 0) - (updatedTimestamps.get(a.id) || 0);
        });

        const communityIdsToPurge: string[] = [];
        const totalCommunityCount = allCommunities.length;
        if (totalCommunityCount > MAX_COMMUNITIES_IN_CACHE) {
          let deleteTarget = Math.max(totalCommunityCount - CLEAR_CACHE_TARGET_COMMUNITIES, 0);
          let i = totalCommunityCount - 1;
          while (i >= 0 && deleteTarget > 0) {
            const community = allCommunities[i];
            const mounted = mountedCommunities.get(community.id) || 0;
            if (mounted === 0 && !(ownCommunityIdsRef.current?.has(community.id))) {
              communityIdsToPurge.push(community.id);
              allCommunities.splice(i, 1);
              deleteTarget--;
            }
            i--;
          }
        }
        if (communityIdsToPurge.length > 0) {
          data.community.bulkDeleteCommunityListViews(communityIdsToPurge);
        }
        uniqueDb.uniques.put({
          key: "CommunityListViewUpdateTimestamps",
          data: allCommunities.reduce<{ [id: string]: number }>((acc, community) => {
            acc[community.id] = updatedTimestamps.get(community.id) || 0;
            return acc;
          }, {}),
        });
      }
    }, 60_000);
    return () => clearInterval(interval);
  }, []);

  const value = useMemo(() => {
    const value: DataState<Models.Community.ListView> = { data: {} };
    if (!!allCommunities) {
      for (const community of allCommunities) {
        value.data[community.id] = community;
      }
    }
    return value;

  }, [allCommunities]);

  return (
    <CommunityListViewContext.Provider value={value}>
      {props.children}
    </CommunityListViewContext.Provider>
  );
}

function communitiesMounted(communityIds: string[]) {
  const updateIds: string[] = [];
  for (const communityId of communityIds) {
    const count = mountedCommunities.get(communityId) || 0;
    if (count === 0) {
      // community mounted
    }
    const updatedTime = updatedTimestamps.get(communityId) || 0;
    if (Date.now() - updatedTime > COMMUNITY_STALE_AFTER) {
      updateIds.push(communityId);
      updatedTimestamps.set(communityId, Date.now());
    };
    mountedCommunities.set(communityId, count + 1);
  }
  if (updateIds.length > 0) {
    data.community.fetchOrUpdateCommunityListViews(updateIds);
  }
}

function communitiesUnmounted(communityIds: string[]) {
  for (const communityId of communityIds) {
    const count = mountedCommunities.get(communityId) || 1;
    if (count <= 1) {
      // community unmounted
      mountedCommunities.delete(communityId);
    }
    else {
      mountedCommunities.set(communityId, count - 1);
    }
  }
}

export function useCommunityListView(communityId: string | undefined) {
  const context = React.useContext(CommunityListViewContext);

  useEffect(() => {
    if (!!communityId) {
      communitiesMounted([communityId]);
      return () => {
        communitiesUnmounted([communityId]);
      }
    }
  }, [communityId]);

  if (!communityId) {
    return undefined;
  }

  const result = context.data[communityId] as Models.Community.ListView | undefined;
  const timestamp = Math.max(updatedTimestamps.get(communityId) || 0, fetchCalledTimestampMap.get(communityId) || 0);
  if (!result || (timestamp !== 0 && Date.now() - timestamp > COMMUNITY_STALE_AFTER)) {
    fetchCalledTimestampMap.set(communityId, Date.now());
    data.community.fetchOrUpdateCommunityListViews([communityId]);
  }

  return result;
}

export function useMultipleCommunityListViews(communityIds: string[]) {
  const context = React.useContext(CommunityListViewContext);
  const ids = communityIds?.filter(id => !!id) || [];

  useEffect(() => {
    if (ids.length > 0) {
      communitiesMounted(ids);
      return () => {
        communitiesUnmounted(ids);
      }
    }
  }, [ids]);

  const missingIds = ids.filter(id => !context.data[id]);
  if (missingIds.length > 0) {
    for (const id of missingIds) {
      fetchCalledTimestampMap.set(id, Date.now());
    }
    data.community.fetchOrUpdateCommunityListViews(missingIds);
  }

  const result: { [id: string]: Models.Community.ListView } = {};
  for (const id of ids) {
    if (!!context.data[id]) {
      result[id] = context.data[id];
      const timestamp = Math.max(updatedTimestamps.get(id) || 0, fetchCalledTimestampMap.get(id) || 0);
      if (timestamp !== 0 && Date.now() - timestamp > COMMUNITY_STALE_AFTER) {
        fetchCalledTimestampMap.set(id, Date.now());
        data.community.fetchOrUpdateCommunityListViews([id]);
      }
    }
  }
  return result;
}