// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback, useEffect, useMemo, useState } from "react";

import { getTruncatedId } from '../../../util';

import Tag from "components/atoms/Tag/Tag";
import Button from "components/atoms/Button/Button";

import CheckmarkIcon from 'components/atoms/icons/16/Checkmark.svg?react';
import MetamaskIcon from 'components/atoms/icons/24/MetamaskIcon.svg?react';

import './WalletManagerRow.css';
import userApi from "data/api/user";
import { useSignMessage, useAccount, useChainId } from "wagmi";
import getSiweMessage from "util/siwe";

type WalletManagerState = 'disconnected' | 'connecting' | 'reconnecting' | 'connected' | 'signing' | 'signed';

type Props = {
  walletData?: { data: API.User.SignableWalletData, signature: string };
  setWalletData: (data?: { data: API.User.SignableWalletData, signature: string }) => void;
}

export default function WalletManagerRow(props: Props) {
  const { walletData, setWalletData } = props;
  const [errorMessage, setErrorMessage ] = useState<string>();
  const chainId = useChainId();
  const account = useAccount();

  const { signMessageAsync } = useSignMessage();

  let initialState: WalletManagerState = 'disconnected';
  if (chainId !== 0 && !!account) {
    initialState = 'connected';
  }
  if (!!walletData) {
    initialState = 'signed';
  }
  const [state, setState ] = useState<WalletManagerState>(initialState);

  useEffect(() => {
    if (!errorMessage) {
      if (!!account) {
        setState('connected');
      } else {
        setState('disconnected');
      }
    }
  }, [account, errorMessage]);

  const sign = useCallback(async () => {
    setState('signing');
    setErrorMessage('');
    try {
      const secret = await userApi.getSignableSecret();
      const siweMessage = getSiweMessage({ address: account.address?.toLowerCase() as Common.Address, secret, chainId });
      const signature = await signMessageAsync({ message: siweMessage });
      const data: API.User.SignableWalletData = {
        address: account.address?.toLowerCase() as Common.Address,
        siweMessage,
        secret,
        type: 'evm'
      };
      setState('signed');
      setWalletData({
        data,
        signature,
      });
    } catch (e) {
      setState('connected');
      if (e instanceof Error) {
        setErrorMessage(e.message);
      } else {
        setErrorMessage('Unknown error on sign account');
      }
    }
  }, [account.address, chainId, signMessageAsync, setWalletData]);

  const connect = useMemo(() => {
    return async () => {
      setErrorMessage('');
      setState('connecting');
      try {
        setState('connected');
        setWalletData();
      } catch (e) {
        setState('disconnected');
        if (e instanceof Error) {
          setErrorMessage(e.message);
        } else {
          setErrorMessage('Unknown error on connect to Metamask');
        }
      }
    };
  }, [setWalletData])

  return (
    <div
      className={`wallet-manager-row${chainId !== 0 ? '' : ' disabled'} ${state}`}
      key={'metamask'}
      onClick={() => state === 'disconnected' && connect()}
    >
      <MetamaskIcon />
      <div className="wallet-manager-action-bar">
        {state === 'disconnected' && <>
          <div className="connector-name">Metamask</div>
          {errorMessage && <div className="connector-issue">{errorMessage}</div>}
        </>}
        {state === 'connecting' && <>
          <div className="connector-name">Metamask</div>
          <div className="connector-state">Connecting...</div>
        </>}
        {state === 'connected' && <>
          {!errorMessage && <Tag variant="wallet" label={account.address && getTruncatedId(account.address?.toLowerCase())} />}
          {errorMessage && <div className="connector-issue">{errorMessage}</div>}          
          <Button role="primary" text="Sign now" onClick={() => sign()}/>
        </>}
        {state === 'signing' && <>
          <Tag variant="wallet" label={account.address && getTruncatedId(account.address?.toLowerCase())} />
          <div className="connector-state">Signing...</div>
        </>}
        {state === 'signed' && <>
          <Tag variant="wallet" label={account.address && getTruncatedId(account.address?.toLowerCase())} />
          <div className="connector-state">Connected <CheckmarkIcon /></div>
        </>}
      </div>
    </div>
  );
}
