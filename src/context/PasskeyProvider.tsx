// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import errors from 'common/errors';
import loginManager from 'data/appstate/login';
import userApi from 'data/api/user';
import stepUpManager from 'data/auth/stepUp';
import { getAuthMode, getSignalRpId } from 'data/auth/authMode';
import {
    abortPasskeyCeremony,
    authenticateWithPasskey,
    passkeyAutofillSupported,
    passkeysSupported,
    registerPasskey,
    signalUnknownCredential,
    toPasskeyCeremonyError,
    type RegisteredPasskey,
} from 'data/auth/passkeyCeremony';
import { LegacyCgIdPasskeyProvider, useLegacyCgIdPasskeyContext } from './LegacyCgIdPasskey';

/**
 * Passkeys for the UI (docs/auth-identity §7, docs/frontend). On a normal
 * instance every ceremony runs on this origin against the `Passkey` API; on a
 * legacy CG ID (gateway) instance `login` goes through the CG ID popup
 * (LegacyCgIdPasskey) and nothing else is available.
 *
 * Every action resolves to an outcome instead of throwing: `cancelled` means
 * the user dismissed the browser dialog — show nothing.
 */

export type PasskeyOutcome<T> =
    { status: 'ok'; result: T } |
    { status: 'cancelled' } |
    /** the step-up dialog was needed first; the ceremony needs a new click */
    { status: 'reauthenticated' } |
    { status: 'error'; message: string; code?: string };

type PasskeyState = {
    /** WebAuthn usable in this browser (and on this instance) */
    supported: boolean;
    /** passkeys offered in the username field's autofill */
    autofillSupported: boolean;
    /** legacy CG ID popup instead of main-origin ceremonies */
    legacy: boolean;
    status: 'idle' | 'busy';
    /** create a passkey: logged out it waits for createUser, logged in it is added */
    register: (options?: { displayName?: string; name?: string; useAutoRegister?: boolean; beforeStart?: () => boolean }) => Promise<PasskeyOutcome<RegisteredPasskey>>;
    /** modal ceremony + User/login; must be called from a click */
    login: () => Promise<PasskeyOutcome<API.User.login.Response>>;
    /**
     * conditional (autofill) login on the mounted `webauthn` input; returns a
     * disarm function. `onEnded` reports a failure (message: show it) after
     * which the caller may arm again; a cancel/replace is not reported.
     */
    armAutofill: (onLoggedIn: (response: API.User.login.Response) => void, onEnded?: (message?: string) => void) => () => void;
    /** step-up with a passkey; must be called from a click */
    reauthenticate: () => Promise<PasskeyOutcome<number>>;
};

const unavailable = { status: 'error', message: "Passkeys aren't available here." } as const;

export const PasskeyContext = React.createContext<PasskeyState>({
    supported: false,
    autofillSupported: false,
    legacy: false,
    status: 'idle',
    register: async () => unavailable,
    login: async () => unavailable,
    armAutofill: () => () => undefined,
    reauthenticate: async () => unavailable,
});

const UNKNOWN_CREDENTIAL_MESSAGE = "This passkey doesn't belong to an account here any more. Sign in another way.";

function failure<T>(e: unknown): PasskeyOutcome<T> {
    const error = toPasskeyCeremonyError(e);
    if (error.silent) {
        return { status: 'cancelled' };
    }
    if (error.kind === 'reauthenticated') {
        return { status: 'reauthenticated' };
    }
    return { status: 'error', message: error.message, code: error.serverCode };
}

/** User/login with an assertion; an unknown credential is signalled to the browser */
async function loginWithAssertion(
    assertion: Awaited<ReturnType<typeof authenticateWithPasskey>>,
): Promise<PasskeyOutcome<API.User.login.Response>> {
    try {
        const result = await loginManager.login({ account: 'passkey', authenticationResponse: assertion.response });
        return { status: 'ok', result };
    }
    catch (e) {
        const code = e instanceof Error ? e.message : undefined;
        if (code === errors.server.NOT_FOUND || code === errors.server.DELETED) {
            await signalUnknownCredential(assertion.rpId || getSignalRpId(), assertion.response.id);
            return { status: 'error', message: UNKNOWN_CREDENTIAL_MESSAGE, code };
        }
        if (code === errors.server.RATE_LIMIT_EXCEEDED) {
            return { status: 'error', message: "Too many attempts. Please wait a few minutes and try again.", code };
        }
        return { status: 'error', message: "Signing in with this passkey didn't work. Please try again.", code };
    }
}

