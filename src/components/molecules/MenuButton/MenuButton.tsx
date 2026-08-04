// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import Button from "../../../components/atoms/Button/Button";
import NotificationCount from "../../../components/atoms/NotificationCount/NotificationCount";
import NotificationDot from 'components/atoms/NotificationDot/NotificationDot';

import './MenuButton.css';

type Props = {
  icon?: React.JSX.Element;
  onClick?: (ev: React.MouseEvent<HTMLButtonElement, MouseEvent>) => void;
  className?: string;
  isActive?: boolean;
  disabled?: boolean;
  showDot?: boolean;
  notificationCount?: number;
  buttonRef?: React.RefObject<HTMLButtonElement | null>;
}

export default function MenuButton(props: Props) {
  const { icon, onClick, className, isActive, disabled, showDot, notificationCount, buttonRef } = props;

  // if showDot and notificationCount are both true, only the notificationCount is shown
  const showStatusIcon = showDot && !notificationCount;

  return (
    <div className={`menu-button-container ${isActive ? 'active' : ''} ${disabled ? 'disabled' : ''}`}>
      <Button
        role={"menu"}
        className={`${className || ''} ${isActive ? 'active' : ''}`}
        iconLeft={
          <div className="menu-icon-container">
            {!!notificationCount && <NotificationCount notificationCount={notificationCount || 4} />}
            {showStatusIcon && <NotificationDot className="menu-button-dot-icon" />}
            {icon}
          </div>
        }
        onClick={onClick}
        disabled={disabled}
        buttonRef={buttonRef}
      />
    </div>
  );
}
