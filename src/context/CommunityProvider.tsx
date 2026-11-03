// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useLiveQuery } from 'dexie-react-hooks';
import data from "data";
import { PredefinedRole } from "common/enums";
import { parseIdOrUrl } from "../util";
import contractApi from "data/api/contract";
import uniqueDb from "data/databases/unique";
import { useOwnCommunities } from "./OwnDataProvider";
import { isPredefinedRole } from "util/predefinedRoles";

type CommunityState = {
  state: 'loaded';
  setCommunityIdOrUrl: (idOrUrl: string | undefined) => void;
  setCommunityId: (id: string | undefined) => void;
  community: Models.Community.DetailView;

  areas: Models.Community.Area[];
  areasById: Map<string, Models.Community.Area>;
  channels: Models.Community.Channel[];
  channelsById: Map<string, Models.Community.Channel>;
  calls: Models.Calls.Call[];
  roles: Models.Community.Role[];
  rolesById: Map<string, Models.Community.Role>;
  ownRoles: Models.Community.Role[];
  ownRolesById: Map<string, Models.Community.Role>;

  communityPermissions: Set<Common.CommunityPermission>;
  channelPermissionsById: Map<string, Set<Common.ChannelPermission>>;
} | {
  state: "loading";
  communityId?: string;
  communityUrl?: string;
  setCommunityIdOrUrl: (idOrUrl: string | undefined) => void;
  setCommunityId: (id: string | undefined) => void;
} | {
  state: "no-community";
  setCommunityIdOrUrl: (idOrUrl: string | undefined) => void;
  setCommunityId: (id: string | undefined) => void;
};

export const CommunityContext = React.createContext<CommunityState>({
  state: "no-community",
  setCommunityIdOrUrl: () => undefined,
  setCommunityId: () => undefined,
});

const STALE_AFTER = 120_000;

