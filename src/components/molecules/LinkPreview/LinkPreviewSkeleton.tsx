// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import './LinkPreview.css';
import SpinnerIcon from '../../atoms/icons/16/Spinner.svg?react';

const ExternalLinkPreviewSkeleton = () => {
  return (<div className='flex items-start gap-4 p-2 relative external-link-preview'>
    <div className='external-link-text-content flex items-center justify-center w-full'>
      <SpinnerIcon className='spinner' />
    </div>
  </div>);
}

export default ExternalLinkPreviewSkeleton;