// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useMemo } from 'react';
import { useContractReads } from 'wagmi';
import { formatUnits } from 'viem';

import Button from 'components/atoms/Button/Button';
import SkeletonLine from 'components/atoms/SkeletonLine/SkeletonLine';
import { useUserSettingsContext } from 'context/UserSettingsProvider';
import { erc20MinimalAbi } from 'common/staking';

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

function formatBalance(value: bigint): string {
  const num = Number(formatUnits(value, 18));
  return num.toLocaleString('en-US', { maximumFractionDigits: num < 1000 ? 2 : 0 });
}

/**
 * The user's linked EVM wallets with their live CG balances, so it's obvious
 * where stakeable tokens sit and which wallet is currently connected.
 * Balances are read client-side straight from the chain.
 */
const WalletOverview: React.FC<{
  wallets: Models.Wallet.Wallet[] | undefined;
  tokenAddress: string;
  chainId: number;
  connectedAddress?: string;
}> = ({ wallets, tokenAddress, chainId, connectedAddress }) => {
  const { setIsOpen, setCurrentPage } = useUserSettingsContext();

  const evmWallets = useMemo(
    () => (wallets ?? []).filter(w => w.type === 'evm' || w.type === 'cg_evm'),
    [wallets],
  );

  const { data: balances } = useContractReads({
    contracts: evmWallets.map(wallet => ({
      address: tokenAddress as `0x${string}`,
      abi: erc20MinimalAbi,
      functionName: 'balanceOf' as const,
      args: [wallet.walletIdentifier as `0x${string}`],
      chainId,
      // wagmi's Narrow<> typing rejects runtime-mapped contract arrays;
      // results are guarded with typeof checks below
    })) as any,
    enabled: evmWallets.length > 0,
    watch: true,
  });

  const openWalletSettings = () => {
    setCurrentPage('wallet');
    setIsOpen(true);
  };

  const totalBalance = (balances ?? []).reduce<bigint>(
    (sum, result) => sum + (typeof result.result === 'bigint' ? result.result : BigInt(0)),
    BigInt(0),
  );

  return <div className='flex flex-col gap-2'>
    <div className='flex items-center justify-between gap-2'>
      <h3 className='cg-heading-3'>Your wallets</h3>
      <Button role='secondary' text='Connect another wallet' onClick={openWalletSettings} />
    </div>
    {wallets === undefined && <SkeletonLine minWidth={180} maxWidth={280} />}
    {wallets !== undefined && evmWallets.length === 0 &&
      <span className='cg-text-md-400 cg-text-secondary'>
        No EVM wallets linked to your account yet — link one to stake and earn Spark.
      </span>}
    {evmWallets.map((wallet, index) => {
      const isConnected = !!connectedAddress &&
        connectedAddress.toLowerCase() === wallet.walletIdentifier.toLowerCase();
      const balance = balances?.[index]?.result;
      return <div key={wallet.id} className='flex items-center justify-between gap-2 p-3 cg-border-m cg-bg-subtle'>
        <div className='flex items-center gap-2 min-w-0'>
          <span className='cg-text-md-500 cg-text-main'>{shortAddress(wallet.walletIdentifier)}</span>
          {isConnected && <span className='cg-text-sm-500 cg-text-brand'>connected</span>}
        </div>
        <span className='cg-text-md-500 cg-text-main shrink-0'>
          {typeof balance === 'bigint' ? `${formatBalance(balance)} CG` : '…'}
        </span>
      </div>;
    })}
    {evmWallets.length > 1 && <div className='flex items-center justify-between px-3'>
      <span className='cg-text-sm-500 cg-text-secondary'>Total</span>
      <span className='cg-text-sm-500 cg-text-main'>{formatBalance(totalBalance)} CG</span>
    </div>}
  </div>;
};

export default WalletOverview;