// Todo (low prio): The state + state updates can still be improved
export function CommunityProvider(props: React.PropsWithChildren) {
  const [__idOrUrl, __setIdOrUrl] = useState<string | undefined>();
  const [ allLoaded, setAllLoaded ] = useState<boolean>(false);
  const [ communityId, setCommunityId ] = useState<string | undefined>();
  const [ communityUrl, setCommunityUrl ] = useState<string | undefined>();
  const communities = useOwnCommunities();
  const fetchCalledTimestampMap = useRef(new Map<string, number>());
  const idOrUrlRef = useRef<string | undefined>(__idOrUrl);
  // Todo: data.community needs to return something like a 404
  // if a community does not exist

  const updateTimestamps = useLiveQuery(async () => {
    const object = (await uniqueDb.uniques.get("CommunityDetailViewUpdateTimestamps")) as Unique.CommunityDetailViewUpdateTimestamps | undefined;
    return object?.data || {};
  }, []);

  useEffect(() => {
    if (
      !!communityId &&
      !communities.some(c => c.id === communityId) &&
      !!updateTimestamps
    ) {
      const now = Date.now();
      const fetchCalledTimestamp = fetchCalledTimestampMap.current.get(communityId) || 0;
      const updateTimestamp = Math.max(updateTimestamps[communityId] || 0, fetchCalledTimestamp);
      if (updateTimestamp > 0) {
        if (updateTimestamp + STALE_AFTER < now) {
          fetchCalledTimestampMap.current.set(communityId, now);
          data.community.fetchOrUpdateCommunityDetailViews([communityId]);
        }
        else {
          const timeout = setTimeout(() => {
            fetchCalledTimestampMap.current.set(communityId, now);
            data.community.fetchOrUpdateCommunityDetailViews([communityId]);
          }, updateTimestamp + STALE_AFTER - now);
          return () => clearTimeout(timeout);
        }
      }
    }
  }, [updateTimestamps, communityId, communities]);

  const setIdOrUrl = useCallback((value: string | undefined) => {
    if (idOrUrlRef.current !== value) {
      idOrUrlRef.current = value;
      __setIdOrUrl(value);
    }
  }, []);

  const setId = useCallback((value: string | undefined) => {
    setCommunityId(value);
    setCommunityUrl(undefined);
  }, []);

  useEffect(() => {
    if (!__idOrUrl) {
      setCommunityUrl(undefined);
      setCommunityId(undefined);
      return undefined;
    }

    const result = parseIdOrUrl(__idOrUrl);
    if (!!result.uuid && result.uuid !== communityId) {
      setCommunityUrl(undefined);
      setCommunityId(result.uuid);
    }
    else if (!!result.url && result.url !== communityUrl) {
      setCommunityUrl(result.url);
      setCommunityId(undefined);
    }
  }, [__idOrUrl, communityId, communityUrl]);

  const communityById = useLiveQuery(async () => {
    if (!!communityId) {
      return data.community.getCommunityDetailView(communityId);
    }
  }, [communityId]);

  const communityByUrl = useLiveQuery(async () => {
    if (!!communityUrl) {
      const detailView = await data.community.getCommunityByUrl(communityUrl);
      if (!!detailView && communityId !== detailView.id) {
        setCommunityId(detailView.id);
      }
      return detailView;
    }
  }, [communityUrl]);

  const community = useLiveQuery(async () => {
    return communityByUrl || communityById;
  }, [communityById, communityByUrl]);

  const __channels = useLiveQuery(() => {
    if (!!communityId) {
      return data.community.getChannels(communityId);
    }
  }, [communityId]);

  const __areas = useLiveQuery(() => {
    if (!!communityId) {
      return data.community.getAreas(communityId);
    }
  }, [communityId]);

  const __roles = useLiveQuery(() => {
    if (!!communityId) {
      return data.community.getRoles(communityId);
    }
  }, [communityId]);

  const __calls = useLiveQuery(() => {
    if (!!communityId) {
      return data.community.getCalls(communityId);
    }
  }, [communityId]);

  useEffect(() => {
    if (
      !!community && community.id === communityId && !!__channels && !!__areas && !!__roles
    ) {
      if (!allLoaded) setAllLoaded(true);
    }
    else {
      if (allLoaded) setAllLoaded(false);
    }
  }, [__areas, __channels, __roles, allLoaded, community, communityId])

  const channelsById = useMemo(() => {
    if (allLoaded && !!__channels) {
      const result = new Map<string, Models.Community.Channel>();
      for (const ch of __channels) {
        result.set(ch.channelId, ch);
      }
      return Object.freeze(result);
    }
  }, [allLoaded, __channels]);

  const channels = useMemo(() => {
    if (!!channelsById) {
      return Array.from(channelsById.values());
    }
  }, [channelsById]);

  const rolesById = useMemo(() => {
    if (allLoaded && !!__roles) {
      const result = new Map<string, Models.Community.Role>();
      for (const role of __roles) {
        result.set(role.id, role);
      }
      return Object.freeze(result);
    }
  }, [allLoaded, __roles]);

  const roles = useMemo(() => {
    if (!!rolesById) {
      return Array.from(rolesById.values());
    }
  }, [rolesById]);

  const areasById = useMemo(() => {
    if (allLoaded && !!__areas) {
      const result = new Map<string, Models.Community.Area>();
      for (const area of __areas) {
        result.set(area.id, area);
      }
      return Object.freeze(result);
    }
  }, [__areas, allLoaded]);

  const areas = useMemo(() => {
    if (!!areasById) {
      return Array.from(areasById.values());
    }
  }, [areasById]);

  const ownRolesById = useMemo(() => {
    if (allLoaded && !!__roles && !!community?.myRoleIds) {
      const result = new Map<string, Models.Community.Role>();
      for (const role of __roles) {
        if (community.myRoleIds.includes(role.id)) {
          result.set(role.id, role);
        }
      }
      return Object.freeze(result);
    }
  }, [__roles, allLoaded, community?.myRoleIds]);

  const ownRoles = useMemo(() => {
    if (!!ownRolesById) {
      return Array.from(ownRolesById.values());
    }
  }, [ownRolesById]);

  const communityPermissions = useMemo(() => {
    if (allLoaded && !!__roles && !!community?.myRoleIds) {
      const result = new Set<Common.CommunityPermission>();
      for (const role of __roles) {
        if (community.myRoleIds.includes(role.id) || isPredefinedRole(role, PredefinedRole.Public)) {
          for (const perm of role.permissions) {
            result.add(perm);
          }
        }
      }
      return Object.freeze(result);
    }
  }, [__roles, allLoaded, community?.myRoleIds]);

  const channelPermissionsById = useMemo(() => {
    if (allLoaded && !!__channels && !!ownRolesById) {
      const result = new Map<string, Set<Common.ChannelPermission>>();
      for (const ch of __channels) {
        const permissions = new Set<Common.ChannelPermission>();
        for (const rp of ch.rolePermissions) {
          if (ownRolesById?.has(rp.roleId)) {
            for (const perm of rp.permissions) {
              permissions.add(perm);
            }
          }
        }
        result.set(ch.channelId, permissions);
      }
      return Object.freeze(result);
    }
  }, [__channels, allLoaded, ownRolesById]);

  let value: CommunityState = useMemo(() => {
    if (
      !!allLoaded &&
      !!community &&
      !!areas &&
      !!areasById &&
      !!channels &&
      !!channelsById &&
      !!__calls &&
      !!roles &&
      !!rolesById &&
      !!ownRoles &&
      !!ownRolesById &&
      !!communityPermissions &&
      !!channelPermissionsById
    ) {
      return {
        state: 'loaded',
        setCommunityIdOrUrl: setIdOrUrl,
        setCommunityId: setId,
        community,
        areas,
        areasById,
        channels,
        channelsById,
        calls: __calls,
        roles,
        rolesById,
        ownRoles,
        ownRolesById,
        communityPermissions,
        channelPermissionsById,
      };
    }
    else if (!!communityId || !!communityUrl) {
      return {
        state: "loading",
        communityId,
        communityUrl,
        setCommunityIdOrUrl: setIdOrUrl,
        setCommunityId: setId,
      };
    }
    else {
      return {
        state: "no-community",
        setCommunityIdOrUrl: setIdOrUrl,
        setCommunityId: setId,
      };
    }
  }, [allLoaded, community, areas, areasById, channels, channelsById, __calls, roles, rolesById, ownRoles, ownRolesById, communityPermissions, channelPermissionsById, communityId, communityUrl, setIdOrUrl, setId]);

  return (
    <CommunityContext.Provider value={value}>
      {props.children}
    </CommunityContext.Provider>
  );
}

