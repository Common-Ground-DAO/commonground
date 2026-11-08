// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import CheckedIcon from 'components/atoms/icons/24/RadioButtonChecked.svg?react';
import UncheckedIcon from 'components/atoms/icons/24/RadioButtonUnchecked.svg?react';

type Props = {
  checked?: boolean;
}

const CheckCircle = (props: Props) => {
  const { checked } = props;

  if (checked) {
    return <CheckedIcon />;
  } else {
    return <UncheckedIcon />;
  }
};

export default React.memo(CheckCircle);