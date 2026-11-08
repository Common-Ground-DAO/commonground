// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { useAccount, useReadContract, useWriteContract, useSwitchChain, useWaitForTransactionReceipt } from 'wagmi';
import { useConnectModal } from '@rainbow-me/rainbowkit';
import { parseUnits, formatUnits } from 'viem';

import Button from 'components/atoms/Button/Button';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import SkeletonLine from 'components/atoms/SkeletonLine/SkeletonLine';
import SparkIcon from 'components/atoms/icons/misc/spark.svg?react';
import { useOwnUser } from 'context/OwnDataProvider';
import { useSnackbarContext } from 'context/SnackbarContext';
import stakingApi from 'data/api/staking';
import userApi from 'data/api/user';
import { useUserSettingsContext } from 'context/UserSettingsProvider';
import LockDurationSlider from './LockDurationSlider';
import WalletOverview from './WalletOverview';
import { chainIds } from 'common/chainIds';
import { previewTotalSpark, stakingContractAbi, erc20MinimalAbi } from 'common/staking';

const chainNames: Partial<Record<Models.Contract.ChainIdentifier, string>> = {
  eth: 'Ethereum',
  base: 'Base',
  xdai: 'Gnosis',
  matic: 'Polygon',
  arbitrum: 'Arbitrum',
  lukso: 'LUKSO',
};

function formatTokens(baseUnits: string | bigint): string {
  const whole = formatUnits(BigInt(baseUnits), 18);
  const num = Number(whole);
  return num.toLocaleString('en-US', { maximumFractionDigits: num < 1000 ? 2 : 0 });
}

function daysUntil(iso: string): number {
  return Math.max(0, Math.ceil((Date.parse(iso) - Date.now()) / 86400000));
}

const PositionRow: React.FC<{
  position: API.Staking.PositionView;
  connectedAddress?: string;
  onUnstake: (positionId: string) => void;
  unstakePending: boolean;
}> = ({ position, connectedAddress, onUnstake, unstakePending }) => {
  const matured = Date.parse(position.unlockAt) <= Date.now();
  const unstaked = !!position.unstakedAt;
  const remaining = daysUntil(position.unlockAt);
  const rightWallet = !!connectedAddress && connectedAddress.toLowerCase() === position.walletAddress;

  return <div className='flex flex-col gap-1 p-3 cg-border-m cg-bg-subtle'>
    <div className='flex items-center justify-between gap-2 flex-wrap'>
      <span className='cg-text-lg-500 cg-text-main'>{formatTokens(position.amount)} CG</span>
      <span className={`cg-text-sm-500 ${unstaked ? 'cg-text-secondary' : matured ? 'cg-text-success' : 'cg-text-brand'}`}>
        {unstaked ? 'Withdrawn' : matured ? 'Unlocked' : `Locked · ${remaining} day${remaining === 1 ? '' : 's'} left`}
      </span>
    </div>
    <span className='cg-text-sm-400 cg-text-secondary'>
      {new Date(position.stakedAt).toLocaleDateString()} → {new Date(position.unlockAt).toLocaleDateString()}
      {' · '}wallet {position.walletAddress.slice(0, 6)}…{position.walletAddress.slice(-4)}
    </span>
    <span className='flex items-center gap-1 cg-text-md-500 cg-text-main'>
      <SparkIcon className='w-4 h-4' />
      {position.accruedSpark.toLocaleString('en-US')} / {position.totalSpark.toLocaleString('en-US')} Spark earned
    </span>
    {matured && !unstaked && <Button
      role='primary'
      text={rightWallet ? 'Unstake' : `Connect ${position.walletAddress.slice(0, 6)}… to unstake`}
      disabled={!rightWallet || unstakePending}
      loading={unstakePending && rightWallet}
      onClick={() => onUnstake(position.positionId)}
    />}
  </div>;
};