export function useSafeCommunityContext() {
  const context = React.useContext(CommunityContext);
  return context;
}

export function useLoadedCommunityContext() {
  const context = React.useContext(CommunityContext);
  if (context.state !== "loaded") {
    console.error("No community loaded. Use the safe version of this function or handle this error.");
    throw new Error();
  }
  return context;
}

const retrievals = {
  ids: new Set<string>(),
  promises: [] as Promise<void>[],
};
const contractDataCache = new Map<string, Models.Contract.Data | null>();
async function loadContracts(contractIds: string[]) {
  const filteredIds = contractIds.filter(id => !retrievals.ids.has(id));
  if (filteredIds.length > 0) {
    filteredIds.forEach(id => retrievals.ids.add(id));
    const promise = contractApi.getContractDataByIds({ contractIds: filteredIds })
    .then(data => {
      const failedContractIds = new Set(filteredIds);
      data.forEach(contract => {
        failedContractIds.delete(contract.id);
        contractDataCache.set(contract.id, contract);
      });
      failedContractIds.forEach(id => contractDataCache.set(id, null));
    })
    .finally(() => {
      filteredIds.forEach(id => retrievals.ids.delete(id));
      const index = retrievals.promises.findIndex(p => p === promise);
      if (index > -1) {
        retrievals.promises.splice(index, 1);
      }
    });
    retrievals.promises.push(promise);
  }
  await Promise.all([...retrievals.promises]);
}
function getContracts(contractIds: string[], withRetrieval: boolean) {
  const missingIds: string[] = [];
  const contracts: Record<string, Models.Contract.Data> = {};
  let retrievalPromise: Promise<void> | undefined;
  contractIds.forEach(id => {
    const contract = contractDataCache.get(id);
    if (contract === undefined) {
      missingIds.push(id);
    }
    else if (contract !== null) {
      contracts[id] = contract;
    }
    else {
      console.log("nulled contract in cache, this contract does not exist on the server", id);
    }
  });
  if (missingIds.length > 0 && withRetrieval) {
    retrievalPromise = loadContracts(missingIds);
  }
  return {
    contracts,
    retrievalPromise,
  };
}

export function useContractData(_contractIds: string[]) {
  const [ contractIds, setContractIds ] = useState<string[]>(_contractIds);
  useEffect(() => {
    if (contractIds.length === _contractIds.length) {
      // compare for equality
      const oldSet = new Set(contractIds);
      if (_contractIds.some(id => !oldSet.has(id))) {
        setContractIds(_contractIds);
      }
    }
    else {
      setContractIds(_contractIds);
    }
  }, [contractIds, _contractIds]);

  const initialContractData = useMemo(() => {
    return getContracts(contractIds, true);
  }, [contractIds]);

  const [contractData, setContractData] = useState<Record<string, Models.Contract.Data>>(initialContractData.contracts);

  useEffect(() => {
    let isMounted = true;
    if (initialContractData.retrievalPromise) {
      initialContractData.retrievalPromise.then(() => {
        if (isMounted) {
          const newContractData = getContracts(contractIds, false);
          setContractData(newContractData.contracts);
        }
      });
    } else {
      if (isMounted) {
        const newContractData = getContracts(contractIds, false);
        setContractData(newContractData.contracts);
      }
    }
    return () => {
      isMounted = false;
    }
  }, [contractIds, initialContractData.retrievalPromise]);

  return contractData;
}

const callsByIdCache = new Map<string, Models.Calls.Call>();
const callsByCommunityIdCache = new Map<string, Models.Calls.Call[]>();
let allCallsCache: Models.Calls.Call[] | undefined;

export function useCall(callId?: string) {
  const call = useLiveQuery(async () => {
    if (!callId) return;
    const _call = await data.community.getCallById(callId);
    if (!!_call) {
      callsByIdCache.set(callId, _call);
    }
    else {
      callsByIdCache.delete(callId);
    }
    return _call;
  }, [callId]);

  return call || (!!callId ? callsByIdCache.get(callId) : undefined);
}

export function useCalls(type: "community" | "all", communityId?: string) {
  const calls = useLiveQuery(async () => {
    if (type === "community") {
      if (!communityId) return;
      const _calls = await data.community.getCalls(communityId);
      callsByCommunityIdCache.set(communityId, _calls);
      return _calls;
    }
    else if (type === "all") {
      const _calls = await data.community.getAllActiveCalls();
      allCallsCache = _calls;
      return _calls;
    }
    else {
      throw new Error("Invalid call");
    }
    
  }, [type, communityId]);
  
  if (type === "community") {
    return calls || (!!communityId ? callsByCommunityIdCache.get(communityId) : undefined);
  }
  else if (type === "all") {
    return calls || allCallsCache;
  }
  else {
    throw new Error("Invalid call");
  }
}
