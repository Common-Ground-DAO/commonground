// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { createContext, useContext, useRef } from "react";
import Dialog, { DialogRefHandle } from "../components/molecules/Dialog/Dialog";

import CheckmarkFilledIcon from '../components/atoms/icons/20/CheckmarkFilled.svg?react';

type CopiedToClipboardDialogState = {
    triggerCopiedToClipboardDialog: (textToCopy: string) => void;
}

export const CopiedToClipboardDialogContext = createContext<CopiedToClipboardDialogState>({
    triggerCopiedToClipboardDialog: () => undefined,
});

export function CopiedToClipboardDialogProvider(props: React.PropsWithChildren) {
    const dialogRef = useRef<DialogRefHandle>(null);

    const triggerCopiedToClipboardDialog = (textToCopy: string) => {
        navigator.clipboard.writeText(textToCopy)

        if (dialogRef.current) {
            dialogRef.current.show(1000);
        }
    }

    const copiedToClipboardDialog = (
        <Dialog ref={dialogRef} >
            <p className="dialog-success-msg">Copied to clipboard <CheckmarkFilledIcon className="dialog-checkmark" /></p>
        </Dialog>
    );

    return (
        <CopiedToClipboardDialogContext.Provider value={{ triggerCopiedToClipboardDialog }}>
            {props.children}
            {copiedToClipboardDialog}
        </CopiedToClipboardDialogContext.Provider>
    )
}

export function useCopiedToClipboardContext() {
    return useContext(CopiedToClipboardDialogContext);
}