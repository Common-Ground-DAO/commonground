// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { usePublicClient } from 'wagmi';
import { Chain } from 'viem';
import { useSnackbarContext } from 'context/SnackbarContext';

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
  // Was a viem→ethers-5 adapter (`clientToProvider` + `useEthersProvider`);
  // viem's own client waits for the receipt directly, so ethers is gone.
  const publicClient = usePublicClient({ chainId });

  const { showSnackbar } = useSnackbarContext();

  const checkTransaction = useCallback((tx: Tx) => {
    if (!publicClient) return;
    if (trackedTransactions.has(tx.hash)) return;
    trackedTransactions.add(tx.hash);
    publicClient.waitForTransactionReceipt({ hash: tx.hash as `0x${string}` }).then(() => {
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
  }, [transactions, publicClient, showSnackbar]);

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