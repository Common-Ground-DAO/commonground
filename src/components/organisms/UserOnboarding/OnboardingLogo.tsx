// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import './UserOnboarding.css';
import { ReactComponent as CircleLogo } from "components/atoms/icons/misc/Logo/logo.svg";

const OnboardingLogo = () => {
  return (<CircleLogo className='user-onboarding-logo' />);
}

export default React.memo(OnboardingLogo);
