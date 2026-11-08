// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useRef, useCallback, useState } from "react";
import useIframePlugin from "views/PluginView/useIframePlugin";
import IframePluginPortal from "components/organisms/IframePluginPortal/IframePluginPortal";
import AddPermissionModal from "components/organisms/AddPermissionModal/AddPermissionModal";
import pluginsApi from "data/api/plugins";
import { useUserSettingsContext } from "./UserSettingsProvider";
import { PluginPermission } from "common/enums";

type PluginIframeContextState = {
  loadIframe: (communityId: string, pluginId: Models.Plugin.Plugin) => void;
  unloadIframe: () => void;
  isDocked: boolean;
  setIsDocked: (isDocked: boolean) => void;
  dockRef: React.RefObject<HTMLDivElement | null> | null;
  iframeRef: React.RefObject<HTMLIFrameElement | null> | null;
  iframeUrl: string | null;
  iframeOrigin: string | null;
  pluginData: Models.Plugin.Plugin | null;

  requestedPermission: 'email' | 'twitter' | 'lukso' | 'farcaster' | 'friends' | null;
  showPermissionModal: (permission: 'email' | 'twitter' | 'lukso' | 'farcaster' | 'friends' | null) => void;
};

export const requestedPermissionToPermission = (permission: 'email' | 'twitter' | 'lukso' | 'farcaster' | 'friends') => {
    switch (permission) {
      case 'email':
        return PluginPermission.READ_EMAIL;
      case 'twitter':
        return PluginPermission.READ_TWITTER;
      case 'lukso':
        return PluginPermission.READ_LUKSO;
      case 'farcaster':
        return PluginPermission.READ_FARCASTER;
      case 'friends':
        return PluginPermission.READ_FRIENDS;
      default:
        throw new Error(`Unknown permission: ${permission}`);
    }
  };

export const PluginIframeContext = React.createContext<PluginIframeContextState>({
  loadIframe: () => {},
  unloadIframe: () => {},
  setIsDocked: () => {},
  dockRef: null,
  iframeRef: null,
  iframeUrl: null,
  iframeOrigin: null,
  isDocked: false,
  pluginData: null,

  requestedPermission: null,
  showPermissionModal: () => { console.warn('showPermissionModal not implemented'); },
});

export function PluginIframeProvider(props: React.PropsWithChildren<{}>) {
  const [communityId, setCommunityId] = useState<string | null>(null);
  const [plugin, setPlugin] = useState<Models.Plugin.Plugin | null>(null);
  const [isDocked, setIsDocked] = useState(false);
  const { setCurrentPage, setIsOpen } = useUserSettingsContext();
  const [requestedPermission, setRequestedPermission] = useState<'email' | 'twitter' | 'lukso' | 'farcaster' | 'friends' | null>(null);
  const dockRef = useRef<HTMLDivElement>(null);

  const loadIframe = useCallback((communityId: string, plugin: Models.Plugin.Plugin) => {
    setCommunityId(communityId);
    setPlugin(plugin);
  }, []);

  const unloadIframe = useCallback(() => {
    setCommunityId(null);
    setPlugin(null);
  }, []);

  const { iframeRef, iframeUrl, iframeOrigin } = useIframePlugin(communityId || '', plugin, setRequestedPermission);

  return (
    <PluginIframeContext.Provider value={{
      loadIframe,
      unloadIframe,
      setIsDocked,
      dockRef,
      iframeRef,
      iframeUrl,
      iframeOrigin,
      isDocked,
      pluginData: plugin,
      requestedPermission,
      showPermissionModal: setRequestedPermission
    }}>
      {props.children}
      <IframePluginPortal />
      <AddPermissionModal
        requestedPermission={requestedPermission}
        setRequestedPermission={setRequestedPermission}
        onAcceptPermission={async (openAccountProvider) => {
          if (!requestedPermission) {
            return;
          }

          if (openAccountProvider) {
            setIsOpen(true);
            setCurrentPage('available-providers');
          }
          
          setRequestedPermission(null);
          if (plugin) {
            await pluginsApi.acceptPluginPermissions({
              pluginId: plugin?.id || '',
              permissions: [...(plugin.acceptedPermissions || []), requestedPermissionToPermission(requestedPermission)],
            })
          }
        }}
      />
    </PluginIframeContext.Provider>
  )
}

export function usePluginIframeContext() {
  const { requestedPermission, showPermissionModal, ...context }= React.useContext(PluginIframeContext);
  return context;
}
