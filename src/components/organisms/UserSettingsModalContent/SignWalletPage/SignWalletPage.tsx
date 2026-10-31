// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { ConnectButton } from '@rainbow-me/rainbowkit';
import { getDomain, getTypes } from 'common/templates';
import Button from 'components/atoms/Button/Button';
import { useOwnWallets } from 'context/OwnDataProvider';
import { useSnackbarContext } from 'context/SnackbarContext';
import userApi from 'data/api/user';
import { useStepUp } from 'context/StepUpProvider';
import React, { useCallback, useMemo, useRef, useState } from 'react'
import { useAccount, useChainId, useSignMessage } from 'wagmi';
import { PageType } from '../UserSettingsModalContent';
import BigWalletIcon from 'components/atoms/BigWalletIcon/BigWalletIcon';
import getSiweMessage from 'util/siwe';

type Props = {
  setPage: (pageType: PageType) => void;
  setCurrentWallet: (walletId: string) => void;
  lockModal?: (lock: boolean) => void;
};

export type SignedState = 'unsigned' | 'signing' | 'signed' | 'cancelled';

const SignWalletPage: React.FC<Props> = (props) => {
  const { setPage, setCurrentWallet, lockModal } = props;
  const { showSnackbar } = useSnackbarContext();
  const { ensureRecentAuth } = useStepUp();
  const { address } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();
  const wallets = useOwnWallets();
  const enableWalletRedirect = useRef(false);
  const [walletSignError, setWalletSignError] = useState<string>();

  const isActiveAddressLinked = useMemo(() => {
    return !!wallets?.find(wallet => wallet.walletIdentifier === address?.toLowerCase() && wallet.type === 'evm');
  }, [address, wallets]);

  const linkCurrentWallet = useCallback(async () => {
    if (!isActiveAddressLinked && !!address) {
      // a wallet that can sign in is a new sign-in method: confirm first,
      // before the wallet signature is prepared in the session
      if (await ensureRecentAuth('add a wallet you can sign in with') === 'cancelled') {
        return;
      }
      try {
        const secret = await userApi.getSignableSecret();
        const siweMessage = getSiweMessage({ address, secret, chainId });
        const signature = await signMessageAsync({ message: siweMessage });

        const data: API.User.SignableWalletData = {
          address: address.toLowerCase() as Common.Address,
          siweMessage,
          secret,
          type: "evm",
        };
        await userApi.composed_addWallet({
          type: 'evm',
          data,
          signature,
        }, {
          loginEnabled: true,
          visibility: 'private'
        });
        enableWalletRedirect.current = true;
        showSnackbar({ type: 'info', text: 'Wallet successfully signed' });
      } catch (e) {
        let message = (e as unknown as any).toString();
        if (message) {
          // remove useless prefix
          message = message.replace('Error:', '');
        }
        setWalletSignError(message);
      }
    }
  }, [isActiveAddressLinked, address, chainId, signMessageAsync, showSnackbar, ensureRecentAuth]);

  // Redirect to wallet page when wallet is connected
  if (enableWalletRedirect.current && isActiveAddressLinked) {
    const wallet = wallets?.find(wallet => wallet.walletIdentifier === address?.toLowerCase() && wallet.type === 'evm');
    if (wallet) {
      enableWalletRedirect.current = false;
      setPage('wallet');
      setCurrentWallet(wallet.id);
    }
  }

  return (<div className="flex flex-col gap-4 px-4">
    <ConnectButton.Custom>
      {({
        account,
        chain,
        openAccountModal,
        openChainModal,
        openConnectModal,
        mounted,
        accountModalOpen,
        chainModalOpen,
        connectModalOpen
      }) => {
        lockModal?.(chainModalOpen || connectModalOpen || accountModalOpen);

        const connected = mounted && account && chain;
        const connectedAddress = account?.address.toLocaleLowerCase();
        const notSigned = !!connectedAddress && wallets?.every(wallet => wallet.walletIdentifier !== connectedAddress);

        return (<div className='flex flex-col gap-4 items-center justify-center'>
          <BigWalletIcon walletAddress={connectedAddress || ''} />
          {connected && chain.unsupported && <Button className='w-full' role="primary" text="Wrong network" onClick={openChainModal} />}
          {connected && !chain.unsupported && notSigned && (<>
            <div className='flex flex-col items-center justify-center gap-2'>
              <span className='cg-heading-3 cg-text-main text-center'>Wallet Connected</span>
              <span className='cg-text-lg-400 cg-text-main text-center'>Please confirm ownership of this wallet</span>
            </div>
            <Button
              text='Confirm Ownership'
              className='w-full'
              role='primary'
              onClick={linkCurrentWallet}
            />
            {walletSignError && <span className='error cg-text-md-400'>{walletSignError}</span>}
          </>)}
          {connected && !chain.unsupported && !notSigned && (<>
            <div className='flex flex-col items-center justify-center gap-2'>
              <span className='cg-heading-3 cg-text-main text-center'>Wallet Already Signed</span>
              <span className='cg-text-lg-400 cg-text-main text-center'>Try connecting a different wallet on your wallet manager</span>
            </div>
          </>)}
        </div>);
      }}
    </ConnectButton.Custom>
  </div>);
}

export default React.memo(SignWalletPage);