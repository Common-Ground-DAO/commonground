// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import './ToggleText.css';
import CheckboxBase from 'components/atoms/CheckboxBase/CheckboxBase';

type Props = {
  title: string;
  description: string;
  icon: React.JSX.Element;
  active: boolean;
  onToggle: (newActive: boolean) => void;
  customElement?: React.JSX.Element;
  hideToggle?: boolean;
  extraBottomElement?: React.JSX.Element;
};

const ToggleText: React.FC<Props> = (props) => {
  const { title, icon, customElement, description, active, onToggle, hideToggle, extraBottomElement } = props;

  const className = [
    'toggle-text',
    'flex flex-col gap-2 cursor-pointer self-stretch p-4',
    active ? 'active' : ''
  ].join(' ').trim();

  return (<div className={className} onClick={!hideToggle ? () => onToggle(!active) : undefined}>
    <div className='flex items-center gap-2 self-stretch'>
      <div className='flex items-start flex-1 gap-2'>
        {icon}
        {!!customElement ? customElement : <div className='flex flex-col justify-center items-start flex-1'>
          <span className='self-stretch cg-text-lg-500 cg-text-main'>{title}</span>
          <span className='self-stretch cg-text-md-400 cg-text-secondary'>{description}</span>
        </div>}
      </div>
      {!hideToggle && <CheckboxBase type='radio' size='normal' checked={active} />}
    </div>
    {extraBottomElement}
  </div>);
}

export default React.memo(ToggleText);