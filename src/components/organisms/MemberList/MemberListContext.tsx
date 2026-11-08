// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { createContext, useContext, useRef, useState } from "react";

type MemberListContextState = {
    memberListIsOpen: boolean;
    setShowMemberList: React.Dispatch<React.SetStateAction<boolean>>;
    memberListDrawerRef: React.RefObject<HTMLDivElement | null> | undefined;
}

export const MemberListContext = createContext<MemberListContextState>({
    memberListIsOpen: false,
    setShowMemberList: () => undefined,
    memberListDrawerRef: undefined,
});

export function MemberListProvider(props: React.PropsWithChildren) {
    const [showMemberList, setShowMemberList] = useState<boolean>(false);
    const memberListDrawerRef = useRef<HTMLDivElement>(null);

    return (
        <MemberListContext.Provider value={{
            memberListIsOpen: showMemberList,
            setShowMemberList,
            memberListDrawerRef
        }}>
            {props.children}
        </MemberListContext.Provider>
    )
}

export function useMemberListContext() {
    return useContext(MemberListContext);
}