// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo, useState } from 'react';
import CheckedIcon from 'components/atoms/icons/24/RadioButtonChecked.svg?react';
import UncheckedIcon from 'components/atoms/icons/24/RadioButtonUnchecked.svg?react';

import './RadioButton.css';

type Props = {
  checked?: boolean;
  label: string;
  disabled?: boolean;
  setChecked: (checked: boolean) => void;
  className?: string;
}

const RadioButton = (props: Props) => {
  const { checked, disabled, label, setChecked, className } = props;

  return <div className={`${className ?? ''} radiobutton${disabled ? ' disabled': ''}`}>
    {checked
      ? <span className='radiobutton-checkmark checked'>
          <CheckedIcon />
        </span> 
      : <span className='radiobutton-checkmark unchecked' onClick={() => setChecked(true)}>
          <UncheckedIcon />
        </span>
      }
    <span className='radiobutton-label'>{label}</span>
  </div>
};

export default React.memo(RadioButton);