// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { useNavigate } from 'react-router';
import { useCreateCommunityModalContext } from '../../../context/CreateCommunityModalProvider';

import Button, { ButtonProps } from '../../../components/atoms/Button/Button';

const CreateCommunityButton: React.FC<ButtonProps> = ({ iconLeft, text, role }) => {
  const navigate = useNavigate();
  const { setVisible } = useCreateCommunityModalContext();

  return <Button
    iconLeft={iconLeft}
    text={text}
    role={role}
    // onClick={() => navigate(getUrl({ type: 'create-community' }))}
    onClick={() => setVisible(true)}
  />
}

export default React.memo(CreateCommunityButton);