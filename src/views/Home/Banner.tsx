// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { useNavigate } from "react-router";
import Button from "../../components/atoms/Button/Button";
import { useWindowSizeContext } from "context/WindowSizeProvider";
import { isLocalUrl } from "components/atoms/SimpleLink/SimpleLink";
import { useUserOnboardingContext } from "context/UserOnboarding";

type Props = {}

const learnMoreLink = 'https://app.cg/c/commonground/article/get-started-with-common-ground-at7LgiCe6663fEPPvzobxN/';

export default function Banner(props: Props) {
  const navigate = useNavigate();
  const { isMobile } = useWindowSizeContext();
  const { isUserOnboardingComplete, setUserOnboardingVisibility } = useUserOnboardingContext();

  const bottomContent = React.useMemo(() => {
    const openLearnMore = () => {
      const localExtract = isLocalUrl(learnMoreLink);
      if (localExtract) {
        navigate(localExtract);
      } else {
        if (isMobile) {
          window.open(learnMoreLink, 'infoTab', 'noopener');
        } else {
          window.open(learnMoreLink, '_blank', 'noopener');
        }
      }
    }

    const onSetupClick = () => {
      if (!isUserOnboardingComplete && setUserOnboardingVisibility) {
        setUserOnboardingVisibility(true);
      }
    }

    if (!isUserOnboardingComplete) {
      return <div className="bannerBottom welcomeContainer">
        <span className="bannerBottomTitle">Welcome to Common Ground</span>
        <span className="bannerBottomText">You’ve discovered the all-in-one chat app for DAOs & online communities. Feel free to explore, join any community, and have fun!</span>
        <div className="bannerBottomButtons">
          <Button text="Set up Profile" role="primary" onClick={onSetupClick} />
          <Button text="Learn More" role="secondary" onClick={openLearnMore} />
        </div>
      </div>;
    }

    return null;
  }, [isMobile, isUserOnboardingComplete, navigate, setUserOnboardingVisibility]);

  if (!bottomContent) return null;

  return <div className='banner'>
    {bottomContent}
  </div>;
}