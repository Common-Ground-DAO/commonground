// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { ArrowLeftCircleIcon } from '@heroicons/react/20/solid';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import React from 'react'

import './ManagementHeader.css';

type Props = {
  title: string;
  goBack?: () => void;
  rightControls?: React.JSX.Element;
  iconLeft?: React.JSX.Element;
};

const ManagementHeader: React.FC<Props> = (props) => {
  const { title, goBack, rightControls } = props;
  const { isMobile } = useWindowSizeContext();

  if (isMobile) {
    return <div className='management-header-mobile cg-text-main'>
      <div className='flex gap-2 items-center h-10'>
        <ArrowLeftCircleIcon className='w-8 h-8' onClick={goBack} />
        <span className='cg-heading-3'>{title}</span>
      </div>
      {rightControls}
    </div>
  } else {
    return <div className='flex justify-between w-full items-center py-2 cg-text-main h-16'>
      <span className='cg-heading-3'>{title}</span>
      {rightControls}
    </div>
  }
}

export default React.memo(ManagementHeader);