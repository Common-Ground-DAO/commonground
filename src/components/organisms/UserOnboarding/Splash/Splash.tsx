// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import config from "common/config";
import { OnboardingStep, useUserOnboardingContext } from "context/UserOnboarding";
import SplashLoginActions, { LoginButtonType, LoginOption } from "./SplashLoginActions";

import { ReactComponent as CgLogoIcon } from 'components/atoms/icons/misc/Logo/logo.svg';
import './Splash.css';
import Button from "components/atoms/Button/Button";
import { usePasskeyContext } from "context/PasskeyProvider";
import { ArrowLeftCircleIcon } from "@heroicons/react/24/solid";
import { ReactComponent as FaceIdIcon } from './icons/faceId.svg';
import { ReactComponent as FingerPrintIcon } from './icons/fingerPrint.svg';
import { ReactComponent as ComputerIcon } from './icons/computerIcon.svg';
import { ReactComponent as PasskeyIcon } from './icons/passkeyIcon.svg';
import { ReactComponent as StopWatchIcon } from './icons/stopWatchIcon.svg';
import { AeternityStatus, AeternitySignButton } from "../AeternitySign/AeternitySign";
import { OnboardingEmailStatus, OnboardingEmailButton, type OnboardingEmailState } from "../OnboardingEmail/OnboardingEmail";
import { FuelStatus, FuelSignButton } from "../FuelSign/FuelSign";
import { LoginWithKeyPhraseStatus, LoginWithKeyPhraseButton } from "../LoginWithKeyPhrase/LoginWithKeyPhrase";
import { RainbowStatus, RainbowSignButton } from "../RainbowSign/RainbowSign";
import { UniversalProfileStatus, UniversalProfileSignButton } from "../UniversalProfileSign/UniversalProfileSign";
import { CreateUserStatus, CreateUserButton } from "../SetupProfile/SetupProfile";
import { PWAStatus, PWAInstallButton } from "../../../molecules/PWA/PWA";
import { handleLuksoError, handleTwitterError } from "../UniversalProfileSign/ErrorHandler";
import userApi from "data/api/user";
import loginManager from "data/appstate/login";
import errors from "common/errors";
import { useUniversalProfile } from "context/UniversalProfileProvider";
import luksoApi from "data/api/lukso";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import { useNotificationContext } from "context/NotificationProvider";
import TextInputField from "components/molecules/inputs/TextInputField/TextInputField";
import { validateEmailInput } from "common/validators";
import { Devices, Key, Timer } from "@phosphor-icons/react";
import newsletter1 from './imgs/newsletter1.webp';
import newsletter2 from './imgs/newsletter2.webp';
import push1 from './imgs/push1.webp';
import push2 from './imgs/push2.webp';
import { useEmailConfirmationContext } from "context/EmailConfirmationProvider";
import { FarcasterStatus } from "../FarcasterSign/FarcasterSign";

/*
import OnboardingPostOnX from "./OnboardingPostOnX/OnboardingPostOnX";
*/

const loginButtons: LoginButtonType[] = (['x', 'eth', 'lukso', 'farcaster', 'fuel', 'email', 'keyphrase'] as LoginButtonType[])
  .filter(b => b !== 'x' || config.TWITTER_AUTH_ENABLED);
const createButtons: LoginButtonType[] = (['x', 'eth', 'lukso', 'farcaster', 'fuel', 'email'] as LoginButtonType[])
  .filter(b => b !== 'x' || config.TWITTER_AUTH_ENABLED);

