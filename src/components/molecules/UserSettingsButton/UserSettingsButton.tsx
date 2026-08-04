// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from "react";
import './UserSettingsButton.css';

type Props = {
  leftElement?: React.JSX.Element;
  text: string | React.JSX.Element;
  rightElement?: React.JSX.Element;
  onClick?: (ev: React.MouseEvent<HTMLDivElement>) => void;
  className?: string;
  active?: boolean;
  disabled?: boolean;
  highlighted?: boolean;
};

const UserSettingsButton: React.FC<Props> = (props) => {
  const className = [
    'user-settings-button flex px-4 py-4 gap-2 cg-border-xxl items-center cg-bg-subtle',
    props.active ? 'active' : '',
    props.disabled ? 'disabled' : '',
    props.highlighted ? 'highlighted' : '',
    props.className || '',
  ].join(' ').trim();

  return (<div className={className} role='button' onClick={!props.disabled ? props.onClick : undefined}>
    {props.leftElement}
    <div className='flex items-center flex-1 overflow-hidden'>
      {typeof props.text === 'string' ?
        <span className='cg-text-lg-500 cg-text-main overflow-hidden text-ellipsis'>{props.text}</span> :
        <>{props.text}</>
      }
    </div>
    {!props.disabled && props.rightElement && <div className='flex items-center justify-center gap-1'>
      {props.rightElement}
    </div>}
  </div>);
}

export default React.memo(UserSettingsButton);