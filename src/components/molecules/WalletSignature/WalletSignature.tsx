// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useState } from 'react';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useAccount, useChainId, useSignMessage } from 'wagmi';
import Button from 'components/atoms/Button/Button';
import BigWalletIcon from 'components/atoms/BigWalletIcon/BigWalletIcon';
import userApi from 'data/api/user';
import getSiweMessage from 'util/siwe';
import { userFacingErrorMessage } from 'data/auth/authErrors';

type Props = {
  /** called with the signed SIWE message; throw an Error to show its message */
  onSigned: (data: API.User.prepareWalletAction.Request) => Promise<void>;
  /** label of the sign button, e.g. "Sign in with this wallet" */
  signText: string;
  /** shown above the button while connected */
  hint?: string;
  disabled?: boolean;
};

function isUserRejection(e: unknown) {
  const text = `${(e as any)?.name || ''} ${(e as any)?.message || ''} ${(e as any)?.shortMessage || ''}`;
  return /UserRejected|User rejected|denied|cancel/i.test(text);
}

/**
 * Connect an EVM wallet (RainbowKit) and sign a SIWE message with a fresh
 * server secret. Used to sign in, to sign up and to confirm a sensitive
 * action; what the signature is used for is up to `onSigned`.
 */
const WalletSignature: React.FC<Props> = ({ onSigned, signText, hint, disabled }) => {
  const { address } = useAccount();
  const chainId = useChainId();
  const { signMessageAsync } = useSignMessage();
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const sign = useCallback(async () => {
    if (!address) {
      return;
    }
    setError(undefined);
    setLoading(true);
    try {
      const secret = await userApi.getSignableSecret();
      const siweMessage = getSiweMessage({ address, secret, chainId });
      let signature: string;
      try {
        signature = await signMessageAsync({ message: siweMessage });
      }
      catch (e) {
        if (!isUserRejection(e)) {
          setError("The wallet could not sign the message. Please try again.");
        }
        return;
      }
      await onSigned({
        type: 'evm',
        signature,
        data: {
          address: address.toLowerCase() as Common.Address,
          siweMessage,
          secret,
          type: 'evm',
        },
      });
    }
    catch (e) {
      // raw server codes are mapped; a cancelled "Confirm it's you" shows nothing
      setError(userFacingErrorMessage(e, "Something went wrong, please try again.") || undefined);
    }
    finally {
      setLoading(false);
    }
  }, [address, chainId, onSigned, signMessageAsync]);

  return (
    <ConnectButton.Custom>
      {({ account, chain, mounted, openConnectModal, openChainModal }) => {
        const connected = mounted && !!account && !!chain;
        return (
          <div className='flex flex-col items-center gap-3 w-full'>
            {connected && <BigWalletIcon walletAddress={account.address.toLowerCase()} />}
            {connected && !!hint && <span className='cg-text-md-400 cg-text-secondary text-center'>{hint}</span>}
            {!connected && <Button
              className='w-full'
              role='primary'
              text='Connect a wallet'
              onClick={openConnectModal}
              disabled={disabled}
            />}
            {connected && chain.unsupported && <Button
              className='w-full'
              role='primary'
              text='Switch network'
              onClick={openChainModal}
            />}
            {connected && !chain.unsupported && <Button
              className='w-full'
              role='primary'
              text={signText}
              onClick={sign}
              loading={loading}
              disabled={disabled || loading}
            />}
            {!!error && <span className='cg-text-md-400 cg-text-error text-center'>{error}</span>}
          </div>
        );
      }}
    </ConnectButton.Custom>
  );
};

export default React.memo(WalletSignature);
