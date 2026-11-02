// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useState } from "react";
import { useLocation } from "react-router";

type IsolationModeState = {
    isolationEnabled: boolean;
    setIsolationEnabled?: (isolationEnabled: boolean) => void;
    toggleIsolationMode: (customGoto?: string) => void;
}

export const IsolationModeContext = React.createContext<IsolationModeState>({
    isolationEnabled: false,
    toggleIsolationMode: () => { },
});

export function IsolationModeProvider(props: React.PropsWithChildren<{}>) {
    const [isolationEnabled, setIsolationEnabled] = useState<boolean>(false);
    const { pathname, search } = useLocation();

    const toggleIsolationMode = useCallback((customGoto?: string) => {
        if (!isolationEnabled) {
            window.location.replace(`/enable-cross-origin-security?goto=${encodeURIComponent(customGoto || (pathname + search))}`);
        }
        else {
            window.location.replace(`/disable-cross-origin-security?goto=${encodeURIComponent(customGoto || (pathname + search))}`);
        }
    }, [isolationEnabled, pathname, search]);

    return (
        <IsolationModeContext.Provider value={{ isolationEnabled, setIsolationEnabled, toggleIsolationMode }}>
            {props.children}
        </IsolationModeContext.Provider>
    );
}

export function useIsolationMode() {
    const context = React.useContext(IsolationModeContext);
    return {
        isolationEnabled: context.isolationEnabled,
        toggleIsolationMode: context.toggleIsolationMode,
    };
}

export function useManageIsolationMode() {
    const context = React.useContext(IsolationModeContext);
    return context;
}