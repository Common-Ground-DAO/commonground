// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useState } from 'react'
import Modal from '../../atoms/Modal/Modal';
import Scrollable from '../../molecules/Scrollable/Scrollable';
import { useCreateCommunityModalContext } from '../../../context/CreateCommunityModalProvider';
import CreateCommunityInner from './CreateCommunityInner';
import Button from '../../../components/atoms/Button/Button';

import CloseIcon from '../../../components/atoms/icons/16/Close.svg?react';
import { useWindowSizeContext } from '../../../context/WindowSizeProvider';

const CreateCommunityModal = () => {
  const { isVisible, setVisible } = useCreateCommunityModalContext();
  const { isMobile } = useWindowSizeContext();
  const [showCloseModal, setShowCloseModal] = useState(false);

  if (isVisible) {
    return (
      <Modal hideHeader modalInnerClassName={`create-community-modal${isMobile ? ' mobile-layout' : ''}`}>
        {showCloseModal && <Modal noBackground headerText="Are you sure you want to cancel?" close={() => setShowCloseModal(false)}>
        <div className="modal-inner">
          <p>You will lose your progress</p>
          <div className="btnList justify-end mt-4">
            <Button
              text="No, stay here"
              onClick={() => setShowCloseModal(false)}
              role="secondary"
            />
            <Button
              text="Yes, cancel"
              onClick={() => setVisible(false)}
              role="primary"
              iconLeft={<CloseIcon />}
            />
          </div>
        </div>
      </Modal>}
        <Scrollable>
          <div className='create-community-modal-content'>
            <div className='create-community-modal-header'>
              <span>Create your community</span>
              <Button
                className='create-community-modal-header-button'
                iconLeft={<CloseIcon />}
                role='secondary'
                onClick={() => setShowCloseModal(true)}
              />
            </div>
            <CreateCommunityInner onCancel={() => setVisible(false)} onSuccess={() => setVisible(false)} />
          </div>
          {showCloseModal && <div className='absolute inset-0 pointer-events-none z-10' style={{background: 'rgba(0, 0, 0, 0.8)'}} />}
        </Scrollable>
      </Modal>
    );
  }

  return null;
}

export default React.memo(CreateCommunityModal);