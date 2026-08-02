// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { Children, useMemo, useState } from 'react';
import CheckedIcon from 'components/atoms/icons/24/RadioButtonChecked.svg?react';
import UncheckedIcon from 'components/atoms/icons/24/RadioButtonUnchecked.svg?react';

import './CollapsableGroup.css';

type Props = {
}

const CollapsableGroup: React.FC<React.PropsWithChildren<Props>> = ({children}) => {

  return <div className="collapsable-group">
    {children}
  </div>
};

export default React.memo(CollapsableGroup);