const StakeTab: React.FC<{ comingSoon: React.JSX.Element }> = ({ comingSoon }) => {
  const ownUser = useOwnUser();
  const { showSnackbar } = useSnackbarContext();

  const [config, setConfig] = useState<API.Staking.Config | null | undefined>(undefined);
  const [positions, setPositions] = useState<API.Staking.PositionView[] | undefined>(undefined);
  const [amount, setAmount] = useState('');
  const [lockDays, setLockDays] = useState('365');
  const [wallets, setWallets] = useState<Models.Wallet.Wallet[] | undefined>(undefined);
  const [pendingTx, setPendingTx] = useState<{ hash: `0x${string}`; kind: 'approve' | 'stake' | 'unstake' } | null>(null);
  const [unstakingId, setUnstakingId] = useState<string | null>(null);
  // Bumped after a confirmed write so WalletOverview refetches its balances
  // (wagmi 2 has no `watch: true` to do it per block).
  const [balanceRefreshToken, setBalanceRefreshToken] = useState(0);

  const loadServerState = useCallback(async () => {
    try {
      const [{ config: cfg }, pos, ownWallets] = await Promise.all([
        stakingApi.getConfig(),
        stakingApi.getPositions(),
        userApi.getWallets({}),
      ]);
      setConfig(cfg);
      setPositions(pos);
      setWallets(ownWallets);
    } catch (e) {
      console.error('Error loading staking state', e);
      setConfig(null);
    }
  }, []);

  useEffect(() => {
    if (ownUser?.id) loadServerState();
  }, [ownUser?.id, loadServerState]);

  const chainId = config ? chainIds[config.chain] : undefined;
  // wagmi 2: `useNetwork()` folded into `useAccount()`, `useSwitchNetwork` →
  // `useSwitchChain` (which takes `{ chainId }` rather than a bare id).
  const { address, isConnected, chain: connectedChain } = useAccount();
  const { switchChainAsync } = useSwitchChain();
  const { openConnectModal } = useConnectModal();
  const { setIsOpen: setSettingsOpen, setCurrentPage: setSettingsPage } = useUserSettingsContext();
  const onCorrectChain = !!chainId && connectedChain?.id === chainId;

  const amountValid = /^\d+(\.\d+)?$/.test(amount) && Number(amount) > 0;
  const amountWei = useMemo(() => {
    try { return amountValid ? parseUnits(amount as `${number}`, 18) : BigInt(0); } catch { return BigInt(0); }
  }, [amount, amountValid]);
  const lockDaysNumber = Number(lockDays);
  const lockValid = !!config && Number.isInteger(lockDaysNumber) &&
    lockDaysNumber >= config.minLockDays && lockDaysNumber <= config.maxLockDays;

  // wagmi 2: reads are TanStack queries — `enabled` moved under `query`, and
  // `watch` is gone (block-watching is opt-in via `useBlockNumber` + refetch;
  // these two are refetched explicitly after every write instead).
  const { data: balance, refetch: refetchBalance } = useReadContract({
    address: config?.tokenAddress as `0x${string}` | undefined,
    abi: erc20MinimalAbi,
    functionName: 'balanceOf',
    args: address ? [address] : undefined,
    chainId,
    query: { enabled: !!config && !!address },
  });
  const { data: allowance, refetch: refetchAllowance } = useReadContract({
    address: config?.tokenAddress as `0x${string}` | undefined,
    abi: erc20MinimalAbi,
    functionName: 'allowance',
    args: address && config ? [address, config.contractAddress as `0x${string}`] : undefined,
    chainId,
    query: { enabled: !!config && !!address },
  });

  const needsApproval = amountWei > BigInt(0) && allowance !== undefined && (allowance as bigint) < amountWei;
  const insufficientBalance = amountWei > BigInt(0) && balance !== undefined && (balance as bigint) < amountWei;

  // wagmi 2 collapsed the three per-contract `useContractWrite` hooks into one
  // `useWriteContract`: address/abi/functionName move from the hook to the call,
  // and `writeAsync` (which resolved to `{ hash }`) becomes `writeContractAsync`
  // (which resolves to the hash itself).
  const { writeContractAsync } = useWriteContract();

  // wagmi 2 dropped the `onSettled` callback from the receipt hook (it is a
  // TanStack query now), so the settle handling moves into an effect keyed on
  // the query's terminal state.
  const {
    data: receipt,
    error: receiptError,
    isSuccess: receiptSuccess,
    isError: receiptIsError,
  } = useWaitForTransactionReceipt({
    hash: pendingTx?.hash,
    // viem 2 defaults to a 180 s timeout where viem 1 waited indefinitely —
    // without this a merely slow transaction would surface as "failed".
    timeout: 30 * 60 * 1000,
    query: { enabled: !!pendingTx },
  });

  useEffect(() => {
    if (!pendingTx || (!receiptSuccess && !receiptIsError)) return;
    const kind = pendingTx.kind;
    setPendingTx(null);
    setUnstakingId(null);
    // The write moved the allowance and/or the balance. wagmi 1's `watch: true`
    // is gone, so both reads are refetched explicitly here.
    refetchAllowance();
    refetchBalance();
    setBalanceRefreshToken(t => t + 1);
    if (receiptError || receipt?.status !== 'success') {
      showSnackbar({ type: 'warning', text: 'Transaction failed.' });
      return;
    }
    if (kind === 'approve') {
      showSnackbar({ type: 'success', text: 'Approval confirmed — you can stake now.' });
    }
    else if (kind === 'stake') {
      setAmount('');
      showSnackbar({ type: 'success', text: 'Staked! Your position appears below once the chain is indexed (a minute or two).' });
      setTimeout(loadServerState, 45_000);
    }
    else if (kind === 'unstake') {
      showSnackbar({ type: 'success', text: 'Unstaked — tokens are back in your wallet.' });
      setTimeout(loadServerState, 45_000);
    }
  }, [receiptSuccess, receiptIsError, receipt, receiptError]);

  const submit = useCallback(async (kind: 'approve' | 'stake') => {
    if (!config || !chainId) return;
    if (!isConnected) {
      openConnectModal?.();
      return;
    }
    if (!onCorrectChain) {
      await switchChainAsync({ chainId }).catch(() => undefined);
      return;
    }
    try {
      if (kind === 'approve') {
        const hash = await writeContractAsync({
          address: config.tokenAddress as `0x${string}`,
          abi: erc20MinimalAbi,
          functionName: 'approve',
          args: [config.contractAddress as `0x${string}`, amountWei],
        });
        setPendingTx({ hash, kind: 'approve' });
      } else {
        const hash = await writeContractAsync({
          address: config.contractAddress as `0x${string}`,
          abi: stakingContractAbi,
          functionName: 'stake',
          args: [amountWei, BigInt(lockDaysNumber * 86400)],
        });
        setPendingTx({ hash, kind: 'stake' });
      }
    } catch (e) {
      console.error(`Error sending ${kind} transaction`, e);
      const message = (e as any)?.shortMessage || (e as Error)?.message || '';
      if (!/user rejected|user denied/i.test(message)) {
        showSnackbar({ type: 'warning', text: `Could not send the ${kind} transaction: ${message.slice(0, 140) || 'unknown error'}` });
      }
    }
  }, [config, chainId, isConnected, onCorrectChain, openConnectModal, switchChainAsync, writeContractAsync, amountWei, lockDaysNumber]);

  const unstake = useCallback(async (positionId: string) => {
    if (!chainId) return;
    if (!onCorrectChain) {
      await switchChainAsync({ chainId }).catch(() => undefined);
      return;
    }
    try {
      setUnstakingId(positionId);
      if (!config) return;
      const hash = await writeContractAsync({
        address: config.contractAddress as `0x${string}`,
        abi: stakingContractAbi,
        functionName: 'unstake',
        args: [BigInt(positionId)],
      });
      setPendingTx({ hash, kind: 'unstake' });
    } catch (e) {
      setUnstakingId(null);
      console.error('Error sending unstake transaction', e);
      const message = (e as any)?.shortMessage || (e as Error)?.message || '';
      if (!/user rejected|user denied/i.test(message)) {
        showSnackbar({ type: 'warning', text: `Could not send the unstake transaction: ${message.slice(0, 140) || 'unknown error'}` });
      }
    }
  }, [chainId, config, onCorrectChain, switchChainAsync, writeContractAsync]);

  // anonymous visitors and unconfigured instances keep the informational page
  if (!ownUser?.id || config === null) return comingSoon;
  if (config === undefined) {
    return <div className='flex flex-col gap-3 p-4 cg-content-stack cg-border-xl'>
      <SkeletonLine minWidth={180} maxWidth={280} />
      <SkeletonLine minWidth={120} maxWidth={220} />
    </div>;
  }

  const linkedEvmAddresses = new Set(
    (wallets ?? [])
      .filter(w => w.type === 'evm' || w.type === 'cg_evm')
      .map(w => w.walletIdentifier.toLowerCase()),
  );
  const connectedNotLinked = isConnected && !!address &&
    wallets !== undefined && !linkedEvmAddresses.has(address.toLowerCase());

  const txPending = !!pendingTx;
  const previewSpark = amountValid && lockValid
    ? previewTotalSpark(Number(amount), lockDaysNumber, config.baseRate)
    : null;
  const earnsNothing = previewSpark === 0;
  // smallest amount that earns at least 1 Spark at the selected duration
  const minViableAmount = lockValid
    ? Math.ceil(1 / (config.baseRate * (lockDaysNumber / 365) * (1 + lockDaysNumber / 365)))
    : null;

  const allowanceUnknown = isConnected && onCorrectChain && amountValid && allowance === undefined;
  const primaryAction = !isConnected ? 'connect'
    : !onCorrectChain ? 'switch'
    : allowanceUnknown ? 'checking'
    : needsApproval ? 'approve'
    : 'stake';
  const primaryLabel = {
    connect: 'Connect wallet',
    switch: `Switch to ${chainNames[config.chain] ?? config.chain}`,
    checking: 'Checking allowance…',
    approve: 'Approve CG',
    stake: 'Stake for Spark',
  }[primaryAction];

  return <div className='flex flex-col gap-6 cg-content-stack cg-border-xl p-4'>
    <div className='flex flex-col gap-1'>
      <div className='flex gap-1 items-center'>
        <SparkIcon className='w-6 h-6' />
        <h2 className='cg-heading-2'>Stake CG, earn Spark</h2>
      </div>
      <span className='cg-text-md-400 cg-text-secondary'>
        Lock CG tokens on {chainNames[config.chain] ?? config.chain} for {config.minLockDays}–{config.maxLockDays} days.
        While they are locked you earn Spark daily — longer locks earn a higher rate.
      </span>
    </div>

    <WalletOverview
      wallets={wallets}
      tokenAddress={config.tokenAddress}
      chainId={chainId!}
      connectedAddress={address}
      refreshToken={balanceRefreshToken}
    />

    <div className='flex flex-col gap-3'>
      <TextInputField
        value={amount}
        onChange={setAmount}
        label='Amount (CG)'
        placeholder='1000000'
      />
      {insufficientBalance && <span className='cg-text-sm-400 text-red-500'>
        Not enough CG in this wallet (balance: {balance !== undefined ? formatTokens(balance as bigint) : '…'}).
      </span>}
      <LockDurationSlider
        lockDays={lockDaysNumber}
        minLockDays={config.minLockDays}
        maxLockDays={config.maxLockDays}
        baseRate={config.baseRate}
        tokenAmount={amountValid ? Number(amount) : 0}
        onChange={days => setLockDays(String(days))}
      />
      {earnsNothing && <span className='cg-text-sm-500 text-red-500'>
        This amount is too small to earn any Spark over {lockDaysNumber} days
        {minViableAmount !== null ? ` — stake at least ${minViableAmount.toLocaleString('en-US')} CG at this duration to earn Spark` : ''}.
        Staking is disabled so you don't lock tokens for nothing.
      </span>}
      <span className='cg-text-sm-500 text-red-500'>
        Staked tokens are locked until the unlock date. There is no early withdrawal — not for support,
        not for anyone.
      </span>
      <Button
        role='primary'
        className='max-w-full w-full'
        iconLeft={<SparkIcon className='w-5 h-5' />}
        text={primaryLabel}
        loading={txPending && pendingTx?.kind !== 'unstake'}
        disabled={txPending || primaryAction === 'checking' || (primaryAction === 'approve' || primaryAction === 'stake'
          ? !amountValid || !lockValid || insufficientBalance || earnsNothing
          : false)}
        onClick={() => {
          if (primaryAction === 'connect') openConnectModal?.();
          else if (primaryAction === 'switch') switchChainAsync({ chainId: chainId! }).catch(() => undefined);
          else if (primaryAction === 'approve' || primaryAction === 'stake') submit(primaryAction);
        }}
      />
      {connectedNotLinked && <div className='flex flex-col gap-2 p-3 cg-border-m' style={{ border: '1px solid rgb(239 68 68)' }}>
        <span className='cg-text-md-500 text-red-500'>
          The connected wallet {address ? `${address.slice(0, 6)}…${address.slice(-4)}` : ''} is not linked
          to your Common Ground account. Staking from it earns no Spark until you link it — and linking is
          never retroactive.
        </span>
        <Button role='secondary' text='Link this wallet' onClick={() => { setSettingsPage('wallet'); setSettingsOpen(true); }} />
      </div>}
      {!connectedNotLinked && <span className='cg-text-sm-400 cg-text-secondary'>
        Stake from a wallet that is linked to your Common Ground account — positions from unlinked
        wallets do not earn Spark until the wallet is linked (and never retroactively).
      </span>}
    </div>

    <div className='flex flex-col gap-2'>
      <h3 className='cg-heading-3'>Your positions</h3>
      {positions === undefined && <SkeletonLine minWidth={180} maxWidth={280} />}
      {positions !== undefined && positions.length === 0 &&
        <span className='cg-text-md-400 cg-text-secondary'>No staking positions yet.</span>}
      {positions?.map(position => <PositionRow
        key={position.id}
        position={position}
        connectedAddress={address}
        onUnstake={unstake}
        unstakePending={unstakingId === position.positionId && txPending}
      />)}
    </div>
  </div>;
};

export default StakeTab;
