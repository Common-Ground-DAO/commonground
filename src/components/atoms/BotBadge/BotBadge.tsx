// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { Tooltip } from 'components/atoms/Tooltip/Tooltip';

type Props = {
  disableTooltip?: boolean;
};

const badge = (
  <span
    aria-label='Bot account'
    className='inline-flex shrink-0 items-center px-1 py-0.5 cg-border-m cg-bg-subtle cg-text-brand cg-text-sm-500'
  >
    BOT
  </span>
);

const BotBadge: React.FC<Props> = ({ disableTooltip }) => {
  if (disableTooltip) return badge;
  return (
    <Tooltip
      placement='top'
      triggerContent={badge}
      tooltipContent='Bot account'
    />
  );
};

export default React.memo(BotBadge);
