// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'

import './PaddedIcon.css';

type Props = {
  icon: React.JSX.Element;
  className?: string;
  defaultClassName?: 'success' | 'info';
  onClick?: () => void;
};

const PaddedIcon: React.FC<Props> = ({ icon, className, defaultClassName, onClick }) => {
  const classNameFinal = [
    'padded-icon',
    className || '',
    !!onClick ? 'cursor-pointer' : '',
    defaultClassName ? `padded-icon-${defaultClassName}` : ''
  ].join(' ').trim();
  return <div onClick={onClick} className={classNameFinal}>{icon}</div>;
}

export default React.memo(PaddedIcon);