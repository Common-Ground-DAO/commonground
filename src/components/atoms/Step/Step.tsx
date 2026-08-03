// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import CheckmarkFilledIcon from '../../../components/atoms/icons/16/CheckmarkFilled.svg?react';

import './Step.css';

type StepProps = {
  state: "ready" | "complete" | "waiting";
  stepTitle: string;
}

const Step: React.FC<React.PropsWithChildren<StepProps>> = ({ state, stepTitle, children }) => {

  const logo = React.useMemo(() => {
    if (state === 'ready') {
      return <div className='step-ready-logo' />
    } else if (state === 'complete') {
      return <div className='step-complete-logo'><CheckmarkFilledIcon /></div>;
    } else {
      return <div className='step-waiting-logo' />
    }
  }, [state]);

  return <div className='step'>
    <div className={`step-header${state === 'complete' ? ' complete' : ''}`}>
      {logo}
      <span className='step-header-text'>{stepTitle}</span>
    </div>
    {state !== "complete" && <div className='step-content'>
      {children}
    </div>}
  </div>
};

export default React.memo(Step);