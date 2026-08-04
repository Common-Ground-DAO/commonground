// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// copied from:
// https://gist.github.com/perlow/bb7612b25f37667be964f1a1aba42780

import React, { useCallback } from 'react';
import { useLayoutEffect, useRef, useState, useTransition } from 'react';
import { Router } from 'react-router-dom';
import { BrowserHistory, createBrowserHistory, Update } from 'history';
import { useConnectionContext } from 'context/ConnectionProvider';

export interface BrowserRouterProps {
  basename?: string
  children?: React.ReactNode
  window?: Window
}

type NavigationContextState = {
  isDirty: boolean;
  setDirty: (isDirty: boolean) => void,
  setUpdateOnNavigate: (updateOnNavigate: boolean) => void,
}

const NavigationContext = React.createContext<NavigationContextState>({
  isDirty: false,
  setDirty: (isDirty: boolean) => {},
  setUpdateOnNavigate: () => {},
});

export function SuspenseRouter({ basename, children, window: propsWindow }: BrowserRouterProps) {
  let historyRef = useRef<BrowserHistory>(undefined);
  const { finishInstallation } = useConnectionContext();
  const [isPending, startTransition] = useTransition();
  const [isDirty, setDirty] = useState(false);
  const [updateOnNavigate, setUpdateOnNavigate] = useState(false);

  if (historyRef.current == null) {
    //const history = createBrowserHistory(startTransition, { window });
    historyRef.current = createBrowserHistory({ window: propsWindow });
  }

  let history = historyRef.current
  let [state, setState] = useState({
    action: history.action,
    location: history.location,
  });

  const setStateAsync = useCallback((update: Update) => {
    if (isDirty) {
      const res = window.confirm('You have unsaved changes, do you want to leave anyway?');
      if (!res) {
        // Go back without triggering warning
        return;
      } else {
        setDirty(false);
      }
    }

    const _paq: any[] | undefined = (window as any)._paq;
    if (!!_paq && "push" in _paq) {
      _paq.push(['setCustomUrl', update.location.pathname]);
      _paq.push(['setDocumentTitle', document.title]);
      _paq.push(['trackPageView']);
    }
    startTransition(() => {
      setState(update)
    });

    if (updateOnNavigate) {
      finishInstallation();
      setUpdateOnNavigate(false);
    }
  }, [finishInstallation, isDirty, updateOnNavigate]);

  useLayoutEffect(() => {
    const unlisten = history.listen(setStateAsync);
    return unlisten;
  }, [history, setStateAsync])

  return (
    <NavigationContext.Provider value={{
      isDirty,
      setDirty,
      setUpdateOnNavigate
    }}>
      <Router
        basename={basename}
        children={children}
        location={state.location}
        navigationType={state.action}
        navigator={history}
      />
    </NavigationContext.Provider>
  )
}

export function useNavigationContext() {
  const context = React.useContext(NavigationContext);
  return context;
}

export default SuspenseRouter