// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback } from "react";
import { useUserOnboardingContext } from "context/UserOnboarding";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import Modal from "components/atoms/Modal/Modal";
import usersDatabase from "data/databases/user";
import { useOwnUser } from "context/OwnDataProvider";
import { XMarkIcon } from "@heroicons/react/24/solid";
import './UserOnboarding.css';
import Splash from "./Splash/Splash";
import AuthFlow from "../AuthFlow/AuthFlow";

/**
 * The onboarding modal, opened by every "log in / sign up" entry point
 * (`setUserOnboardingVisibility(true)`): the login / sign-up flow (AuthFlow),
 * then the tail steps (Splash).
 */
const UserOnboarding = () => {
  const { isUserOnboardingVisible, setUserOnboardingVisibility, step, setStep, continueAfterSignup } = useUserOnboardingContext();
  const { isMobile } = useWindowSizeContext();
  const ownUser = useOwnUser();

  const closeOnboardingModal = () => {
    if (setUserOnboardingVisibility) {
      setUserOnboardingVisibility(false);
    }
    if (ownUser && !ownUser.finishedTutorials.includes('onboarding')) {
      const finishedTutorials = Array.from(new Set<Models.User.TutorialName>([...ownUser.finishedTutorials, 'onboarding']));
      usersDatabase.updateOwnData({ finishedTutorials });
    }
  };

  const onLoggedIn = useCallback(() => {
    setStep('login-finished');
    setTimeout(() => {
      setUserOnboardingVisibility(false);
    }, 1400);
  }, [setStep, setUserOnboardingVisibility]);

  const className = [
    'user-onboarding',
    step,
    isMobile ? 'mobile-layout' : ''
  ].join(' ').trim();

  if (isUserOnboardingVisible) {
    return (
      <Modal hideHeader modalInnerClassName={className} noDefaultScrollable={true} close={closeOnboardingModal}>
        {(step !== "create-finished" && step !== "login-finished") &&
          <div className="onboarding-x"><XMarkIcon className="w-6 h-6" onClick={closeOnboardingModal}/></div>
        }
        {step === 'start'
          ? <AuthFlow variant='modal' onLoggedIn={onLoggedIn} onSignedUp={({ email }) => continueAfterSignup(email)} />
          : <Splash />}
      </Modal>
    )
  }
  return null;
};

export default UserOnboarding;
