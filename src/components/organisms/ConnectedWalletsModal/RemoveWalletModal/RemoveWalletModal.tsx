// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import Button from '../../../../components/atoms/Button/Button';
import Modal from '../../../atoms/Modal/Modal';
import userApi from 'data/api/user';

import './RemoveWalletModal.css';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import { useSnackbarContext } from 'context/SnackbarContext';
import { securityActionErrorMessage } from 'data/auth/authErrors';

type RemoveWalletModalProps = {
  linkedWallet: Models.Wallet.Wallet;
  visible: boolean;
  onClose: () => void;
  onRemoveSuccess?: () => void;
}

const RemoveWalletModal: React.FC<RemoveWalletModalProps> = ({ linkedWallet, visible, onClose, onRemoveSuccess }) => {
  const { showSnackbar } = useSnackbarContext();
  const onCloseInternal = (ev: React.MouseEvent) => {
    ev.stopPropagation();
    onClose();
  }

  const removeWallet = async (ev: React.MouseEvent) => {
    // Actually remove wallet (a sign-in wallet asks "Confirm it's you" first)
    try {
      await userApi.deleteWallet({ id: linkedWallet.id });
    }
    catch (e) {
      const message = securityActionErrorMessage(e, 'The wallet could not be disconnected');
      if (message) {
        showSnackbar({ type: 'warning', text: message });
      }
      return;
    }
    onCloseInternal(ev);
    onRemoveSuccess?.();
  }

  return (
    <ScreenAwareModal
      isOpen={visible}
      title='Disconnect Wallet'
      onClose={onClose}
    >
      <div className='removeWalletModal'>
        <span className='removeWalletModal-minorText'>You may lose access to token-gated areas and content that rely on assets contained on this wallet.</span>

        <div className="btnList justify-end align-center">
          <Button
            role="secondary"
            text="Keep Connected"
            onClick={onCloseInternal}
          />
          <Button
            role="primary"
            text="Disconnect"
            onClick={removeWallet}
          />
        </div>
      </div>
    </ScreenAwareModal>
  )

}

export default React.memo(RemoveWalletModal);