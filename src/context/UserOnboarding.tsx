// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { ReactNode, useCallback, useEffect, useState } from "react";
import { useOwnUser } from "./OwnDataProvider";
import { useNotificationContext } from "./NotificationProvider";
import loginManager from "data/appstate/login";
import { useConnectionContext } from "./ConnectionProvider";
import { type OnboardingEmailState } from "components/organisms/UserOnboarding/OnboardingEmail/OnboardingEmail";
import useLocalStorage from "hooks/useLocalStorage";
import { useSnackbarContext } from "./SnackbarContext";

export type OnboardingStep =
    'start' |

    /* create state order */
    'create' |
    'create-other' |
    'create-other-option' |
    'create-profile-setup' |
    /* situational extra states here */
    'create-finished' |

    /* login state order */
    'login' |
    'login-other' |
    'login-other-option' |
    /* situational extra states here */
    'login-finished' |
    
    /* extra states */
    'enable-newsletter' |
    'enable-push' |
    'post-on-x' |
    'install-pwa';

export type OnboardingWalletData = {
    request: API.User.prepareWalletAction.Request;
    response: API.User.prepareWalletAction.Response;
};

export type FarcasterData = {
    fid: number;
    displayName: string;
    username: string;
    url?: string;
    bio?: string;
    imageId: string | null;
}

type UserOnboardingState = {
    isUserOnboardingComplete: boolean;
    isUserOnboardingVisible: boolean;
    setUserOnboardingVisibility: (visible: boolean) => void;
    step: OnboardingStep
    setStep: (state: OnboardingStep) => void;
    emailState: OnboardingEmailState;
    setEmailState: React.Dispatch<React.SetStateAction<OnboardingEmailState>>;
    createUserData: Omit<API.User.createUser.Request, 'device' | 'recaptchaToken'>;
    setCreateUserData: React.Dispatch<React.SetStateAction<Omit<API.User.createUser.Request, 'device' | 'recaptchaToken'>>>;
    createUserButtonState: { loading: boolean; disabled: boolean; clicked: boolean };
    setCreateUserButtonState: React.Dispatch<React.SetStateAction<{ loading: boolean; disabled: boolean; clicked: boolean }>>;
    luksoData: API.Lukso.PrepareLuksoAction.Response | undefined;
    setLuksoData: React.Dispatch<React.SetStateAction<API.Lukso.PrepareLuksoAction.Response | undefined>>;
    walletData: OnboardingWalletData | undefined;
    setWalletData: React.Dispatch<React.SetStateAction<OnboardingWalletData | undefined>>;
    farcasterData: FarcasterData | undefined;
    setFarcasterData: React.Dispatch<React.SetStateAction<FarcasterData | undefined>>;
    newsletterState: { email: string; loading: boolean; valid: boolean; error: string };
    setNewsletterState: React.Dispatch<React.SetStateAction<{ email: string; loading: boolean; valid: boolean; error: string }>>;
    profileLockedIn: boolean;
    setProfileLockedIn: React.Dispatch<React.SetStateAction<boolean>>;
}

export const UserOnboardingContext = React.createContext<UserOnboardingState>({
    isUserOnboardingComplete: false,
    isUserOnboardingVisible: false,
    setUserOnboardingVisibility: () => { },
    step: 'start',
    setStep: () => { },
    emailState: { type: 'password', email: '', password: '', error: '', valid: false, loading: false },
    setEmailState: () => { },
    createUserData: null as any,
    setCreateUserData: () => { },
    createUserButtonState: { loading: false, disabled: false, clicked: false },
    setCreateUserButtonState: () => { },
    luksoData: undefined,
    setLuksoData: () => { },
    walletData: undefined,
    setWalletData: () => { },
    farcasterData: undefined,
    setFarcasterData: () => { },
    newsletterState: { email: '', loading: false, valid: false, error: '' },
    setNewsletterState: () => { },
    profileLockedIn: false,
    setProfileLockedIn: () => { },
});

