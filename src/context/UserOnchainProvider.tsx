// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { PageType } from "components/organisms/UserSettingsModalContent/UserSettingsModalContent";
import { useOwnUser, useOwnWallets } from 'context/OwnDataProvider';
import Button from 'components/atoms/Button/Button';
import userApi from 'data/api/user';
import useLocalStorage from 'hooks/useLocalStorage';
import {
  erc20ABI,
  useAccount,
  useNetwork,
  useSignMessage,
  useSwitchNetwork,
  usePublicClient,
  PublicClient,
  usePrepareContractWrite,
  useContractWrite,
  usePrepareSendTransaction,
  useSendTransaction,
  useWaitForTransaction,
} from 'wagmi';
import { Chain, Client, Transport, parseUnits } from 'viem';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import EthereumIcon from '../../../atoms/icons/24/Ethereum.svg?react';
import getSiweMessage from 'util/siwe';
import { useSnackbarContext } from 'context/SnackbarContext';
import { ethers, providers } from 'ethers';

type Tx = {
  hash: string;
  chainId: number;
  text: string;
};

type TxByChain = Record<number, Tx[]>;

type UserOnchainContextState = {
  trackTransaction: (hash: string, chain: Chain, text: string) => void;
  txByChain: TxByChain;
};

export const UserOnchainContext = React.createContext<UserOnchainContextState>({
  trackTransaction: () => {},
  txByChain: {},
});

function clientToProvider(client: Client<Transport, Chain>) {
  const { chain, transport } = client
  const network = {
    chainId: chain.id,
    name: chain.name,
    ensAddress: chain.contracts?.ensRegistry?.address,
  }
  if (transport.type === 'fallback')
    return new providers.FallbackProvider(
      (transport.transports as ReturnType<Transport>[]).map(
        ({ value }) => new providers.JsonRpcProvider(value?.url, network),
      ),
    )
  return new providers.JsonRpcProvider(transport.url, network)
}

/** Hook to convert a viem Client to an ethers.js Provider. */
export function useEthersProvider({
  chainId,
}: { chainId?: number | undefined } = {}) {
  const client = usePublicClient({ chainId })
  return useMemo(() => clientToProvider(client), [client])
}

function ChainWrapper({
  chainId,
  txByChain,
  setTxByChain,
}: {
  chainId: number;
  txByChain: TxByChain;
  setTxByChain: React.Dispatch<React.SetStateAction<TxByChain>>;
}) {
  const trackedTransactions = useMemo(() => new Set<string>(), []);
  const transactions = txByChain[chainId];
  const provider = useEthersProvider({ chainId });

  const { showSnackbar } = useSnackbarContext();

  const checkTransaction = useCallback((tx: Tx) => {
    if (!provider) return;
    if (trackedTransactions.has(tx.hash)) return;
    trackedTransactions.add(tx.hash);
    provider.getTransaction(tx.hash).then(tx => tx.wait()).then(receipt => {
      console.log("Receipt", receipt);
      showSnackbar({ type: 'success', text: tx.text });
    })
    .catch(e => console.log("Transaction error", e))
    .finally(() => {
      setTxByChain(oldTxByChain => {
        const newTxByChain = { ...oldTxByChain };
        const transactions = newTxByChain[chainId];
        if (transactions) {
          newTxByChain[chainId] = transactions.filter(_tx => _tx.hash !== tx.hash);
          if (newTxByChain[chainId].length === 0) {
            delete newTxByChain[chainId];
          }
        }
        return newTxByChain;
      });
    });
  }, [transactions, provider, showSnackbar]);

  useEffect(() => {
    transactions.forEach(checkTransaction);
  }, [transactions]);

  return null;
}

export function UserOnchainProvider(props: React.PropsWithChildren<{}>) {
  const [txByChain, setTxByChain] = useState<TxByChain>({});
  const chainIds = useMemo(() => Object.keys(txByChain).map(Number), [txByChain]);

  const trackTransaction = useCallback((hash: string, chain: Chain, text: string) => {
    if (!txByChain[chain.id] || !txByChain[chain.id].find(tx => tx.hash === hash)) {
      setTxByChain(oldTxByChain => {
        if (oldTxByChain[chain.id] && oldTxByChain[chain.id].find(tx => tx.hash === hash)) {
          return oldTxByChain;
        }
        const newTxByChain = { ...oldTxByChain };
        const transactions = [...(newTxByChain[chain.id] || []), { hash, chainId: chain.id, text }];
        newTxByChain[chain.id] = transactions;
        return newTxByChain;
      });
    }
  }, [txByChain]);

  return (
    <UserOnchainContext.Provider value={{ trackTransaction, txByChain }}>
      {chainIds.map(chainId => (
        <ChainWrapper
          key={chainId}
          chainId={chainId}
          txByChain={txByChain}
          setTxByChain={setTxByChain}
        />
      ))}
      {props.children}
    </UserOnchainContext.Provider>
  )
}

export function useUserOnchainContext() {
  const context = React.useContext(UserOnchainContext);
  return context;
}