// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './PickerPage.css';
import React, { useCallback, useEffect, useState } from 'react'
import { PageType } from '../UserSettingsModalContent';
import { useOwnUser } from 'context/OwnDataProvider';
import LogOffModal from 'components/organisms/LogOffModal/LogOffModal';
import { ReactComponent as SparkIcon } from '../../../atoms/icons/20/Spark.svg';
import { Bell, Lifebuoy, Palette, Robot, SealCheck, SignOut, Wallet } from '@phosphor-icons/react';
import UserProfileV2 from 'components/molecules/UserProfileV2/UserProfileV2';

type Props = {
  setPage: (pageType: PageType) => void;
  lockModal: (lock: boolean) => void;
  closeModal: () => void;
};

const PickerPage: React.FC<Props> = (props) => {
  const { setPage, lockModal, closeModal } = props;
  const ownUser = useOwnUser();
  const [isLogoutOpen, _setLogoutOpen] = useState(false);

  // Close modal on logout
  useEffect(() => {
    if (!ownUser) {
      closeModal();
    }
  }, [closeModal, ownUser]);

  const setLogoutOpen = useCallback((open: boolean) => {
    _setLogoutOpen(open);
    lockModal(open);
  }, [lockModal]);

  return <div className='grid grid-flow-row p-4 gap-4 cg-text-main'>
    {ownUser && <UserProfileV2
      user={ownUser}
      isFollowed={false}
      isFollower={false}
      showEditControls
      lockModal={lockModal}
      linksToProfile
    />}
    <div className='cg-separator' />
    <div className='flex flex-wrap gap-0.5'>
      <div className='flex p-2 gap-1 cursor-pointer' onClick={() => setPage('how-spark-works')}>
        <SparkIcon className='w-5 h-5 cg-text-secondary' />
        <span className='cg-text-md-500'>Spark</span>
      </div>
      <div className='flex p-2 gap-1 cursor-pointer' onClick={() => setPage('become-supporter')}>
        <SealCheck weight='duotone' className='w-5 h-5 cg-text-secondary' />
        <span className='cg-text-md-500'>Supporter Badge</span>
      </div>
      <div className='flex p-2 gap-1 cursor-pointer' onClick={() => setPage('accounts')}>
        <Wallet weight='duotone' className='w-5 h-5 cg-text-secondary' />
        <span className='cg-text-md-500'>Accounts</span>
      </div>
      <div className='flex p-2 gap-1 cursor-pointer' onClick={() => setPage('notifications')}>
        <Bell weight='duotone' className='w-5 h-5 cg-text-secondary' />
        <span className='cg-text-md-500'>Notifications</span>
      </div>
      <div className='flex p-2 gap-1 cursor-pointer' onClick={() => setPage('bots')}>
        <Robot weight='duotone' className='w-5 h-5 cg-text-secondary' />
        <span className='cg-text-md-500'>Bots</span>
      </div>
      <div className='flex p-2 gap-1 cursor-pointer' onClick={() => setPage('theme')}>
        <Palette weight='duotone' className='w-5 h-5 cg-text-secondary' />
        <span className='cg-text-md-500'>Theme</span>
      </div>
      <div className='flex p-2 gap-1 cursor-pointer' onClick={() => setPage('feedback')}>
        <Lifebuoy weight='duotone' className='w-5 h-5 cg-text-secondary' />
        <span className='cg-text-md-500'>Help</span>
      </div>
      <div className='flex p-2 gap-1 cursor-pointer' onClick={() => setLogoutOpen(true)}>
        <SignOut weight='duotone' className='w-5 h-5 cg-text-secondary' />
        <span className='cg-text-md-500 cg-text-secondary'>Sign out</span>
      </div>
    </div>
    <LogOffModal
      open={isLogoutOpen}
      onClose={() => setLogoutOpen(false)}
    />
  </div>;
}





export default React.memo(PickerPage);