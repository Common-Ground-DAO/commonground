// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import ToggleInputField from "../inputs/ToggleInputField/ToggleInputField";

import './OptionToggle.css';

type OptionToggleProps = {
  title: string | React.JSX.Element;
  description: string;
  isToggled: boolean;
  onToggle: (value: boolean) => void;
  disabled?: boolean;
};

const OptionToggle: React.FC<OptionToggleProps> = (props) => {
  const { title, description, isToggled, onToggle, disabled } = props;
  return <div className='flex justify-between items-start gap-2'>
    <div className='flex flex-col'>
      <span className='toggle-title'>{title}</span>
      <span className='toggle-description'>{description}</span>
    </div>
    <ToggleInputField
      toggled={isToggled}
      onChange={onToggle}
      disabled={disabled}
    />
  </div>
};

export default React.memo(OptionToggle);