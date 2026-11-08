// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from "react";
import './SettingsButton.css';

type Props = {
  leftElement?: React.JSX.Element;
  text: string | React.JSX.Element;
  rightElement?: React.JSX.Element;
  onClick?: (ev: React.MouseEvent<HTMLDivElement>) => void;
  className?: string;
  active?: boolean;
  disabled?: boolean;
  textClassName?: string;
};

const SettingsButton: React.FC<Props> = (props) => {
  const className = [
    'settings-button flex p-2 gap-2 cg-border-xl items-center',
    props.active ? 'active' : '',
    props.disabled ? 'disabled' : '',
    props.active ? 'cg-text-brand' : 'cg-text-main',
    props.className || '',
  ].join(' ').trim();

  return (<div className={className} role='button' onClick={!props.disabled ? props.onClick : undefined}>
    {props.leftElement}
    <div className='flex items-center flex-1 overflow-hidden'>
      {typeof props.text === 'string' ?
        <span className={`overflow-hidden text-ellipsis ${props.textClassName || 'cg-text-md-500'}`}>{props.text}</span> :
        <>{props.text}</>
      }
    </div>
    {!props.disabled && props.rightElement && <div className='flex items-center justify-center gap-1'>
      {props.rightElement}
    </div>}
  </div>);
}

export default React.memo(SettingsButton);