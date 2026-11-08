// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { createContext, useContext, useRef, useState } from "react";

type CommunitySidebarState = {
    communitySidebarIsOpen: boolean;
    setCommunitySidebarIsOpen: React.Dispatch<React.SetStateAction<boolean>>;
    isSidebarLockOpen: boolean; // Locks sidebar open (clicking outside won't close it)
    setSidebarLockOpen: React.Dispatch<React.SetStateAction<boolean>>;
    showLeaveGroupModal: boolean;
    setShowLeaveGroupModal: React.Dispatch<React.SetStateAction<boolean>>;
    sliderTriggerRef: React.RefObject<HTMLButtonElement | null> | undefined;
    communityListIsExpanded: boolean;
    setCommunityListIsExpanded: React.Dispatch<React.SetStateAction<boolean>>;
    communityListManualState: boolean;
    setCommunityListManualState: React.Dispatch<React.SetStateAction<boolean>>;
}

const initialState: CommunitySidebarState = {
    communitySidebarIsOpen: false,
    setCommunitySidebarIsOpen: () => {},
    isSidebarLockOpen: false,
    setSidebarLockOpen: () => {},
    showLeaveGroupModal: false,
    setShowLeaveGroupModal: () => {},
    sliderTriggerRef: undefined,
    communityListIsExpanded: true,
    setCommunityListIsExpanded: () => {},
    communityListManualState: true,
    setCommunityListManualState: () => {},
}

export const CommunitySidebarContext = createContext<CommunitySidebarState>(initialState);

export function CommunitySidebarProvider(props: React.PropsWithChildren<{}>) {
    const [ communitySidebarIsOpen, setCommunitySidebarIsOpen ] = useState<boolean>(false);
    const [ isSidebarLockOpen, setSidebarLockOpen ] = useState<boolean>(false);
    const [ showLeaveGroupModal, setShowLeaveGroupModal ] = useState<boolean>(false);
    const sliderTriggerRef = useRef<HTMLButtonElement>(null);
    const [ communityListIsExpanded, setCommunityListIsExpanded ] = useState<boolean>(true); // tracks both manual and automatic collapsing of community list (automatic means collapsed due to opening the channel list tray)
    const [ communityListManualState, setCommunityListManualState ] = useState<boolean>(true); // tracks only manual toggling of community list

    return (
        <CommunitySidebarContext.Provider value={{
            communitySidebarIsOpen,
            setCommunitySidebarIsOpen,
            isSidebarLockOpen,
            setSidebarLockOpen,
            showLeaveGroupModal,
            setShowLeaveGroupModal,
            sliderTriggerRef,
            communityListIsExpanded,
            setCommunityListIsExpanded,
            communityListManualState,
            setCommunityListManualState,
        }}>
            {props.children}
        </CommunitySidebarContext.Provider>
    )
}

export function useCommunitySidebarContext() {
    return useContext(CommunitySidebarContext);
}