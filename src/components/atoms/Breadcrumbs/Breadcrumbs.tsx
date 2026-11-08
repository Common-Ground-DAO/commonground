// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { useNavigate } from 'react-router';
import { ChevronRightIcon } from '@heroicons/react/20/solid';

import './Breadcrumbs.css';

type Props = {
  previousSteps: {
    name: string;
    url: string;
  }[];
  currentStepName: string;
};

const Breadcrumbs: React.FC<Props> = ({ previousSteps, currentStepName }) => {
  const navigate = useNavigate();

  return (
    <div className='breadcrumbs-bar'>
      {previousSteps.map(step => {
        return (<div key={step.name} onClick={() => navigate(step.url)} className='breadcrumbs-step clickable'>
          <span>{step.name}</span>
          <ChevronRightIcon className='h-6 w-6' />
        </div>);
      })}
      <span className='breadcrumbs-step'>{currentStepName}</span>
    </div>
  )
}

export default React.memo(Breadcrumbs);