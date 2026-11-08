// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { PropsWithChildren, useCallback, useEffect, useMemo, useRef } from "react";
import './MobileLayout.css';
import MobileMenu from "../../components/organisms/MobileMenu/MobileMenu";
import MobileVoiceCallManager from "../../components/organisms/MobileVoiceCallManager/MobileVoiceCallManager";
import UserOnboarding from '../../components/organisms/UserOnboarding/UserOnboarding';
import CommunityViewSidebar from "../../components/organisms/CommunityViewSidebar/CommunityViewSidebar";
import { MobileProvider } from "../../context/MobileContext";
import { useLocation } from "react-router";
import { getMobileOperatingSystem } from "components/organisms/MobileMenu/util";
import { useCallContext } from "context/CallProvider";
import { useNotificationContext } from "context/NotificationProvider";

type Props = {
}

type MobileLayoutState = {
  isMenuHiddenRef: React.MutableRefObject<boolean> | undefined;
  setMenuHidden: (hidden: boolean) => void;
  registerMenuHiddenListener: (listener: (isHidden: boolean) => void) => void;
  unregisterMenuHiddenListener: (listener: (isHidden: boolean) => void) => void;
};

export const MobileLayoutContext = React.createContext<MobileLayoutState>({
  isMenuHiddenRef: undefined,
  setMenuHidden: () => {},
  registerMenuHiddenListener: () => {},
  unregisterMenuHiddenListener: () => {},
});

export default function MobileLayout(props: PropsWithChildren<Props>) {
  const { pwaStatus } = useNotificationContext();
  const { isMenuHiddenRef, registerMenuHiddenListener, unregisterMenuHiddenListener } = useMobileLayoutContext();
  const { isConnected } = useCallContext();
  const operatingSystem = getMobileOperatingSystem();

  const mobileMenuToggleRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const listener = (isHidden: boolean) => {
      const div = mobileMenuToggleRef.current;
      if (div) {
        if (isHidden) {
          div.classList.remove("with-mobile-menu");
        } else {
          div.classList.add("with-mobile-menu");
        }
      }
    };
    registerMenuHiddenListener(listener);
    return () => {
      unregisterMenuHiddenListener(listener);
    };
  }, []);

  const layoutClassName = [
    "layout mobile-layout",
    !isMenuHiddenRef?.current ? 'with-mobile-menu' : '',
    !!isConnected ? 'voice-call-manager-is-active' : '',
    operatingSystem === "Android" ? "mobile-layout-android" : pwaStatus === "InMobilePWA" ? "mobile-layout-ios-pwa" : 'mobile-layout-ios-web'
  ].join(" ").trim();

  return (
    <>
      <div className="background"/>
      <div className={layoutClassName} ref={mobileMenuToggleRef}>
        <MobileProvider>
          <MobileVoiceCallManager />
          <div className="content-window">
            <div className="content">
              <CommunityViewSidebar />
              {props.children}
            </div>
          </div>
          <MobileMenu />
          <UserOnboarding />
        </MobileProvider>
      </div>
    </>
  );
}

export function MobileLayoutProvider(props: React.PropsWithChildren<{}>) {
  const location = useLocation();
  const isMenuHiddenRef = useRef<boolean>(true);
  const changeListenersSet = useRef<Set<(isHidden: boolean) => void>>(new Set());

  const registerMenuHiddenListener = useCallback((listener: (isHidden: boolean) => void) => {
    changeListenersSet.current.add(listener);
  }, []);

  const unregisterMenuHiddenListener = useCallback((listener: (isHidden: boolean) => void) => {
    changeListenersSet.current.delete(listener);
  }, []);

  const setMenuHidden = useCallback((hidden: boolean) => {
    if (isMenuHiddenRef.current === hidden) return;
    isMenuHiddenRef.current = hidden;
    if (changeListenersSet.current.size > 0) {
      Array.from(changeListenersSet.current).forEach(listener => listener(hidden));
    }
  }, []);

  // Always unhide menu when changing location
  React.useEffect(() => {
    setMenuHidden(false);
  }, [location.pathname]);

  return (
    <MobileLayoutContext.Provider value={{ isMenuHiddenRef, setMenuHidden, registerMenuHiddenListener, unregisterMenuHiddenListener }}>
      {props.children}
    </MobileLayoutContext.Provider>
  ); 
}

export function useMobileLayoutContext() {
  const context = React.useContext(MobileLayoutContext);
  return context;
}