const initiallyLoggedIn = loginManager.currentUser !== null;

const defaultUserData: Omit<API.User.createUser.Request, 'device' | 'recaptchaToken'> = {
    displayAccount: 'cg',
};
const defaultEmailState: OnboardingEmailState = { type: 'password', email: '', password: '', error: '', valid: false, loading: false };
const defaultCreateUserButtonState = { loading: false, disabled: false, clicked: false };
const defaultNewsletterState = { email: '', loading: false, valid: false, error: '' };

export function UserOnboardingProvider(props: { children: ReactNode }) {
    const { pwaStatus } = useNotificationContext();
    const { webSocketState, finishInstallation, finishInstallationTriggered, serviceWorkerState } = useConnectionContext();
    const [isModalVisible, setIsModalVisible] = useState<boolean>(!initiallyLoggedIn && pwaStatus === 'InMobilePWA');
    const [step, setStep] = useState<OnboardingStep>('start');
    const ownUser = useOwnUser();

    const [emailState, setEmailState] = useState<OnboardingEmailState>(defaultEmailState);
    const [createUserData, setCreateUserData] = useState<Omit<API.User.createUser.Request, 'device' | 'recaptchaToken'>>(defaultUserData);
    const [createUserButtonState, setCreateUserButtonState] = useState(defaultCreateUserButtonState);
    const [luksoData, setLuksoData] = useState<API.Lukso.PrepareLuksoAction.Response | undefined>();
    const [walletData, setWalletData] = useState<OnboardingWalletData | undefined>();
    const [newsletterState, setNewsletterState] = useState(defaultNewsletterState);
    const [profileLockedIn, setProfileLockedIn] = useState<boolean>(false);
    const [farcasterData, setFarcasterData] = useState<FarcasterData | undefined>();
    const [emailConfirmationOpened, setEmailConfirmationOpened] = useLocalStorage('', 'emailConfirmation');
    const { showSnackbar } = useSnackbarContext();

    useEffect(() => {
        if (webSocketState === 'version-update' && isModalVisible && !finishInstallationTriggered && serviceWorkerState === 'updated') {
            finishInstallation();
        }
    }, [webSocketState, isModalVisible, finishInstallationTriggered, finishInstallation, serviceWorkerState]);

    const setUserOnboardingVisibility = useCallback((visible: boolean) => {
        if (visible && !isModalVisible) {
            setStep('start');
            setCreateUserButtonState(defaultCreateUserButtonState);
            setEmailState(defaultEmailState);
            setCreateUserData(defaultUserData);
            setLuksoData(undefined);
            setWalletData(undefined);
            setNewsletterState(defaultNewsletterState);
            setProfileLockedIn(false);
        }
        setIsModalVisible(visible);
        if (!visible) {
            // hide email confirmation modal if the user has just onboarded
            setEmailConfirmationOpened('opened');
            if (ownUser && !!createUserData.useEmailAndPassword) {
              showSnackbar({ type: 'warning', text: `We've sent you an email with a verification link, please check your inbox` });
            }
        }
    }, [createUserData.useEmailAndPassword, isModalVisible, ownUser, setEmailConfirmationOpened, showSnackbar]);

    return (
        <UserOnboardingContext.Provider value={{
            isUserOnboardingComplete: ownUser?.finishedTutorials?.includes('onboarding') || false,
            isUserOnboardingVisible: isModalVisible,
            setUserOnboardingVisibility,
            step,
            setStep,
            emailState,
            setEmailState,
            createUserData,
            setCreateUserData,
            createUserButtonState,
            setCreateUserButtonState,
            luksoData,
            setLuksoData,
            walletData,
            setWalletData,
            farcasterData,
            setFarcasterData,
            newsletterState,
            setNewsletterState,
            profileLockedIn,
            setProfileLockedIn,
        }}>
          {props.children}
        </UserOnboardingContext.Provider>
    );
}

export function useUserOnboardingContext() {
    const context = React.useContext(UserOnboardingContext);
    return context;
}
