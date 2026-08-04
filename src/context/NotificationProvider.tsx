// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useState } from "react";
import data from "data";
import { useNavigate } from "react-router-dom";

import connectionManager from "../data/appstate/connection";
import serviceWorkerManager from "../data/appstate/serviceWorker";
import useLocalStorage from "hooks/useLocalStorage";
import { UAParser } from "ua-parser-js";

type PwaStatus =
  "iOS_UpdateRequired" |
  "iOS_OpenWithSafari" |
  "iOS_InSafari_InstallPWA" |
  "InMobilePWA" |
  "Android_OpenWithChrome" |
  "Android_InChrome_InstallPWA" |
  "Android_InChrome_PWAInstallSuccess" |
  "OnDesktop";

type NotificationState = {
  unreadCount: number;
  subscription: Models.Notification.PushSubscription | null | "not-available" | "wait-for-renew" | undefined;
  pwaStatus: PwaStatus;
  subscribeWebPush?: () => Promise<void>;
  unsubscribeWebPush?: () => Promise<void>;
};

const isInPWA = window.matchMedia('(display-mode: standalone)').matches;

const initialContextValue: NotificationState = {
  unreadCount: 0,
  subscription: undefined,
  pwaStatus: "OnDesktop",
};

type ParsedVersion = {
  major: number;
  minor: number;
  patch: number;
};

function parseVersion(version: string): ParsedVersion {
  const m = version.match(/^(\d+)\.?(\d+)?\.?(\d+?)?$/);
  if (!!m) {
    const result: ParsedVersion = {
      major: parseInt(m[1]),
      minor: m[2] !== undefined ? parseInt(m[2]) : 0,
      patch: m[3] !== undefined ? parseInt(m[3]) : 0,
    };
    return result;
  }
  else {
    console.error("Could not detect version", version);
    throw new Error("Could not detect version");
  }
}

function getCurrentPwaStatus(appWasInstalled: boolean): PwaStatus {
  const userAgent = UAParser();
  // iOS
  if (userAgent.os.name === "iOS") {
    if (!userAgent.os.version) {
      return "iOS_UpdateRequired";
    }
    else {
      const { major, minor } = parseVersion(userAgent.os.version);
      if (major > 16 || (major === 16 && minor >= 4)) {
        // iOS >= 16.4
        if (userAgent.browser.name === "Mobile Safari") {
          if (!isInPWA) {
            return "iOS_InSafari_InstallPWA";
          }
          else {
            return "InMobilePWA";
          }
        }
        else {
          return "iOS_OpenWithSafari";
        }
      }
      else {
        return "iOS_UpdateRequired";
      }
    }
  }
  // Android
  else if (userAgent.os.name === "Android") {
    // ua-parser-js 2 renamed the mobile builds of the desktop browsers: Android
    // Chrome reports "Mobile Chrome" (as does Chrome on iOS), where v1 reported
    // a plain "Chrome". Both spellings are accepted so the install prompt keeps
    // working no matter which copy of the parser ends up bundled.
    if (userAgent.browser.name === "Chrome" || userAgent.browser.name === "Mobile Chrome") {
      if (!isInPWA) {
        if (appWasInstalled) {
          return "Android_InChrome_PWAInstallSuccess";
        }
        else {
          return "Android_InChrome_InstallPWA";
        }
      }
      else {
        return "InMobilePWA";
      }
    }
    else {
      return "Android_OpenWithChrome";
    }
  }
  return "OnDesktop";
}

export const NotificationContext = React.createContext<NotificationState>(initialContextValue);

export const NotificationProvider = React.memo((props: React.PropsWithChildren) => {
  const [unreadCount, setUnreadCount] = useState(data.notification.unreadCount);
  const [subscription, setSubscription] = useState<Models.Notification.PushSubscription | null | "not-available" | "wait-for-renew" | undefined>();
  const [appWasInstalled, setAppWasInstalled] = useLocalStorage(false, 'CG_CHROME_PWA_INSTALLED');
  const [pwaStatus, setPwaStatus] = useState<PwaStatus>(getCurrentPwaStatus(appWasInstalled));

  useEffect(() => {
    // broken since android 12? returns empty array
    // see https://bugs.chromium.org/p/chromium/issues/detail?id=1450328

    // if ('getInstalledRelatedApps' in navigator && typeof (navigator as any).getInstalledRelatedApps === 'function') {
    //   ((navigator as any).getInstalledRelatedApps() as Promise<any>).then(val => console.log("INSTALLED APPS:", val))
    // }

    if (serviceWorkerManager.currentPushSubscription !== undefined) {
      setSubscription(serviceWorkerManager.currentPushSubscription);
    }
    serviceWorkerManager.onpushsubscriptionchange = (subscription) => {
      setSubscription(subscription);
    }
    return () => {
      serviceWorkerManager.onpushsubscriptionchange = () => undefined;
    }
  }, []);

  useEffect(() => {
    const appInstalledListener = () => {
      if (!appWasInstalled) {
        setAppWasInstalled(true);
        setPwaStatus(getCurrentPwaStatus(true));
      }
    }
    (window as any).onappinstalled = appInstalledListener;
    return () => {
      (window as any).onappinstalled = () => undefined;
    }
  }, [appWasInstalled, setAppWasInstalled]);

  const navigate = useNavigate();

  const serviceWorkerNavigate = useCallback((url: string) => {
    if (url.startsWith("/")) {
      navigate(url);
    }
  }, [navigate]);
  
  useEffect(() => {
    if (unreadCount !== data.notification.unreadCount) {
      setUnreadCount(data.notification.unreadCount);
    }
    data.notification.onunreadcountchange = (value) => {
      setUnreadCount(value);
    }
    return () => {
      data.notification.onunreadcountchange = () => undefined;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    connectionManager.addListener("serviceWorkerNavigate", serviceWorkerNavigate);
    return () => {
      connectionManager.removeListener("serviceWorkerNavigate", serviceWorkerNavigate);
    }
  }, [serviceWorkerNavigate]);

  const subscribeWebPush = useCallback(async () => {
    await serviceWorkerManager.subscribeWebPush();
  }, []);

  const unsubscribeWebPush = useCallback(async () => {
    await serviceWorkerManager.unsubscribeWebPush();
  }, []);

  const exposeSubscribe = subscription === null;

  return (
    <NotificationContext.Provider value={{
      unreadCount,
      subscription,
      subscribeWebPush: exposeSubscribe ? subscribeWebPush : undefined,
      unsubscribeWebPush: exposeSubscribe ? unsubscribeWebPush : undefined,
      pwaStatus,
    }}>
      {props.children}
    </NotificationContext.Provider>
  )
});

export function useNotificationContext() {
  const context = React.useContext(NotificationContext);
  return context;
}
