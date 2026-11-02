// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useNavigate } from "react-router";

import { useUserOnboardingContext } from "../../../context/UserOnboarding";
import { useWindowSizeContext } from "../../../context/WindowSizeProvider";
import AudioWidgetMobile from "./AudioWidgetMobile";
import AudioWidgetDesktop from "./AudioWidgetDesktop";
import { useOwnUser } from "../../../context/OwnDataProvider";
import { getUrl } from 'common/util';

import './AudioWidget.css';
import { useCallback } from "react";

export type AudioWidgetProps = {
  text?: string;
  isActive: boolean;
  isCollapsed?: boolean;
}

export function AudioWidget(props: AudioWidgetProps) {
  const navigate = useNavigate();
  const { setUserOnboardingVisibility, setStep } = useUserOnboardingContext();
  const { isMobile } = useWindowSizeContext();
  const ownUser = useOwnUser();

  const handleProfileClick = useCallback(() => {
    if (!!ownUser?.id) {
      navigate(getUrl({ type: 'user', user: ownUser }));
    } else if (setUserOnboardingVisibility) {
      setStep('start');
      setUserOnboardingVisibility(true);
    }
  }, [ownUser, setUserOnboardingVisibility, navigate, setStep]);

  if (isMobile) {
    return <AudioWidgetMobile {...props} handleProfileClick={handleProfileClick} />;
  } else {
    return <AudioWidgetDesktop {...props} handleProfileClick={handleProfileClick} />;
  }
}