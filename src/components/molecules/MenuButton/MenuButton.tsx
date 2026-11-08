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

  // numeric on purpose: a count of 0 (or a stray "0") shows neither count nor
  // hides the dot; if showDot and a count > 0 are both set, only the count is shown
  const count = Number(notificationCount) || 0;
  const showStatusIcon = showDot && count <= 0;

  return (
    <div className={`menu-button-container ${isActive ? 'active' : ''} ${disabled ? 'disabled' : ''}`}>
      <Button
        role={"menu"}
        className={`${className || ''} ${isActive ? 'active' : ''}`}
        iconLeft={
          <div className="menu-icon-container">
            {count > 0 && <NotificationCount notificationCount={count} />}
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
