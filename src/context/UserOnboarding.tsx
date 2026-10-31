// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { ReactNode, useCallback, useEffect, useState } from "react";
import { useOwnUser } from "./OwnDataProvider";
import { useNotificationContext } from "./NotificationProvider";
import loginManager from "data/appstate/login";
import { useConnectionContext } from "./ConnectionProvider";
import useLocalStorage from "hooks/useLocalStorage";

/**
 * The onboarding modal (UserOnboarding): `start` shows the login / sign-up
 * flow (AuthFlow); the rest are the steps after it — "Welcome back" after a
 * login, and newsletter, push notifications, PWA install and "finished"
 * after a sign-up.
 */
export type OnboardingStep =
    'start' |
    'login-finished' |
    'enable-newsletter' |
    'enable-push' |
    'install-pwa' |
    'create-finished';

export type NewsletterState = { email: string; loading: boolean; valid: boolean; error: string };

type UserOnboardingState = {
    isUserOnboardingComplete: boolean;
    isUserOnboardingVisible: boolean;
    setUserOnboardingVisibility: (visible: boolean) => void;
    step: OnboardingStep
    setStep: (state: OnboardingStep) => void;
    /** after a sign-up outside the modal (/login): show the tail steps */
    continueAfterSignup: (email: string | null) => void;
    newsletterState: NewsletterState;
    setNewsletterState: React.Dispatch<React.SetStateAction<NewsletterState>>;
}

const defaultNewsletterState: NewsletterState = { email: '', loading: false, valid: false, error: '' };

export const UserOnboardingContext = React.createContext<UserOnboardingState>({
    isUserOnboardingComplete: false,
    isUserOnboardingVisible: false,
    setUserOnboardingVisibility: () => { },
    step: 'start',
    setStep: () => { },
    continueAfterSignup: () => { },
    newsletterState: defaultNewsletterState,
    setNewsletterState: () => { },
});

const initiallyLoggedIn = loginManager.currentUser !== null;

export function UserOnboardingProvider(props: { children: ReactNode }) {
    const { pwaStatus } = useNotificationContext();
    const { webSocketState, finishInstallation, finishInstallationTriggered, serviceWorkerState } = useConnectionContext();
    const [isModalVisible, setIsModalVisible] = useState<boolean>(!initiallyLoggedIn && pwaStatus === 'InMobilePWA');
    const [step, setStep] = useState<OnboardingStep>('start');
    const ownUser = useOwnUser();
    const [newsletterState, setNewsletterState] = useState<NewsletterState>(defaultNewsletterState);
    const [, setEmailConfirmationOpened] = useLocalStorage('', 'emailConfirmation');

    useEffect(() => {
        if (webSocketState === 'version-update' && isModalVisible && !finishInstallationTriggered && serviceWorkerState === 'updated') {
            finishInstallation();
        }
    }, [webSocketState, isModalVisible, finishInstallationTriggered, finishInstallation, serviceWorkerState]);

    const setUserOnboardingVisibility = useCallback((visible: boolean) => {
        if (visible && !isModalVisible) {
            setStep('start');
            setNewsletterState(defaultNewsletterState);
        }
        setIsModalVisible(visible);
        if (!visible) {
            // hide email confirmation modal if the user has just onboarded
            setEmailConfirmationOpened('opened');
        }
    }, [isModalVisible, setEmailConfirmationOpened]);

    const continueAfterSignup = useCallback((email: string | null) => {
        setNewsletterState({ ...defaultNewsletterState, email: email || '', valid: !!email });
        setStep('enable-newsletter');
        setIsModalVisible(true);
    }, []);

    return (
        <UserOnboardingContext.Provider value={{
            isUserOnboardingComplete: ownUser?.finishedTutorials?.includes('onboarding') || false,
            isUserOnboardingVisible: isModalVisible,
            setUserOnboardingVisibility,
            step,
            setStep,
            continueAfterSignup,
            newsletterState,
            setNewsletterState,
        }}>
          {props.children}
        </UserOnboardingContext.Provider>
    );
}

export function useUserOnboardingContext() {
    const context = React.useContext(UserOnboardingContext);
    return context;
}
