// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'

import './CreateCommunityBanner.css';
import Button from 'components/atoms/Button/Button';

import Detail1 from './detail1.svg?react';
import Detail2 from './detail2.svg?react';
import { useCreateCommunityModalContext } from 'context/CreateCommunityModalProvider';

const CreateCommunityBanner: React.FC = () => {
  const { setVisible } = useCreateCommunityModalContext();

  return (
    <div className='create-community-banner' onClick={() => setVisible(true)}>
      <Detail1 className='detail detail1' />
      <Detail2 className='detail detail2' />
      <span>Can’t find the community that feels juuust right?</span>
      <Button role='primary' text='Create a community' />
    </div>
  )
}

export default React.memo(CreateCommunityBanner);