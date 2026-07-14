// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { MinusIcon } from '@heroicons/react/20/solid';
import Button from 'components/atoms/Button/Button';
import React, { useCallback, useState } from 'react'
import userApi from 'data/api/user';
import { useSnackbarContext } from 'context/SnackbarContext';
import { ExternalAccountType, getAccountIcon } from '../AccountsPage/AccountsPage';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import { useOwnUser, useOwnWallets } from 'context/OwnDataProvider';

type Props = {
  currentAccountType: ExternalAccountType;
  goBack: () => void;
  lockModal: (lock: boolean) => void;
}

const ExternalAccountPage: React.FC<Props> = (props) => {
  const ownUser = useOwnUser();
  const wallets = useOwnWallets();
  const { currentAccountType, goBack } = props;
  const { showSnackbar } = useSnackbarContext();
  const currentAccount = ownUser?.accounts.find(acc => acc.type === currentAccountType);
  
  const [showUnlinkModal, _setShowUnlinkModal] = useState(false);
  const setShowUnlinkModal = useCallback((open: boolean) => {
    _setShowUnlinkModal(open);
    props.lockModal(open);
  }, [props]);

  const tryShowingUnlinkModal = () => {
    const hasLoginWallets = wallets?.some(w => w.loginEnabled);
    if (!ownUser?.email && !hasLoginWallets && (ownUser?.accounts?.length || 0) < 2) {
      showSnackbar({type: 'warning', text: 'This is your only login method and thus cannot be removed'});
    } else {
      setShowUnlinkModal(true);
    }
  }

  const onUnlinkAccount = async () => {
    await userApi.removeUserAccount({ type: currentAccountType });
    showSnackbar({type: 'info', text: 'Account removed'});
    goBack();
  }

  return (<div className='flex flex-col gap-4 px-4'>
    <div className='flex gap-1 self-stretch items-center cg-text-main'>
      {getAccountIcon(currentAccountType)}
      <span className='cg-text-lg-500 cg-text-main flex-1'>
        {currentAccount?.displayName}
      </span>
    </div>
    <Button
      iconLeft={<MinusIcon className='w-5 h-5' />}
      text='Disconnect'
      role='destructive'
      onClick={tryShowingUnlinkModal}
    />
    <ScreenAwareModal
      isOpen={showUnlinkModal}
      onClose={() => setShowUnlinkModal(false)}
    >
      <div className='flex flex-col p-4 gap-8'>
        <span className='cg-text-main'>Are you sure you want to remove this account and login method?</span>
        <div className="btnList justify-end align-center">
          <Button
            role="secondary"
            text="Keep Connected"
            onClick={() => setShowUnlinkModal(false)}
          />
          <Button
            role="primary"
            text="Disconnect"
            onClick={onUnlinkAccount}
          />
        </div>
      </div>
    </ScreenAwareModal>
  </div>);
}

export default React.memo(ExternalAccountPage);