function MainOriginPasskeyProvider(props: React.PropsWithChildren<{}>) {
    // features.passkeys: false = this instance has no passkeys at all
    const supported = useMemo(() => getAuthMode().passkeysOnOrigin && passkeysSupported(), []);
    const [autofillSupported, setAutofillSupported] = useState(false);
    const [busyCount, setBusyCount] = useState(0);

    useEffect(() => {
        if (!supported) {
            return;
        }
        let mounted = true;
        passkeyAutofillSupported().then(value => {
            if (mounted) setAutofillSupported(value);
        });
        return () => {
            mounted = false;
        };
    }, [supported]);

    const busy = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
        setBusyCount(count => count + 1);
        try {
            return await fn();
        }
        finally {
            setBusyCount(count => count - 1);
        }
    }, []);

    // modal ceremonies in flight: a conditional (autofill) request must not
    // start while one runs — it would cancel it
    const modalActive = useRef(0);
    const modal = useCallback(async <T,>(fn: () => Promise<T>): Promise<T> => {
        modalActive.current += 1;
        try {
            return await busy(fn);
        }
        finally {
            modalActive.current -= 1;
        }
    }, [busy]);

    const register = useCallback<PasskeyState['register']>((options = {}) => (options.useAutoRegister ? busy : modal)(async () => {
        if (!supported) {
            return { status: 'error', message: "This browser doesn't support passkeys." };
        }
        try {
            return { status: 'ok', result: await registerPasskey(options) };
        }
        catch (e) {
            return failure(e);
        }
    }), [busy, modal, supported]);

    const login = useCallback<PasskeyState['login']>(() => modal(async () => {
        if (!supported) {
            return { status: 'error', message: "This browser doesn't support passkeys." };
        }
        let assertion: Awaited<ReturnType<typeof authenticateWithPasskey>>;
        try {
            assertion = await authenticateWithPasskey('login');
        }
        catch (e) {
            return failure(e);
        }
        return loginWithAssertion(assertion);
    }), [modal, supported]);

    const autofillRun = useRef(0);
    const armAutofill = useCallback<PasskeyState['armAutofill']>((onLoggedIn, onEnded) => {
        if (!autofillSupported) {
            return () => undefined;
        }
        const run = ++autofillRun.current;
        let waiting = true;
        (async () => {
            let assertion: Awaited<ReturnType<typeof authenticateWithPasskey>>;
            try {
                assertion = await authenticateWithPasskey('login', {
                    conditional: true,
                    // fetching the options took a moment: don't start if a
                    // modal ceremony began or this request was disarmed
                    beforeStart: () => run === autofillRun.current && modalActive.current === 0,
                });
            }
            catch (e) {
                waiting = false;
                const error = toPasskeyCeremonyError(e);
                // replaced by a modal ceremony, disarmed, or not offered: quiet
                if (!error.silent && error.kind !== 'unsupported' && run === autofillRun.current) {
                    console.warn("Passkey autofill failed", e);
                    onEnded?.();
                }
                return;
            }
            waiting = false;
            const outcome = await busy(() => loginWithAssertion(assertion));
            if (outcome.status === 'ok') {
                onLoggedIn(outcome.result);
            }
            else if (outcome.status === 'error') {
                onEnded?.(outcome.message);
            }
        })();
        return () => {
            // only abort our own conditional request, not a modal ceremony
            // that already replaced it
            if (waiting && run === autofillRun.current) {
                abortPasskeyCeremony();
            }
        };
    }, [autofillSupported, busy]);

    const reauthenticate = useCallback<PasskeyState['reauthenticate']>(() => modal(async () => {
        if (!supported) {
            return { status: 'error', message: "This browser doesn't support passkeys." };
        }
        try {
            const assertion = await authenticateWithPasskey('stepup');
            const { validUntil } = await userApi.reauthenticate({ type: 'passkey', authenticationResponse: assertion.response });
            stepUpManager.markAuthenticated(validUntil);
            return { status: 'ok', result: validUntil };
        }
        catch (e) {
            const error = toPasskeyCeremonyError(e);
            if (error.serverCode === errors.server.NOT_FOUND) {
                return { status: 'error', message: "Your account has no passkey on this site yet.", code: error.serverCode };
            }
            return failure(e);
        }
    }), [modal, supported]);

    const value = useMemo<PasskeyState>(() => ({
        supported,
        autofillSupported,
        legacy: false,
        status: busyCount > 0 ? 'busy' : 'idle',
        register,
        login,
        armAutofill,
        reauthenticate,
    }), [supported, autofillSupported, busyCount, register, login, armAutofill, reauthenticate]);

    return <PasskeyContext.Provider value={value}>{props.children}</PasskeyContext.Provider>;
}

function LegacyPasskeyAdapter(props: React.PropsWithChildren<{}>) {
    const legacy = useLegacyCgIdPasskeyContext();
    const legacyLogin = legacy.loginWithPasskey;

    const login = useCallback<PasskeyState['login']>(async () => {
        try {
            const success = await legacyLogin();
            if (!success) {
                return { status: 'error', message: legacy.error || "Signing in with this passkey didn't work. Please try again." };
            }
            const result = await loginManager.login({ account: 'passkey-legacy' });
            return { status: 'ok', result };
        }
        catch (e) {
            if (e instanceof Error && e.message === "Cancelled by user") {
                return { status: 'cancelled' };
            }
            if (e instanceof Error && e.message === errors.server.PASSKEY_USER_NULL) {
                return { status: 'error', message: "This passkey doesn't belong to an account.", code: e.message };
            }
            return { status: 'error', message: "Signing in with this passkey didn't work. Please try again." };
        }
    }, [legacyLogin, legacy.error]);

    const value = useMemo<PasskeyState>(() => ({
        supported: legacy.passkeysSupported,
        autofillSupported: false,
        legacy: true,
        status: legacy.status === 'idle' ? 'idle' : 'busy',
        register: async () => unavailable,
        login,
        armAutofill: () => () => undefined,
        reauthenticate: async () => unavailable,
    }), [legacy.passkeysSupported, legacy.status, login]);

    return <PasskeyContext.Provider value={value}>{props.children}</PasskeyContext.Provider>;
}

export function PasskeyProvider(props: React.PropsWithChildren<{}>) {
    if (getAuthMode().legacyCgid) {
        return (
            <LegacyCgIdPasskeyProvider>
                <LegacyPasskeyAdapter>{props.children}</LegacyPasskeyAdapter>
            </LegacyCgIdPasskeyProvider>
        );
    }
    return <MainOriginPasskeyProvider>{props.children}</MainOriginPasskeyProvider>;
}

export function usePasskeyContext() {
    return React.useContext(PasskeyContext);
}
