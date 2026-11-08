// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { useState, useImperativeHandle, forwardRef, useMemo, useCallback } from "react";
import { createPortal } from "react-dom";
import "./Dialog.css";

export type DialogRefHandle = {
    show: (duration?: number, callback?: () => void) => void;
}

type Props = {
    children: React.JSX.Element;
}

const Dialog = forwardRef<DialogRefHandle, Props>((props, ref) => {
    const { children } = props;
    const [ visible, setVisible ] = useState<boolean>(false);
    const portalRoot = useMemo(() => document.getElementById("toast-root") as HTMLElement, []);

    const showDialog = useCallback((duration?: number) => {
        setVisible(true);
        const thisDuration = duration || 1500;
        setTimeout(() => {
            setVisible(false);
        }, thisDuration);
    }, []);

    useImperativeHandle(ref, () => ({
        show: (duration?: number, callback?: () => void) => {
            showDialog(duration);
            if (callback) {
                callback();
            }
        }
    }), []); // showDialog never changes

    return (
        <>
            {visible ? createPortal(
                <div className="dialog">
                    <div className="dialog-inner">
                        {children}
                    </div>
                </div>,
                portalRoot
            ) : null}
        </>
    )
});

export default Dialog;