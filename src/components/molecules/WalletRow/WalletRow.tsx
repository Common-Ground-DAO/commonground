// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { memo, useCallback, useState } from "react";
import { getTruncatedId } from '../../../util';

import Tag from "../../../components/atoms/Tag/Tag";
import Button from "../../../components/atoms/Button/Button";
import WalletVisibilityDropdown from '../../../components/organisms/WalletsEditor/WalletVisibilityDropdown/WalletVisibilityDropdown';
import RemoveWalletModal from "../../../components/organisms/ConnectedWalletsModal/RemoveWalletModal/RemoveWalletModal";

import { useCopiedToClipboardContext } from "../../../context/CopiedToClipboardDialogContext";

import userApi from "data/api/user";
import ToggleInputField from "../inputs/ToggleInputField/ToggleInputField";
import { MinusCircleIcon } from "@heroicons/react/20/solid";
import { securityActionErrorMessage } from 'data/auth/authErrors';
import { useSnackbarContext } from "context/SnackbarContext";

import './WalletRow.css';

type Props = {
  wallet: Models.Wallet.Wallet;
  connected?: boolean;
}

export default function WalletRow(props: Props) {
  const { wallet, connected } = props;
  const [showUnlinkWalletModal, setShowUnlinkWalletModal] = useState<boolean>(false);

  const content = (
    <div className='wallet-row'>
      <div className="flex items-center gap-4">
        <Button role="borderless" iconLeft={<MinusCircleIcon className="w-5 h-5" />} onClick={() => setShowUnlinkWalletModal(true)} />
        <AddressTag address={wallet.walletIdentifier} />
      </div>
      <ActivityButtons {...props} />
      <RemoveWalletModal linkedWallet={wallet} visible={showUnlinkWalletModal} onClose={() => setShowUnlinkWalletModal(false)} />
    </div>
  );

  if (connected) {
    return <div className="wallet-row-connected">
      {content}
    </div>;
  } else {
    return content;
  }

}

const AddressTag = React.memo((props: { address: string }) => {
  const { triggerCopiedToClipboardDialog } = useCopiedToClipboardContext();

  const handleClipboardCopy = () => {
    triggerCopiedToClipboardDialog(props.address)
  }

  return (
    <Tag variant="wallet" label={getTruncatedId(props.address)} onClick={handleClipboardCopy} />
  );
});

const ActivityButtons: React.FC<Props> = memo(({ wallet }) => {
  const { showSnackbar } = useSnackbarContext();

  const setLinkedAddressVisibility = useCallback(async (visibility: Models.Wallet.Visibility) => {
    await userApi.updateWallet({
      id: wallet.id,
      visibility
    });
  }, [wallet]);

  const useToLogin = async (toggled: boolean) => {
    // switching sign-in on or off asks "Confirm it's you"; the server refuses
    // to switch off the account's last way to sign in (LAST_LOGIN_METHOD)
    try {
      await userApi.updateWallet({
        id: wallet.id,
        loginEnabled: toggled
      });
    }
    catch (e) {
      const message = securityActionErrorMessage(e, 'Failed to update wallet');
      if (message) {
        showSnackbar({ type: 'warning', text: message });
      }
    }
  };

  return (
    <div className="flex items-center gap-2">
      <WalletVisibilityDropdown visibility={wallet.visibility} onChange={setLinkedAddressVisibility} />
      <Button
        role="chip"
        text={<ToggleInputField small toggled={wallet.loginEnabled} onChange={useToLogin} label='Use to log in' />}
      />
    </div>
  )
});
