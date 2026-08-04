// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { ClipboardDocumentIcon, GlobeEuropeAfricaIcon, LockClosedIcon, MinusIcon, UserGroupIcon, WalletIcon } from '@heroicons/react/20/solid';
import Button from 'components/atoms/Button/Button';
import { useOwnWallets } from 'context/OwnDataProvider';
import React, { useCallback, useEffect, useRef, useState } from 'react'
import { getTruncatedId } from '../../../../util';
import PaddedIcon from 'components/atoms/PaddedIcon/PaddedIcon';
import { useCopiedToClipboardContext } from 'context/CopiedToClipboardDialogContext';
import ToggleInputField from 'components/molecules/inputs/ToggleInputField/ToggleInputField';
import RemoveWalletModal from 'components/organisms/ConnectedWalletsModal/RemoveWalletModal/RemoveWalletModal';
import userApi from 'data/api/user';
import { useSnackbarContext } from 'context/SnackbarContext';

type Props = {
  currentWalletId: string;
  goBack: () => void;
  lockModal: (lock: boolean) => void;
}

export const getVisibilityIcon = (visibility: Models.Wallet.Visibility) => {
  switch (visibility) {
    case 'public': return <GlobeEuropeAfricaIcon className='w-5 h-5' />
    case 'followed': return <UserGroupIcon className='w-5 h-5' />
    case 'private': return <LockClosedIcon className='w-5 h-5' />
  }
}

const WalletPage: React.FC<Props> = (props) => {
  const { currentWalletId, goBack } = props;
  const { showSnackbar } = useSnackbarContext();
  const wallets = useOwnWallets();
  const wallet = wallets?.find(wallet => wallet.id === currentWalletId);
  const { triggerCopiedToClipboardDialog } = useCopiedToClipboardContext();
  // const [walletVisibility, setWalletVisibility] = useState<Models.Wallet.Visibility>(wallet?.visibility || 'public');
  const [useToLogin, setUseToLogin] = useState(wallet?.loginEnabled || false);
  const [showUnlinkWalletModal, _setShowUnlinkWalletModal] = useState(false);
  const setShowUnlinkWalletModal = useCallback((open: boolean) => {
    _setShowUnlinkWalletModal(open);
    props.lockModal(open);
  }, [props]);

  // Keep data up-to-date to save on-close
  const requestInfo = useRef<{
    // visibility: Models.Wallet.Visibility
    useToLogin: boolean;
  }>(undefined);

  useEffect(() => {
    requestInfo.current = {
      // visibility: walletVisibility,
      useToLogin,
    }
  }, [useToLogin]);

  useEffect(() => {
    const onSubmit = async () => {
      if (!wallet || !requestInfo.current) return;

      const { useToLogin } = requestInfo.current;
      const hasChanges = useToLogin !== wallet.loginEnabled;
      if (!hasChanges) return;

      try {
        const request: API.User.updateWallet.Request = {
          id: wallet.id,
          loginEnabled: useToLogin,
        };
        await userApi.updateWallet(request);
        showSnackbar({ type: 'info', text: 'Wallet info successfully updated' });
      } catch (e) {
        console.error(e);
        showSnackbar({ type: 'warning', text: 'Failed to update wallet' });
      }
    };

    return () => {
      onSubmit();
    };
  }, [showSnackbar, wallet]);

  if (!wallet) {
    goBack();
    return null;
  }

  const handleClipboardCopy = () => {
    triggerCopiedToClipboardDialog(wallet.walletIdentifier)
  }

  return (<div className='flex flex-col gap-4 px-4'>
    <div className='flex gap-1 self-stretch items-center cg-text-main'>
      <WalletIcon className='w-5 h-5' />
      <span className='cg-text-lg-500 cg-text-main flex-1'>
        {getTruncatedId(wallet.walletIdentifier)}
      </span>
      <div onClick={handleClipboardCopy} className='cursor-pointer'>
        <PaddedIcon className='cg-text-main' icon={<ClipboardDocumentIcon className='w-5 h-5' />} />
      </div>
    </div>
    {/* <div className='flex flex-col items-start gap-2 self-stretch'>
      <span className='cg-text-lg-500 cg-text-main'>Visibility</span>
      <div className='flex flex-col self-stretch gap-1'>
        <UserSettingsButton
          text='Public'
          leftElement={getVisibilityIcon('public')}
          rightElement={<CheckboxBase size='normal' type='radio' checked={walletVisibility === 'public'} />}
          onClick={() => setWalletVisibility('public')}
          active={walletVisibility === 'public'}
        />
        <UserSettingsButton
          text='Friends only'
          leftElement={getVisibilityIcon('followed')}
          rightElement={<CheckboxBase size='normal' type='radio' checked={walletVisibility === 'followed'} />}
          onClick={() => setWalletVisibility('followed')}
          active={walletVisibility === 'followed'}
        />
        <UserSettingsButton
          text='Private'
          leftElement={getVisibilityIcon('private')}
          rightElement={<CheckboxBase size='normal' type='radio' checked={walletVisibility === 'private'} />}
          onClick={() => setWalletVisibility('private')}
          active={walletVisibility === 'private'}
        />
      </div>
    </div> */}
    <div className='flex flex-col items-start gap-2 self-stretch'>
      <span className='cg-text-lg-500 cg-text-main'>Account</span>
      {wallet?.type === "cg_evm" && <span className='cg-text-md-400 cg-text-main'>This is the legacy wallet for logging in with seed phrase. Disconnect it once you've added another login method.</span>}
      <Button
        role='chip'
        className={`user-setting-theme-page-btn self-stretch py-2 px-3`}
        text='Use to log in'
        iconRight={<ToggleInputField toggled={useToLogin} />}
        onClick={() => setUseToLogin(!useToLogin)}
      />
    </div>
    <Button
      iconLeft={<MinusIcon className='w-5 h-5' />}
      text='Disconnect'
      role='destructive'
      onClick={() => setShowUnlinkWalletModal(true)}
    />
    <RemoveWalletModal
      linkedWallet={wallet}
      visible={showUnlinkWalletModal}
      onClose={() => setShowUnlinkWalletModal(false)}
      onRemoveSuccess={goBack}
    />
  </div>);
}

export default React.memo(WalletPage);