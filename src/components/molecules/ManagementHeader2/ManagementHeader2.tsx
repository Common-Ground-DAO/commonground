// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { ArrowLeftCircleIcon, ChevronDownIcon, LifebuoyIcon } from '@heroicons/react/20/solid';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import React, { useState } from 'react'

import './ManagementHeader2.css';

type Props = {
  title: string;
  goBack?: () => void;
  help?: string | React.JSX.Element;
  // rightControls?: React.JSX.Element;
  // iconLeft?: React.JSX.Element;
};

const ManagementHeader2: React.FC<Props> = (props) => {
  const { title, goBack, help } = props;
  const { isMobile } = useWindowSizeContext();
  const [helpOpen, setHelpOpen] = useState(false);

  return <div className={`flex flex-col cg-text-main ${isMobile ? ' p-4' : ''}`}>
    <div className='flex gap-4'>
      {isMobile && <ArrowLeftCircleIcon className='w-8 h-8' onClick={goBack} />}
      <h2 className={isMobile ? 'flex-1' : ''}>{title}</h2>
      {!!help && <div className='flex items-center cg-text-secondary p-2 gap-1 cursor-pointer' onClick={() => setHelpOpen(old => !old)}>
        <LifebuoyIcon className='w-5 h-5' />
        <span className='cg-text-md-500'>Help</span>
        <ChevronDownIcon className={`w-5 h-5 transition-all ${helpOpen ? '' : ' -rotate-90'}`} />
      </div>}
    </div>
    {!!help && <div className={`grid management-header-help${helpOpen ? ' open' : ''}`}>
      <span className={`cg-text-md-400 cg-text-secondary overflow-hidden`}>{help}</span>
    </div>}
</div>
}

export default React.memo(ManagementHeader2);