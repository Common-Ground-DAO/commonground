// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useManageIsolationMode } from "context/IsolationModeProvider";
import React, { useEffect, useRef } from "react";
import { useNavigate, useSearchParams } from "react-router";

type IsolationModeToggleProps = {
    mode: 'enable' | 'disable';
};

export default function IsolationModeToggle({ mode }: IsolationModeToggleProps) {
    const [searchParams] = useSearchParams();
    const { setIsolationEnabled } = useManageIsolationMode();
    const navigate = useNavigate();
    const setupCompleted = useRef(false);

    useEffect(() => {
        if (setIsolationEnabled && !setupCompleted.current) {
            setupCompleted.current = true;
            if (mode === 'enable') {
                console.log('Isolation mode: enabled');
                setIsolationEnabled(true);
            } else {
                console.log('Isolation mode: disabled');
                setIsolationEnabled(false);
            }
            const goto = searchParams.get('goto');
            if (goto) {
                setTimeout(() => {
                    navigate(goto);
                }, 0);
            }
        }
    }, [setIsolationEnabled]);

    // if (mode === 'enable') {
    //     return (
    //         <div className="cg-text-main text-lg w-full h-full flex flex-col items-center justify-center">
    //             <div>Isolation Mode: enabled</div>
    //             <div>Redirecting...</div>
    //         </div>
    //     );
    // } else {
    //     return (
    //         <div className="cg-text-main text-lg w-full h-full flex flex-col items-center justify-center">
    //             <div>Isolation Mode: disabled</div>
    //             <div>Redirecting...</div>
    //         </div>
    //     );
    // }
    return null;
}
