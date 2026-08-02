// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useUserOnboardingContext } from "context/UserOnboarding";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import Modal from "components/atoms/Modal/Modal";
import usersDatabase from "data/databases/user";
import { useOwnUser } from "context/OwnDataProvider";
import { XMarkIcon } from "@heroicons/react/24/solid";
import './UserOnboarding.css';
import Splash from "./Splash/Splash";

const UserOnboarding = () => {
  const { luksoData, isUserOnboardingVisible, setUserOnboardingVisibility, step, createUserData, profileLockedIn } = useUserOnboardingContext();
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

  let extendedHeightClassName = '';
  if (step === 'create-profile-setup' && !profileLockedIn) {
    if (createUserData.useCgProfile !== undefined) {
      extendedHeightClassName = 'create-profile-with-cg-profile';
    }
    else if (createUserData.displayAccount === 'lukso' && (!luksoData || !luksoData.universalProfileValid)) {
      extendedHeightClassName = 'create-profile-with-universal-profile';
    }
  }

  const className = [
    'user-onboarding',
    step,
    extendedHeightClassName,
    isMobile ? 'mobile-layout' : ''
  ].join(' ').trim();

  if (isUserOnboardingVisible) {
    return (
      <Modal hideHeader modalInnerClassName={className} noDefaultScrollable={true} close={closeOnboardingModal}>
        {(step !== "create-finished" && step !== "login-finished") &&
          <div className="onboarding-x"><XMarkIcon className="w-6 h-6" onClick={closeOnboardingModal}/></div>
        }
        <Splash />
      </Modal>
    )
  }
  return null;
};

export default UserOnboarding;