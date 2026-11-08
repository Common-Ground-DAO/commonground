// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo, useRef, useState } from "react";
import { useUserOnboardingContext } from "context/UserOnboarding";

import CgLogoIcon from 'components/atoms/icons/misc/Logo/logo.svg?react';
import './Splash.css';
import Button from "components/atoms/Button/Button";
import { PWAStatus, PWAInstallButton } from "../../../molecules/PWA/PWA";
import userApi from "data/api/user";
import data from "data";
import { useOwnUser } from "context/OwnDataProvider";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import { useNotificationContext } from "context/NotificationProvider";
import TextInputField from "components/molecules/inputs/TextInputField/TextInputField";
import { validateEmailInput } from "common/validators";
import config from "common/config";
import newsletter1 from './imgs/newsletter1.webp';
import newsletter2 from './imgs/newsletter2.webp';
import push1 from './imgs/push1.webp';
import push2 from './imgs/push2.webp';

/**
 * The onboarding steps after the login / sign-up flow (AuthFlow): "Welcome
 * back" after a login; newsletter, push notifications, PWA install and
 * "finished" after a sign-up. The steps slide in from the right.
 */
const Splash: React.FC = () => {
  const {
    step,
    setStep,
    setUserOnboardingVisibility,
    newsletterState,
    setNewsletterState,
  } = useUserOnboardingContext();
  const ownUser = useOwnUser();
  const { isMobile } = useWindowSizeContext();
  const { pwaStatus, subscription, subscribeWebPush } = useNotificationContext();
  const [pushButtonLoading, setPushButtonLoading] = useState(false);
  const pushStepReachedRef = useRef(false);
  // the account got its (verified) address at sign-up: no need to ask again
  const accountEmail = ownUser?.email || null;

  // if the subscription is null or the push step has
  // been reached, the push step should be shown
  if (step === 'enable-push' && !pushStepReachedRef.current) {
    pushStepReachedRef.current = true;
  }
  const withPushStep = subscription === null || pushStepReachedRef.current;

  const withPwaStep = useMemo(() => {
    return isMobile && !(pwaStatus === "InMobilePWA" || pwaStatus === "OnDesktop");
  }, [isMobile, pwaStatus]);

  const continueNewsletter = useCallback(async (activate: boolean) => {
    if (activate) {
      setNewsletterState((state) => ({ ...state, loading: true, error: '' }));
      try {
        if (accountEmail) {
          await data.user.updateOwnData({ newsletter: true });
        }
        else {
          if (!newsletterState.valid) {
            setNewsletterState((state) => ({ ...state, loading: false }));
            return;
          }
          if (config.EMAIL_ENABLED) {
            // the address becomes the account's address once it is confirmed
            await userApi.requestEmailVerification({ email: newsletterState.email });
            await data.user.updateOwnData({ newsletter: true });
          }
          else {
            const emailAvailable = await userApi.isEmailAvailable({ email: newsletterState.email });
            if (!emailAvailable) {
              setNewsletterState((state) => ({ ...state, loading: false, error: 'This email address is already in use' }));
              return;
            }
            await data.user.updateOwnData({ newsletter: true, email: newsletterState.email });
          }
        }
      }
      catch (e) {
        console.error("Could not turn on newsletters", e);
        setNewsletterState((state) => ({ ...state, loading: false, error: 'Something went wrong, please try again' }));
        return;
      }
      setNewsletterState((state) => ({ ...state, loading: false }));
    }
    setStep(withPushStep ? 'enable-push' : withPwaStep ? 'install-pwa' : 'create-finished');
  }, [accountEmail, newsletterState.email, newsletterState.valid, setStep, withPushStep, withPwaStep, setNewsletterState]);

  const buttons = useMemo(() => {
    if (step === "install-pwa") {
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

    let primaryExists = true;
    let primaryDisabled = false;
    let primaryText = "";
    let primaryClick: () => void = () => undefined;
    let primaryLoading = false;
    let secondaryExists = true;
    let secondaryDisabled = false;
    let secondaryText = "";
    let secondaryClick: () => void = () => undefined;

    if (step === "create-finished") {
      primaryText = "Start exploring";
      primaryClick = () => setUserOnboardingVisibility(false);
      secondaryExists = false;
    }
    else if (step === "enable-newsletter") {
      primaryText = "Turn on newsletters";
      primaryClick = () => continueNewsletter(true);
      primaryDisabled = !accountEmail && !newsletterState.valid;
      primaryLoading = newsletterState.loading;
      secondaryText = "Not now";
      secondaryClick = () => continueNewsletter(false);
      secondaryDisabled = newsletterState.loading;
    }
    else if (step === "enable-push") {
      primaryText = "Turn on Push Notifications";
      primaryClick = async () => {
        if (subscribeWebPush === undefined) return;
        setPushButtonLoading(true);
        try {
          await subscribeWebPush();
          setStep(withPwaStep ? 'install-pwa' : 'create-finished');
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
    else {
      return null;
    }

    return <>
      {!accountEmail && !newsletterState.valid && step === 'enable-newsletter' && <div className="cg-text-md-400 cg-text-secondary w-full text-center mb-1">Add your email to continue</div>}
      {step === 'enable-push' && <div className="cg-text-md-400 cg-text-secondary w-full text-center mb-1">You’ll be asked to enable push notifications</div>}
      {secondaryExists && <Button
        key='splash-chip-button'
        className='splash-button'
        role='chip'
        text={secondaryText}
        disabled={secondaryDisabled}
        onClick={secondaryClick}
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
  }, [step, setStep, setUserOnboardingVisibility, accountEmail, newsletterState.valid, newsletterState.loading, continueNewsletter, subscribeWebPush, pushButtonLoading, withPwaStep]);

  // render all components that are visible or could
  // become visible in the next or previous step
  const renderedStepItems = useMemo(() => {
    const components: React.JSX.Element[] = [];

    if (step === 'login-finished') {
      components.push(
        <div key='splash-login-finished' className='uob-splash-item uob-splash-end uob-splash-item-step-1'>
          <div className={`uob-splash-logo uob-splash-logo-blue`}>
            <CgLogoIcon />
          </div>
          <div className='cg-heading-2 mt-6'>Welcome back</div>
        </div>
      );
      return components;
    }

    // Enable Newsletter
    {
      const itemStep = step === 'enable-newsletter' ? 1 : 2;
      components.push(
        <div key='splash-enable-newsletter' className={`uob-splash-item uob-splash-item-step-${itemStep}`}>
          <img src={newsletter1} alt='newsletter' className="uob-image" />
          <div className="cg-heading-2 pb-4 text-center">Stay up to date with your communities</div>
          {!!accountEmail && <div className="cg-text-md-400 cg-text-secondary text-center">We'll write to {accountEmail}.</div>}
          {!accountEmail && <TextInputField
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
      components.push(
        <div key='splash-webpush-step' className={`uob-splash-item uob-splash-item-step-${itemStep}`}>
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
      components.push(
        <div key='splash-pwa-step' className={`uob-splash-item uob-splash-item-step-${itemStep}`}>
          <img src={newsletter2} alt='newsletter' className="uob-image" />
          <PWAStatus />
        </div>
      );
    }

    // Create finished
    {
      const itemStep = step === 'create-finished' ? 1 : 0;
      components.push(
        <div key='splash-create-finished' className={`uob-splash-item uob-splash-end uob-splash-item-step-${itemStep}`}>
          <div className={`uob-splash-logo uob-splash-logo-blue`}>
            <CgLogoIcon />
          </div>
          <div className='cg-heading-2 mt-6'>Welcome on Common Ground</div>
          <div className='cg-heading-3 mt-6'>Your journey has just begun</div>
        </div>
      );
    }

    return components;
  }, [step, withPushStep, withPwaStep, accountEmail, newsletterState, setNewsletterState]);

  const gradientStyle = step === 'login-finished' || step === 'create-finished' ? 'full-top' : 'hidden-right';

  return (<div className={`uob-splash uob-splash-gradient-${gradientStyle} uob-${step}`}>
    {renderedStepItems}
    <div className={`uob-splash-bottom uob-splash-buttons`}>
      {step !== 'login-finished' ? buttons : null}
    </div>
  </div>);
}

export default Splash;
