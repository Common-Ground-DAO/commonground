// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo } from "react";
import { useParams } from "react-router";
import { useLoadedCommunityContext } from "./CommunityProvider";

export const CommunityPluginContext = React.createContext<{ plugin?: Models.Plugin.Plugin }>({});

export function CommunityPluginProvider(props: React.PropsWithChildren) {
  const { community } = useLoadedCommunityContext();
  const { pluginId } = useParams<'pluginId'>();

  const plugin = useMemo(() => {
    return community?.plugins?.find(plugin => plugin.id === pluginId);
  }, [community?.plugins, pluginId]);

  return (
    <CommunityPluginContext.Provider value={{ plugin }}>
      {props.children}
    </CommunityPluginContext.Provider>
  );
}

export function useCommunityPluginContext() {
  const context = React.useContext(CommunityPluginContext);
  return context;
}