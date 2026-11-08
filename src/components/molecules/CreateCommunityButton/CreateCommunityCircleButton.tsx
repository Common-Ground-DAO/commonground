// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { useCreateCommunityModalContext } from '../../../context/CreateCommunityModalProvider';
import PlusIcon from '../../../components/atoms/icons/24/Plus.svg?react';

import './CreateCommunityCircleButton.css';

const CreateCommunityCircleButton: React.FC = () => {
  const { setVisible } = useCreateCommunityModalContext();

  return <div className='create-community-circle-button' onClick={() => setVisible(true)}>
    <PlusIcon />
  </div>
}

export default React.memo(CreateCommunityCircleButton);