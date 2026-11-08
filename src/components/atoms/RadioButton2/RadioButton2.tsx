// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import CheckedIcon from 'components/atoms/icons/24/RadioButtonChecked.svg?react';
import UncheckedIcon from 'components/atoms/icons/24/RadioButtonUnchecked.svg?react';

import './RadioButton2.css';

type Props = {
  checked?: boolean;
  label: string;
  disabled?: boolean;
  setChecked: (checked: boolean) => void;
  className?: string;
}

const RadioButton2 = (props: Props) => {
  const { checked, disabled, label, setChecked, className } = props;

  return <div 
    className={`${className ?? ''} radiobutton${disabled ? ' disabled': ''} ${checked ? 'checked' : 'unchecked'}`}
    onClick={() => !checked ? setChecked(true) : null}
  >
    <span className='radiobutton-label'>{label}</span>
    {checked
      ? <span className='radiobutton-checkmark checked'>
          <CheckedIcon />
        </span> 
      : <span className='radiobutton-checkmark unchecked'>
          <UncheckedIcon />
        </span>
      }
  </div>
};

export default React.memo(RadioButton2);