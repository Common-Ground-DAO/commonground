// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo, useState } from 'react';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import connectionManager from 'data/appstate/connection';
import urlConfig from '../data/util/urls';
import webSocketManager from 'data/appstate/webSocket';
import errors from 'common/errors';
import { browserSupportsWebAuthn } from '@simplewebauthn/browser';

// Legacy CG ID (gateway) instances only (docs/auth-identity §7): passkeys live
// on the separate CG ID app, opened as a popup; its result arrives by socket
// event (this tab's socket watches the request id) or postMessage, and
// `loginManager.login({ account: 'passkey-legacy' })` redeems it. This is the pre-G4 PasskeyProvider, moved here (login only — the
// CG ID app registers no passkeys any more); on every other instance
// PasskeyProvider runs the ceremonies on this origin.

type PasskeyProcessStatus = 'idle' | 'waitForWebsocket' | 'executing';

type LegacyCgIdPasskeyState = {
    passkeysSupported: boolean;
    loginWithPasskey: (timeout?: number) => Promise<boolean>;
    status: PasskeyProcessStatus;
    error?: string;
};

export const LegacyCgIdPasskeyContext = React.createContext<LegacyCgIdPasskeyState>({
    passkeysSupported: false,
    loginWithPasskey: async () => false,
    status: 'idle',
});

/** 20 characters of base64url from 15 random bytes */
function randomRequestId() {
    const bytes = crypto.getRandomValues(new Uint8Array(15));
    return btoa(String.fromCharCode(...Array.from(bytes))).replace(/\+/g, '-').replace(/\//g, '_');
}

function cgIdOrigin(): string | null {
    try {
        return new URL(urlConfig.CGID_URL).origin;
    }
    catch {
        return null;
    }
}

export function LegacyCgIdPasskeyProvider(props: React.PropsWithChildren<{}>) {
    const { isMobile } = useWindowSizeContext();
    const [status, setStatus] = useState<PasskeyProcessStatus>('idle');
    const [error, setError] = useState<string | undefined>();
    const passkeysSupported = useMemo(() => browserSupportsWebAuthn(), []);

    const passkeyAction = useCallback((action: 'login', timeout = 60_000) => {
        if (status === 'idle') {
            setStatus('executing');
            // unguessable: the socket room of the popup's result is named after it
            const requestId = randomRequestId();
            let timeoutId: any = undefined;
            let handled = false;

            let resolve: (value: boolean | PromiseLike<boolean>) => void;
            let reject: (reason?: any) => void;
            const promise = new Promise<boolean>((_resolve, _reject) => {
                resolve = _resolve;
                reject = _reject;
            });

            const executeAction = () => {
                let features: string | undefined;
                if (!isMobile) {
                    const x = window.screen.width / 2 - 300;
                    const y = window.screen.height / 2 - 230;
                    features = "width=600,height=460,left=" + x + ",top=" + y;
                }
                webSocketManager.watchCgIdRequest(requestId);
                const win = window.open(`${urlConfig.CGID_URL}/${action}/${requestId}`, "cgPassportSignWindow", features);
                if (win) {
                    const checkWindowClosedInterval = setInterval(() => {
                        if (win.closed) {
                            clearInterval(checkWindowClosedInterval);
                            setTimeout(() => {
                                if (!handled) {
                                    handlingFinished();
                                    reject?.(new Error("Cancelled by user"));
                                }
                            }, 200);
                        }
                    }, 200);
                }
            };

            const webSocketStateListener = (webSocketState: Common.WebSocketState) => {
                if (webSocketState === "connected") {
                    executeAction();
                    // Todo: potentially keep the listener to handle connection loss
                    // during the signature process? Should be an edge case though.
                    connectionManager.removeListener("webSocketStateChange", webSocketStateListener);
                }
            };

            const passkeyResultListener = (event: Events.CgId.SignResponse, fromWindowPostMessage = false) => {
                if (event.frontendRequestId === requestId) {
                    const { success, error } = event.data;
                    if (success === false && error !== undefined) {
                        setError(error);
                    }

                    console.log(`Passkey result received (by ${fromWindowPostMessage ? 'post message' : 'websocket'})`, event.data);
                    handlingFinished();
                    resolve?.(success);
                }
            };

            const passkeyResultPostMessageListener = function (this: Window, event: MessageEvent<Events.CgId.SignResponse>) {
                // only the CG ID popup posts here (src/cgid/helpers.ts)
                if (event.origin !== cgIdOrigin() || event?.data?.type !== "cliCgIdSignResponse") {
                    return;
                }
                passkeyResultListener(event.data, true);
            };

            const handlingFinished = () => {
                handled = true;
                if (timeoutId !== undefined) {
                    clearTimeout(timeoutId);
                    timeoutId = undefined;
                }
                connectionManager.unregisterClientEventHandler("cliCgIdSignResponse", passkeyResultListener);
                webSocketManager.unwatchCgIdRequest(requestId);
                window.removeEventListener("message", passkeyResultPostMessageListener);
                connectionManager.removeListener("webSocketStateChange", webSocketStateListener);
                setStatus('idle');
            };

            timeoutId = setTimeout(() => {
                timeoutId = undefined;
                if (handled) {
                    return;
                }
                handlingFinished();
                reject?.(errors.client.TIMEOUT);
                console.error("Passkey: " + action + " timed out");
            }, timeout);

            connectionManager.registerClientEventHandler("cliCgIdSignResponse", passkeyResultListener);
            window.addEventListener("message", passkeyResultPostMessageListener)

            if (webSocketManager.state === "connected") {
                executeAction();
            }
            else {
                setStatus('waitForWebsocket');
                connectionManager.addListener("webSocketStateChange", webSocketStateListener);
                console.error("No active webSocket connection detected, waiting for connection...");
            }

            return promise;
        }
        else {
            throw new Error("Passkey action already in progress");
        }
    }, [status, isMobile]);

    const loginWithPasskey = useMemo(() => {
        return (timeout?: number) => passkeyAction('login', timeout);
    }, [passkeyAction]);

    return (
        <LegacyCgIdPasskeyContext.Provider value={{
            passkeysSupported,
            loginWithPasskey,
            status,
            error,
        }}>
            {props.children}
        </LegacyCgIdPasskeyContext.Provider>
    )
}

export function useLegacyCgIdPasskeyContext() {
    const context = React.useContext(LegacyCgIdPasskeyContext);
    return context;
}