// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import './BookmarkButton.css';

type Props = {
  active: boolean;
  onClick: () => void;
  icon: React.JSX.Element;
}

const BookmarkButton: React.FC<Props> = ({ active, onClick, icon }) => {
  return (<div className={`bookmark-button${active ? ' active' : ''}`} onClick={onClick}>
    {icon}
  </div>);
}

export default React.memo(BookmarkButton);