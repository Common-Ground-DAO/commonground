// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { startTransition, useCallback, useEffect, useMemo, useRef, useState } from "react";
import config from '../common/config';

import connectionManager from "../data/appstate/connection";

type ConnectionState = {
  serviceWorkerState: Common.ServiceWorkerState;
  serviceWorkerProgress: number | null;
  /** `connected` only while the tab is live (socket logged in, rooms joined) */
  webSocketState: Common.WebSocketState;
  /** a newer build is deployed (the socket keeps working; see Transport.updateAvailable) */
  updateAvailable: boolean;
  loginState: Common.LoginState;
  visibilityState: Common.VisibilityState;
  onlineState: Common.OnlineState;
  showReleaseNotes: boolean;
  finishInstallationTriggered: boolean;
  savingIsPossible: boolean;
  setShowReleaseNotes: (value: boolean) => void;
  finishInstallation: () => Promise<void>;
  triggerSafeWindowReload: () => void;
}

export const ConnectionContext = React.createContext<ConnectionState>({
  serviceWorkerState: "pending",
  serviceWorkerProgress: null,
  webSocketState: "disconnected",
  updateAvailable: false,
  loginState: "pending",
  visibilityState: "visible",
  onlineState: "online",
  showReleaseNotes: false,
  finishInstallationTriggered: false,
  savingIsPossible: false,
  setShowReleaseNotes: () => undefined,
  finishInstallation: () => Promise.resolve(),
  triggerSafeWindowReload: () => undefined,
});

export function ConnectionProvider(props: { children: React.ReactNode }) {
  const [serviceWorkerState, _setServiceWorkerState] = useState<Common.ServiceWorkerState>(connectionManager.serviceWorkerState);
  const [serviceWorkerProgress, _setServiceWorkerProgress] = useState<number | null>(null);
  const [webSocketState, _setWebSocketState] = useState<Common.WebSocketState>(connectionManager.webSocketState);
  const [updateAvailable, _setUpdateAvailable] = useState<boolean>(connectionManager.updateAvailable);
  const [loginState, _setLoginState] = useState<Common.LoginState>(connectionManager.loginState);
  const [visibilityState, _setVisibilityState] = useState<Common.VisibilityState>(connectionManager.visibilityState);
  const [onlineState, _setOnlineState] = useState<Common.OnlineState>(connectionManager.onlineState);
  const [showReleaseNotes, _setShowReleaseNotes] = useState<boolean>(false);
  const [finishInstallationTriggered, setFinishInstallationTriggered] = useState<boolean>(false);
  const finishTriggeredRef = useRef<boolean>(false);

  const savingIsPossible = useMemo(() => {
    return (
      loginState === "loggedin" &&
      webSocketState === "connected" &&
      (onlineState === "online" || config.DEPLOYMENT === "dev")
    );
  }, [webSocketState, onlineState, loginState]);

  const setShowReleaseNotes = (state: boolean | ((old?: boolean) => boolean)) => {
    startTransition(() => {
      _setShowReleaseNotes(state);
    });
  }

  const swStateChangeHandler = useCallback(async (state: Common.ServiceWorkerState) => {
    _setServiceWorkerState(state);
  }, []);

  useEffect(() => {
    swStateChangeHandler(connectionManager.serviceWorkerState);
    _setServiceWorkerProgress(connectionManager.serviceWorkerProgress);
    _setWebSocketState(connectionManager.webSocketState);
    _setUpdateAvailable(connectionManager.updateAvailable);
    _setLoginState(connectionManager.loginState);
    _setVisibilityState(connectionManager.visibilityState);
    _setOnlineState(connectionManager.onlineState);
    
    connectionManager.addListener("serviceWorkerStateChange", swStateChangeHandler);
    connectionManager.addListener("serviceWorkerProgressChange", _setServiceWorkerProgress);
    connectionManager.addListener("webSocketStateChange", _setWebSocketState);
    connectionManager.addListener("updateAvailableChange", _setUpdateAvailable);
    connectionManager.addListener("loginStateChange", _setLoginState);
    connectionManager.addListener("visibilityStateChange", _setVisibilityState);
    connectionManager.addListener("onlineStateChange", _setOnlineState);
    return () => {
      connectionManager.removeListener("serviceWorkerStateChange", swStateChangeHandler);
      connectionManager.removeListener("serviceWorkerProgressChange", _setServiceWorkerProgress);
      connectionManager.removeListener("webSocketStateChange", _setWebSocketState);
      connectionManager.removeListener("updateAvailableChange", _setUpdateAvailable);
      connectionManager.removeListener("loginStateChange", _setLoginState);
      connectionManager.removeListener("visibilityStateChange", _setVisibilityState);
      connectionManager.removeListener("onlineStateChange", _setOnlineState);
    }
  }, [swStateChangeHandler]);

  const finishInstallation = useCallback(async () => {
    if (!finishTriggeredRef.current) {
      finishTriggeredRef.current = true;
      setFinishInstallationTriggered(true);
      await new Promise(resolve => setTimeout(resolve, 300));
      connectionManager.finishInstallation();
      await new Promise(resolve => setTimeout(resolve, 1800));
      window.location.reload();
    }
  }, []);

  const triggerSafeWindowReload = useMemo(() => {
    return connectionManager.triggerSafeWindowReload.bind(connectionManager);
  }, []);

  return (
    <ConnectionContext.Provider value={{
      serviceWorkerState,
      serviceWorkerProgress,
      webSocketState,
      updateAvailable,
      loginState,
      visibilityState,
      onlineState,
      showReleaseNotes,
      finishInstallationTriggered,
      savingIsPossible,
      setShowReleaseNotes,
      finishInstallation,
      triggerSafeWindowReload,
    }}>
      {props.children}
    </ConnectionContext.Provider>
  );
}

export function useConnectionContext() {
  const context = React.useContext(ConnectionContext);
  return context;
}