// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import { ChevronRightIcon } from '@heroicons/react/20/solid';

import './SettingsListItem.css';

type Props = {
  onClick: () => void;
  text: React.JSX.Element | string;
  number?: string;
  selected?: boolean;
  iconLeft?: React.JSX.Element;
  rightElement?: React.JSX.Element;
}

const SettingsListItem: React.FC<Props> = ({ number, onClick, text, selected, rightElement, iconLeft = null }) => {
  const className = [
    'settings-list-item',
    selected ? 'selected' : ''
  ].join(' ').trim();

  return (
    <div className={className} onClick={onClick}>
      <div className='flex items-center gap-2'>
        {iconLeft}
        {text}
      </div>
      <div className='flex items-center'>
        {rightElement ? rightElement : <>
          {number}
          <ChevronRightIcon className='w-5 h-5' />
        </>}
      </div>
    </div>
  );
}

export default SettingsListItem