const Splash: React.FC = () => {
  const {
    step,
    setStep,
    setUserOnboardingVisibility,
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
    newsletterState,
    setNewsletterState,
    setFarcasterData,
  } = useUserOnboardingContext();
  const { createPasskey, loginWithPasskey, status: passkeyStatus, error: passkeyError, passkeysSupported } = usePasskeyContext();
  const { error: twitterOrUpError, setError: setTwitterOrUpError } = useUniversalProfile();
  const [twitterData, setTwitterData] = useState<API.Twitter.finishLogin.Response | undefined>();
  const [genericLoginError, setGenericLoginError] = useState<string | undefined>();
  const { isMobile } = useWindowSizeContext();
  const { pwaStatus, subscription, subscribeWebPush } = useNotificationContext();

  const [buttonsDisabled, setButtonsDisabled] = useState(false);
  const [selectedOption, setSelectedOption] = useState<LoginOption | null>(null);
  const [pushButtonLoading, setPushButtonLoading] = useState(false);
  const pushStepReachedRef = useRef(false);
  const emailContext = useEmailConfirmationContext();

  // if the subscription is null or the push step has
  // been reached, the push step should be shown
  if (step === 'enable-push' && !pushStepReachedRef.current) {
    pushStepReachedRef.current = true;
  }
  const withPushStep = useMemo(() => {
    return subscription === null || pushStepReachedRef.current;
  }, [subscription, pushStepReachedRef.current]);

  const withPwaStep = useMemo(() => {
    return isMobile && !(pwaStatus === "InMobilePWA" || pwaStatus === "OnDesktop");
  }, [isMobile, pwaStatus]);

  const loginFinished = useCallback(async (loginOptions: Parameters<typeof loginManager.login>[0]) => {
    setGenericLoginError(undefined);
    try {
      await loginManager.login(loginOptions);
      setStep('login-finished');
      setTimeout(() => {
        setUserOnboardingVisibility(false);
      }, 1400);
    }
    catch (e) {
      if (typeof e === 'string') {
        setGenericLoginError(e);
      }
      else if (e instanceof Error) {
        if (e.message === errors.server.PASSKEY_USER_NULL) {
          setCreateUserData(data => ({ ...data, usePreparedPasskey: true }));
          setStep('create-profile-setup');
        }
        else {
          setGenericLoginError(e.message);
        }
      }
      else {
        console.log("Error during login", e);
        setGenericLoginError("Something went wrong");
      }
    }
  }, [setStep, setUserOnboardingVisibility, setCreateUserData, setGenericLoginError]);

  const setLoginOption = useCallback((option: LoginOption) => {
    setSelectedOption(option);
    if (step === 'create-other') {
      setStep('create-other-option');
    }
    else if (step === 'login-other') {
      setStep('login-other-option');
    }
  }, [step, setStep, setSelectedOption]);

  const walletSignatureFinished = useCallback(async (data: API.User.prepareWalletAction.Request) => {
    const response = await userApi.prepareWalletAction(data);
    setWalletData({ request: data, response });
    if (response.readyForLogin && step === 'login-other-option') {
      loginFinished({ account: 'wallet' });
    }
    else if (response.readyForCreation && step === 'create-other-option') {
      setStep('create-profile-setup');
      setCreateUserData(data => ({ ...data, usePreparedWallet: true }));
    }
  }, [step, setStep, setWalletData, setCreateUserData, loginFinished]);

  const luksoSignatureFinished = useCallback(async (universalProfileData: API.Lukso.PrepareLuksoAction.Request) => {
    const response = await luksoApi.prepareLuksoAction(universalProfileData);
    if (response.readyForLogin === true) {
      try {
        await loginManager.login({ account: 'lukso' });
        setStep('login-finished');
        setTimeout(() => {
          setUserOnboardingVisibility(false);
        }, 1400);
      } catch (e: any) {
        console.error("Error in Lukso Login", e);
        setGenericLoginError("Error in Lukso Login");
      }
    } else if (response.readyForCreation === true) {
      setCreateUserData(data => ({ ...data, displayAccount: 'lukso', useLuksoCredentials: true }));
      setLuksoData(response);
      setStep('create-profile-setup');
    }}
    , [setStep, setUserOnboardingVisibility, setCreateUserData, setLuksoData]);

  const luksoReadyForLoginOverride = useCallback(() => {
    loginFinished({ account: 'lukso' });
  }, [loginFinished]);

  const luksoReadyForCreationOverride = useMemo(() => {
    if (step === "create-other-option") {
      return () => setStep('create-profile-setup');
    }
    return undefined;
  }, [step]);

  const farcasterLoginFinished = useCallback(async (data: API.Accounts.Farcaster.verifyLogin.Response) => {
    if (data.readyForLogin === true) {
      try {
        await loginManager.login({ account: 'farcaster' });
        setStep('login-finished');
        setTimeout(() => {
          setUserOnboardingVisibility(false);
        }, 1400);
      } catch (e: any) {
        console.log("Error in Farcaster Login", e);
        setGenericLoginError("Error in Farcaster Login");
      }
    }
    else if (data.readyForCreation === true) {
      setCreateUserData(data => ({ ...data, displayAccount: 'farcaster', usePreparedFarcaster: true }));
      setFarcasterData({
        fid: data.fid,
        displayName: data.displayName,
        username: data.username,
        bio: data.bio,
        url: data.url,
        imageId: data.imageId,
      });
      setStep('create-profile-setup');
    }
  }, [step, setStep, setUserOnboardingVisibility, setGenericLoginError, setCreateUserData]);

  const attemptTwitterLogin = useCallback(async (twitterData: API.Twitter.finishLogin.Response, noClearOrNavigate?: boolean) => {
    try {
      await loginManager.login({ account: 'twitter' });
      setStep('login-finished');
      setTimeout(() => {
        setUserOnboardingVisibility(false);
      }, 1400);
    } catch (e: any) {
      if (e.message === errors.server.ACCOUNT_DOES_NOT_EXIST) {
        setTwitterData(twitterData);
        setCreateUserData(data => ({ ...data, displayAccount: 'twitter', useTwitterCredentials: true }));
        setStep('create-profile-setup');
        // if (noClearOrNavigate) return;
        throw new Error('No account with that twitter account exists.');
      } else {
        handleTwitterError(e, setTwitterOrUpError);
        throw new Error('Something went wrong, please try again');
      }
    }
  }, [setStep, setTwitterData, setCreateUserData, setTwitterOrUpError]);

  const emailInputFinished = useCallback(async (data: { type: 'password' | 'code', email: string; password: string }) => {
    const { email, password } = data;
    if (step === 'login-other-option') {
      try {
        if (data.type === 'password') {
          await loginManager.login({ aliasOrEmail: email, password });
        }
        else {
          await loginManager.login({ email: email, code: password });
        }
        setStep('login-finished');
        setTimeout(() => {
          setUserOnboardingVisibility(false);
        }, 1400);
      } catch (e: any) {
        if (e.message === errors.server.NOT_FOUND) {
          setEmailState(state => ({ ...state, error: "This account does not exist." }));
        } else if (e.message === errors.server.NOT_ALLOWED) {
          setEmailState(state => ({ ...state, error: "This account exists, but the password is incorrect." }));
        } else {
          setEmailState(state => ({ ...state, error: 'Something went wrong, please try again' }));
        }
      }
    }
    else if (step === 'create-other-option') {
      setCreateUserData(data => ({ ...data, useEmailAndPassword: { email, password } }));
      setStep('create-profile-setup');
    }
  }, [step, setUserOnboardingVisibility, setEmailState, setCreateUserData, setStep]);

  const createPasskeyClick = useCallback(async () => {
    if (createUserData.usePreparedPasskey) {
      setStep('create-profile-setup');
      return;
    }
    setButtonsDisabled(true);
    try {
      const success = await createPasskey();
      if (success) {
        setCreateUserData(data => ({ ...data, usePreparedPasskey: true }));
        setStep('create-profile-setup');
      }
      else {
        console.error("Passkey creation failed");
      }
    } finally {
      setButtonsDisabled(false);
    }
  }, [createUserData.usePreparedPasskey, createPasskey, setCreateUserData, setStep]);

  const loginWithPasskeyClick = useCallback(async () => {
    setButtonsDisabled(true);
    try {
      const success = await loginWithPasskey();
      if (success) {
        console.log("Passkey login successful");
        loginFinished({ account: 'passkey' });
      }
      else {
        console.error("Passkey login failed");
      }
    } finally {
      setButtonsDisabled(false);
    }
  }, [loginWithPasskey, loginFinished]);

  const continueNewsletter = useCallback(async (activate = false) => {
    if (newsletterState.email && newsletterState.valid && (activate || (!emailState.email && !emailState.valid))) {
      setNewsletterState((state) => ({ ...state, loading: true, error: '' }));
      if (!emailState.valid) {
        const emailAvailable = await userApi.isEmailAvailable({ email: newsletterState.email });
        if (!emailAvailable) {
          setNewsletterState((state) => ({ ...state, loading: false, error: 'This email address is already in use' }));
          return;
        }
      }
      await userApi.updateOwnData({ newsletter: activate, email: newsletterState.email });
      setNewsletterState((state) => ({ ...state, loading: false }));
    }
    setStep(withPushStep ? 'enable-push' : withPwaStep ? 'install-pwa' : 'create-finished');
  }, [newsletterState.email, newsletterState.valid, emailState.email, emailState.valid, setStep, withPushStep, withPwaStep, setNewsletterState]);

  const clearData = useCallback(async () => {
    await userApi.clearLoginSession();

    setEmailState({ type: 'password', email: '', password: '', error: '', valid: false, loading: false });
    setCreateUserData({ displayAccount: 'cg' });
    setCreateUserButtonState({ loading: false, disabled: false, clicked: false });
    setLuksoData(undefined);
    setWalletData(undefined);
    setFarcasterData(undefined);
  }, [setCreateUserButtonState, setCreateUserData, setEmailState, setFarcasterData, setLuksoData, setWalletData]);

  let loginActionsType: 'login' | 'create' = 'login';
  if (step.startsWith('create')) {
    loginActionsType = 'create';
  }
  const loginActions = useMemo(() => {
    const availableButtons = loginActionsType === 'login' ? loginButtons : createButtons;
    return (
      <SplashLoginActions
        attemptTwitterLogin={attemptTwitterLogin}
        setLoginOption={setLoginOption}
        availableButtons={availableButtons}
      />
    );
  }, [loginActionsType, setLoginOption, attemptTwitterLogin]);

  const buttons = useMemo(() => {
    // step === "start"
    let primaryExists = true;
    let primaryDisabled = false;
    let primaryText = "Sign up";
    let primaryClick = () => {
      clearData().then(() => {
        setStep('create');
      });
    }
    let primaryLoading = false;
    let secondaryExists = true;
    let secondaryDisabled = false;
    let secondaryText = "Login";
    let secondaryClick = () => {
      clearData().then(() => {
        setStep('login');
      });
    }
    let secondaryLoading = false;

    if (step === "create") {
      primaryDisabled = secondaryDisabled = buttonsDisabled || step !== "create";
      primaryText = "Continue with passkey";
      primaryClick = () => createPasskeyClick();
      secondaryText = "Sign up with something else";
      secondaryClick = () => setStep('create-other');
    }
    else if (step === 'create-other') {
      primaryExists = false;
      secondaryText = "Login instead";
      secondaryClick = () => setStep('login-other');
    }
    else if (step === "login") {
      primaryDisabled = secondaryDisabled = buttonsDisabled || step !== "login";
      primaryText = "Continue with passkey";
      primaryClick = () => loginWithPasskeyClick();
      secondaryText = "Log in with something else";
      secondaryClick = () => setStep('login-other');
    }
    else if (step === 'login-other') {
      primaryExists = false;
      secondaryText = "Sign up instead";
      secondaryClick = () => setStep('create-other');
    }
    else if (step === "create-finished") {
      primaryText = "Start exploring";
      primaryClick = () => {
        setUserOnboardingVisibility(false);
      }
      secondaryExists = false;
    }
    else if (step === "enable-newsletter") {
      primaryText = "Turn on newsletters";
      primaryClick = () => continueNewsletter(true);
      primaryDisabled = !newsletterState.valid;
      primaryLoading = newsletterState.loading;
      secondaryText = "Not now";
      secondaryClick = () => continueNewsletter(false);
      secondaryLoading = newsletterState.loading;
      secondaryDisabled = newsletterState.loading;
    }
    else if (step === "enable-push") {
      primaryText = "Turn on Push Notifications";
      primaryClick = async () => {
        if (subscribeWebPush === undefined) return;
        setPushButtonLoading(true);
        try {
          await subscribeWebPush();
          setStep('create-finished');
        } finally {
          setPushButtonLoading(false);
        }
      };
      primaryExists = !!subscribeWebPush;
      primaryLoading = pushButtonLoading;
      secondaryText = "Not now";
      secondaryClick = () => setStep(withPwaStep ? 'install-pwa' : 'create-finished');
      secondaryDisabled = pushButtonLoading;
    }
    else if (step === "install-pwa") {
      return <>
        <PWAInstallButton />
        <Button
          key='splash-chip-button'
          className='splash-button'
          role='chip'
          text="Not now"
          onClick={() => setStep('create-finished')}
        />
      </>;
    }
    else if (step === 'create-other-option' || step === 'login-other-option') {
      if (selectedOption === 'keyphrase')
        return <LoginWithKeyPhraseButton success={() => loginFinished({ account: 'wallet' })} />;
      else if (selectedOption === 'rainbow')
        return <RainbowSignButton signatureFinished={walletSignatureFinished} step={step} setStep={setStep} loginFinished={loginFinished} walletData={walletData} />;
      else if (selectedOption === 'fuel')
        return <FuelSignButton signatureFinished={walletSignatureFinished} step={step} setStep={setStep} loginFinished={loginFinished} walletData={walletData} />;
      else if (selectedOption === 'aeternity')
        return <AeternitySignButton signatureFinished={walletSignatureFinished} step={step} setStep={setStep} loginFinished={loginFinished} walletData={walletData} />;
      else if (selectedOption === 'universal-profile')
        return <UniversalProfileSignButton signatureFinished={luksoSignatureFinished} step={step} luksoData={luksoData} readyForLoginOverride={luksoReadyForLoginOverride} readyForCreationOverride={luksoReadyForCreationOverride} />;
      else if (selectedOption === 'email-password')
        return <OnboardingEmailButton onSubmit={emailInputFinished} step={step} state={emailState} setState={setEmailState} text={step === 'create-other-option' ? 'Next' : 'Login'} />;
      else if (selectedOption === 'farcaster')
        return <></>;
    }
    else if (step === 'create-profile-setup') {
      return <CreateUserButton buttonState={createUserButtonState} setButtonState={setCreateUserButtonState} />;
    }
    return <>
      {step === 'login' && (
        !!genericLoginError
        ? <div className="cg-text-md-400 w-full text-center mb-1 text-palette-error-600">{genericLoginError}</div>
        : <div className="cg-text-md-400 cg-text-secondary w-full text-center mb-1">A new window will open</div>
      )}
      {step === 'create' && <div className="cg-text-md-400 cg-text-secondary w-full text-center mb-1">A new window will open</div>}
      {!emailState.valid && step === 'enable-newsletter' && <div className="cg-text-md-400 cg-text-secondary w-full text-center mb-1">Add your email to continue</div>}
      {step === 'enable-push' && <div className="cg-text-md-400 cg-text-secondary w-full text-center mb-1">You’ll be asked to enable push notifications</div>}
      {secondaryExists && <Button
        key='splash-chip-button'
        className='splash-button'
        role='chip'
        text={secondaryText}
        disabled={secondaryDisabled}
        onClick={secondaryClick}
        loading={secondaryLoading}
      />}
      {primaryExists && <Button
        key='splash-primary-button'
        className='splash-button'
        role='primary'
        text={primaryText}
        disabled={primaryDisabled}
        onClick={primaryClick}
        loading={primaryLoading}
      />}
    </>;
  }, [step, setStep, buttonsDisabled, createPasskeyClick, loginWithPasskeyClick, setUserOnboardingVisibility, newsletterState.valid, newsletterState.loading, continueNewsletter, subscribeWebPush, pushButtonLoading, withPwaStep, selectedOption, walletSignatureFinished, loginFinished, walletData, luksoSignatureFinished, luksoData, emailInputFinished, emailState, setEmailState, createUserButtonState, setCreateUserButtonState, genericLoginError]);

  // render all components that are visible or could
  // become visible in the next or previous step
  const renderedStepItems = useMemo(() => {
    console.log('step', step);
    const components: JSX.Element[] = [];

    if (step === 'start' || step === 'login' || step === 'create') {
      let itemStep = 0;
      if (step !== 'start') {
        itemStep = 1;
      }
      components.push(
        <div className={`uob-splash-start uob-splash-start-step-${itemStep}`}>
          <div className={`uob-splash-logo uob-splash-logo-blue`}>
            <CgLogoIcon />
          </div>
          <div className='cg-heading-2 mt-6'>Common Ground</div>
          <div className='cg-heading-3 mt-6'>the onchain social network</div>
          <div className='cg-heading-3'>where you matter.</div>
        </div>
      );
    }

    // Login type selection
    if (step === 'start' || step === 'login' || step === 'login-other') {
      let itemStep = 0;
      if (step === 'login') {
        itemStep = 1;
      }
      else if (step === 'login-other') {
        itemStep = 2;
      }
      const className = `uob-splash-top uob-splash-login-or-create uob-splash-login-or-create-step-${itemStep} cg-text-main`;
      components.push(
        <div key='splash-login-content' className={className}>
          <PasskeyHeader title="Login with Passkey" />
          <div className="grid grid-flow-row gap-1">
            <div className="grid grid-flow-col justify-start gap-2 cg-text-main cg-text-lg-500">
              <Timer className='w-6 h-6 cg-text-secondary' weight="duotone" />
              <span>Set up in seconds</span>
            </div>
            <div className="grid grid-flow-col justify-start gap-2 cg-text-main cg-text-lg-500">
              <Key className='w-6 h-6 cg-text-secondary' weight="duotone" />
              <span>Safer than passwords</span>
            </div>
            <div className="grid grid-flow-col justify-start gap-2 cg-text-main cg-text-lg-500">
              <Devices className='w-6 h-6 cg-text-secondary' weight="duotone" />
              <span>Login with Passkey on any device</span>
            </div>
          </div>
        </div>
      );
    }

    // Create type selection
    if (step === 'start' || step === 'create' || step === 'create-other') {
      let itemStep = 0;
      if (step === 'create') {
        itemStep = 1;
      }
      else if (step === 'create-other') {
        itemStep = 2;
      }
      const className = `uob-splash-top uob-splash-login-or-create uob-splash-login-or-create-step-${itemStep} cg-text-main`;
      components.push(
        <div key='splash-create-content' className={className}>
          <PasskeyHeader title="Sign up with Passkey" />
          <div className="grid grid-flow-row gap-1">
            <div className="grid grid-flow-col justify-start gap-2 cg-text-main cg-text-lg-500">
              <Timer className='w-6 h-6 cg-text-secondary' weight="duotone" />
              <span>Set up in seconds</span>
            </div>
            <div className="grid grid-flow-col justify-start gap-2 cg-text-main cg-text-lg-500">
              <Key className='w-6 h-6 cg-text-secondary' weight="duotone" />
              <span>Safer than passwords</span>
            </div>
            <div className="grid grid-flow-col justify-start gap-2 cg-text-main cg-text-lg-500">
              <Devices className='w-6 h-6 cg-text-secondary' weight="duotone" />
              <span>Login with Passkey on any device</span>
            </div>
          </div>
        </div>
      );
    }

    // Login or create with other method
    if (step === 'create' || step === 'login' || step === 'create-other' || step === 'login-other' || step === 'create-other-option' || step === 'login-other-option') {
      let itemStep = 0;
      if (step === 'create-other' || step === 'login-other') {
        itemStep = 1;
      }
      else if (step === 'create-other-option' || step === 'login-other-option') {
        itemStep = 2;
      }
      const className = `uob-splash-item uob-splash-item-step-${itemStep}`;
      components.push(
        <div key='splash-login-option-select' className={className}>
          <div className="grid grid-flow-row gap-2 text-center">
            <span className="cg-heading-2">{step === 'create-other' ? 'Sign up': 'Login'}</span>
            <span className="cg-text-lg-500 cg-text-secondary">Pick your method of choice to continue</span>
          </div>
          {loginActions}
        </div>
      );
    }

    // Login or create with other method - actual option
    if (step === 'create-other' || step === 'login-other' || step === 'create-other-option' || step === 'login-other-option' || step === 'login-finished' || step === 'create-profile-setup') {
      let itemStep = 0;
      if (step === 'create-other-option' || step === 'login-other-option') {
        itemStep = 1;
      }
      else if (step === 'login-finished' || step === 'create-profile-setup') {
        itemStep = 2;
      }

      let innerComponent: JSX.Element | null = null;
      if (step === 'create-other-option' || step === 'login-other-option' || step === 'create-profile-setup' || step === 'login-finished') {
        // render inner component in the steps where it is visible
        // in the beginning of the animation
        switch (selectedOption) {
          case 'rainbow':
            innerComponent = <RainbowStatus step={step} setStep={setStep} walletData={walletData} />;
            break;
          case 'fuel':
            innerComponent = <FuelStatus step={step} setStep={setStep} walletData={walletData} />;
            break;
          case 'aeternity':
            innerComponent = <AeternityStatus step={step} setStep={setStep} walletData={walletData} />;
            break;
          case 'keyphrase':
            innerComponent = <LoginWithKeyPhraseStatus />;
            break;
          case 'universal-profile':
            innerComponent = <UniversalProfileStatus />;
            break;
          case 'email-password':
            innerComponent = <OnboardingEmailStatus step={step} onSubmit={emailInputFinished} state={emailState} setState={setEmailState} />;
            break;
          case 'farcaster':
            innerComponent = <FarcasterStatus step={step} loginFinished={farcasterLoginFinished} />
            break;
          default:
            innerComponent = <div>Unknown option: {selectedOption}</div>
            break;
        }
      }
      const className = `uob-splash-item uob-splash-item-step-${itemStep}`;
      components.push(
        <div key='splash-login-option-fill' className={className}>
          {selectedOption !== 'farcaster' && selectedOption !== 'keyphrase' && selectedOption !== 'email-password' && <div className="cg-heading-2 my-6">{step.startsWith('create') ? 'Set up' : 'Choose'} login method</div>}
          {innerComponent}
        </div>
      );
    }

    // Login finished
    if (step === 'login' || step === 'login-other' || step === 'login-other-option' || step === 'login-finished') {
      let itemStep = 0;
      if (step === 'login-finished') {
        itemStep = 1;
      }
      const className = `uob-splash-item uob-splash-end uob-splash-item-step-${itemStep}`;
      components.push(
        <div key='splash-login-finished' className={className}>
          <div className={`uob-splash-logo uob-splash-logo-blue`}>
            <CgLogoIcon />
          </div>
          <div className='cg-heading-2 mt-6'>Welcome back</div>
        </div>
      );
    }

    // Account creation
    if (step === 'create-other-option' || step === 'create-profile-setup' || step === 'enable-newsletter') {
      let itemStep = 0;
      if (step === 'create-profile-setup') {
        itemStep = 1;
      }
      else if (step === 'enable-newsletter') {
        itemStep = 2;
      }
      const className = `uob-splash-item uob-splash-item-step-${itemStep}`;
      components.push(
        <div key='splash-create-profile' className={className} style={{ gridTemplateRows: '1fr' }}>
          <CreateUserStatus
            createUserData={createUserData}
            setCreateUserData={setCreateUserData}
            buttonState={createUserButtonState}
            setButtonState={setCreateUserButtonState}
            luksoData={luksoData}
            twitterData={twitterData}
            attemptTwitterLogin={attemptTwitterLogin}
            luksoSignatureFinished={luksoSignatureFinished}
            luksoReadyForLoginOverride={luksoReadyForLoginOverride}
            luksoReadyForCreationOverride={luksoReadyForCreationOverride}
            createFinished={() => {
              if (emailState.valid === true && !!emailState.email && !newsletterState.email) {
                setNewsletterState(state => ({ ...state, email: emailState.email, valid: true, loading: false }));
              }
              setStep('enable-newsletter');
            }}
          />
        </div>
      );
    }

    // Enable Newsletter
    if (step === 'create-profile-setup' || step === 'enable-newsletter' || step === 'install-pwa' || step === 'enable-push' || step === 'create-finished') {
      let itemStep = 0;
      if (step === 'enable-newsletter') {
        itemStep = 1;
      }
      else if (step !== 'create-profile-setup') {
        itemStep = 2;
      }
      const className = `uob-splash-item uob-splash-item-step-${itemStep}`;
      components.push(
        <div key='splash-enable-newsletter' className={className}>
          <img src={newsletter1} alt='newsletter' className="uob-image" />
          <div className="cg-heading-2 pb-4 text-center">Stay up to date with your communities</div>
          {!emailState.valid && <TextInputField
            value={newsletterState.email}
            onChange={email => setNewsletterState(state => ({ ...state, email, valid: validateEmailInput(email) === undefined, error: '' }))}
            placeholder="your@email.com"
            inputClassName="cg-heading-3"
          />}
          {!!newsletterState.error && <div className="cg-text-sm-400 text-palette-error-700 mt-4">{newsletterState.error}</div>}
        </div>
      );
    }

    // Notifications
    if (withPushStep && (step === 'enable-newsletter' || step === 'enable-push' || step === 'install-pwa' || step === 'create-finished')) {
      let itemStep = 0;
      if (step === 'enable-push') {
        itemStep = 1;
      }
      else if (step === 'install-pwa' || step === 'create-finished') {
        itemStep = 2;
      }
      const className = `uob-splash-item uob-splash-item-step-${itemStep}`;
      components.push(
        <div key='splash-webpush-step' className={className}>
          <img src={push1} alt='newsletter' className="uob-image-top" />
          <img src={push2} alt='newsletter' className="uob-image" />
          <div className="cg-heading-2 pb-4 text-center">Never miss a reply</div>
        </div>
      );
    }

    // PWA
    if (withPwaStep && (step === 'enable-newsletter' || step === 'enable-push' || step === 'install-pwa' || step === 'create-finished')) {
      let itemStep = 0;
      if (step === 'install-pwa') {
        itemStep = 1;
      }
      else if (step === 'create-finished') {
        itemStep = 2;
      }
      const className = `uob-splash-item uob-splash-item-step-${itemStep}`;
      components.push(
        <div key='splash-pwa-step' className={className}>
          <img src={newsletter2} alt='newsletter' className="uob-image" />
          <PWAStatus />
        </div>
      );
    }

    // Create finished
    if (step === 'enable-newsletter' || step === 'enable-push' || step === 'install-pwa' || step === 'create-finished') {
      let itemStep = 0;
      if (step === 'create-finished') {
        itemStep = 1;
      }
      const className = `uob-splash-item uob-splash-end uob-splash-item-step-${itemStep}`;
      components.push(
        <div key='splash-create-finished' className={className}>
          <div className={`uob-splash-logo uob-splash-logo-blue`}>
            <CgLogoIcon />
          </div>
          <div className='cg-heading-2 mt-6'>Welcome on Common Ground</div>
          <div className='cg-heading-3 mt-6'>Your journey has just begun</div>
        </div>
      );
    }

    return components;
  }, [step, withPushStep, withPwaStep, loginActions, selectedOption, setStep, walletData, emailInputFinished, emailState, setEmailState, createUserData, setCreateUserData, createUserButtonState, setCreateUserButtonState, luksoData, twitterData, attemptTwitterLogin, luksoSignatureFinished, newsletterState, setNewsletterState]);

  const goBack = useCallback(() => {
    if (step === 'login' || step === 'create')
      setStep('start');
    else if (step === "create-other")
      setStep('create');
    else if (step === "login-other")
      setStep('login');
    else if (step === "create-other-option")
      setStep('create-other');
    else if (step === "login-other-option")
      setStep('login-other');
    else if (step === 'create-profile-setup') {
      if (selectedOption)
        setStep('create-other-option')
      else
        setStep('create');
    }
  }, [step, setStep, selectedOption]);

  // evaluate visibilities
  let showBackButton = true;
  let showButtons = true;
  let gradientStyle: 'full-top' | 'small-top' | 'hidden-left' | 'hidden-right' = 'hidden-right';
  if (step === 'start') {
    showBackButton = false;
    gradientStyle = 'full-top';
  }
  if (step === 'create' || step === 'create-other' || step === 'create-other-option' || step === 'login' || step === 'login-other' || step === 'login-other-option') {
    gradientStyle = 'small-top';
  }
  if (step === 'create-profile-setup') {
    gradientStyle = 'hidden-left';
  }
  if (step === 'create-profile-setup' || step === 'enable-newsletter' || step === 'enable-push' || step === 'install-pwa' || step === 'login-finished' || step === 'create-finished') {
    showBackButton = step === 'create-profile-setup';
  }
  if (step === 'login-finished') {
    showButtons = false;
  }
  if (step === 'login-finished' || step === 'create-finished') {
    gradientStyle = 'full-top';
  }

  return (<div className={`uob-splash uob-splash-gradient-${gradientStyle} uob-${step}`}>
    <div className={`uob-splash-top uob-splash-back-button ${showBackButton ? '' : 'uob-splash-back-button-hidden'}`} onClick={() => goBack()}>
      <ArrowLeftCircleIcon />
    </div>
    {renderedStepItems}
    <div className={`uob-splash-bottom uob-splash-buttons`}>
      {showButtons ? buttons : null}
    </div>
  </div>);
}

const PasskeyHeader = ({ title }: { title: string }) => {
  return <div className="grid grid-flow-row gap-6">
    <div className='grid grid-flow-col items-center justify-center gap-1'>
      <FaceIdIcon />
      <FingerPrintIcon />
    </div>
    <div className='cg-heading-2 mt-6'>{title}</div>
  </div>;
}

export default Splash;
