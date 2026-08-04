// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';

import './CollapsableElement.css';

export type CollapsableState = 'expanded' | 'collapsed';

type Props = {
  state: CollapsableState;
  trigger: React.JSX.Element;
  view?: React.JSX.Element;
}

const CollapsableElement = (props: Props) => {
  const { state, trigger, view } = props;

  return <div className='collapsable-element'>
    <div className='collapsable-trigger'>{trigger}</div>
    {!!view && <div className={`collapsable-view ${state}`}>{view}</div>}
  </div>
};

export default React.memo(CollapsableElement);