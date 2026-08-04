// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import './PaySpark.css';
import { PageType } from '../UserSettingsModalContent';
import { useOwnWallets } from 'context/OwnDataProvider';
import Button from 'components/atoms/Button/Button';
import userApi from 'data/api/user';
import useLocalStorage from 'hooks/useLocalStorage';
import {
  useAccount,
  useSignMessage,
  useSwitchChain,
  useSimulateContract,
  useWriteContract,
  useEstimateGas,
  useSendTransaction,
  useWaitForTransactionReceipt,
  usePublicClient,
} from 'wagmi';
import { Chain, erc20Abi, formatUnits, parseUnits } from 'viem';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import EthereumIcon from '../../../atoms/icons/24/Ethereum.svg?react';
import getSiweMessage from 'util/siwe';
import { useSnackbarContext } from 'context/SnackbarContext';
import { useUserOnchainContext } from 'context/UserOnchainProvider';
import ListItem from 'components/atoms/ListItem/ListItem';
import { ChevronDownIcon } from '@heroicons/react/20/solid';
import PaddedIcon from 'components/atoms/PaddedIcon/PaddedIcon';
import config from 'common/config';
import ScreenAwareDropdown from 'components/atoms/ScreenAwareDropdown/ScreenAwareDropdown';
import ExternalIcon, { ExternalIconType } from 'components/atoms/ExternalIcon/ExternalIcon';
import { getBeneficiary, getPayableTokens } from 'common/premiumConfig';
import { getTruncatedId } from '../../../../util';
import SparkIcon from 'components/atoms/icons/misc/spark.svg?react';
import SpinnerIcon from 'components/atoms/icons/16/Spinner.svg?react';

type Props = {
  setCurrentPage: (pageType: PageType) => void;
  lockModal: (lock: boolean) => void;
};

type PayableChainName = 'Hardhat' | 'Gnosis' | 'Ethereum' | 'Base';

function getPayableTokensByChainName(chainName: PayableChainName | undefined): Readonly<{
  title: string;
  address: Common.Address | 'native';
}[]> {
  if (chainName === 'Hardhat') {
    return getPayableTokens('hardhat');
  }
  else if (chainName === 'Gnosis') {
    return getPayableTokens('xdai');
  }
  else if (chainName === 'Ethereum') {
    return getPayableTokens('eth');
  }
  else if (chainName === 'Base') {
    return getPayableTokens('base');
  }
  return [];
}

const PaySpark: React.FC<Props> = (props) => {
  const { setCurrentPage, lockModal } = props;
  const [sparkAmount] = useLocalStorage(0, "CHOSEN_SPARK_AMOUNT");
  const { showSnackbar } = useSnackbarContext();
  const { address } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const wallets = useOwnWallets();
  // wagmi 2: `useNetwork()` folded into `useAccount()`; `useSwitchNetwork` →
  // `useSwitchChain` (`switchChainAsync({ chainId })`).
  const { chain } = useAccount();
  const { chains, error, switchChainAsync } = useSwitchChain();
  const [walletSignError, setWalletSignError] = useState<string>();
  const [tokenBalance, setTokenBalance] = useState<bigint | undefined>();
  const [tokenDecimals, setTokenDecimals] = useState<number | undefined>();
  const { trackTransaction } = useUserOnchainContext();

  const tokenCoinRatio = 1000;

  const payableChains = useMemo(() => {
    if (config.DEPLOYMENT === "dev") {
      return chains.filter(c => c.name === 'Ethereum' || c.name === 'Gnosis' || c.name === 'Base' || c.name === 'Hardhat');
    }
    else {
      return chains.filter(c => c.name === 'Ethereum' || c.name === 'Gnosis' || c.name === 'Base');
    }
  }, [chains]);

  const [paymentChain, setPaymentChain] = useLocalStorage<Chain | undefined>(
    payableChains.find(c => c.id === chain?.id) || payableChains.find(c => c.name === 'Ethereum'),
    'PREFERRED_PAYMENT_CHAIN'
  );

  const beneficiaryAddress = useMemo(() => {
    if (paymentChain) {
      if (paymentChain.name === 'Ethereum') {
        return getBeneficiary('eth');
      }
      else if (paymentChain.name === 'Gnosis') {
        return getBeneficiary('xdai');
      }
      else if (paymentChain.name === 'Base') {
        return getBeneficiary('base');
      }
      else if (paymentChain.name === 'Hardhat') {
        return getBeneficiary('hardhat');
      }
    }
  }, [paymentChain]);

  const payableTokens = useMemo(() => getPayableTokensByChainName(paymentChain?.name as PayableChainName), [paymentChain]);

  const [paymentToken, setPaymentToken] = useLocalStorage<Common.Address | 'native' | undefined>(payableTokens[0]?.address, 'PREFERRED_PAYMENT_TOKEN');
  // const tokenInfoString = useMemo(() => {
  //   if (!paymentToken || !paymentChain) return null;
  //   const tokenTitle = payableTokens.find(t => t.address === paymentToken)?.title || 'unknown currency';
  //   const chainTitle = paymentChain?.name || 'unknown chain';
  //   return `${tokenTitle} on ${chainTitle}`;
  // }, [payableTokens, paymentChain, paymentToken]);

  const priceString = useMemo(() => {
    // if (!tokenInfoString) return null;
    const tokens = sparkAmount / tokenCoinRatio;
    return tokens;
    // return `${tokens} ${tokenInfoString}`;
  }, [sparkAmount]);

  const balanceString = useMemo(() => {
    if (tokenBalance === undefined || tokenDecimals === undefined) return null;
    return `${formatUnits(tokenBalance, tokenDecimals)}`;
  }, [tokenBalance, tokenDecimals]);

  // Balances are read straight off viem's public client now; the ethers 5
  // adapter this used to go through is gone with the wagmi 2 migration.
  const publicClient = usePublicClient({ chainId: paymentChain?.id });

  const updateBalance = useCallback((state: { mounted: boolean }) => {
    if (!!paymentToken && !!paymentChain && !!address && !!publicClient) {
      setTokenBalance(undefined);
      if (paymentToken === 'native') {
        setTokenDecimals(18);
        publicClient.getBalance({ address }).then(balance => {
          if (state.mounted) {
            setTokenBalance(balance);
            setTokenDecimals(18);
          }
        }).catch(e => console.error('Error reading native balance', e));
      }
      else {
        setTokenDecimals(undefined);
        Promise.all([
          publicClient.readContract({
            address: paymentToken as Common.Address,
            abi: erc20Abi,
            functionName: 'balanceOf',
            args: [address],
          }),
          publicClient.readContract({
            address: paymentToken as Common.Address,
            abi: erc20Abi,
            functionName: 'decimals',
          }),
        ]).then(([balance, decimals]) => {
          if (state.mounted) {
            setTokenBalance(balance);
            setTokenDecimals(Number(decimals));
          }
        }).catch(e => console.error('Error reading token balance', e));
      }
    }
  }, [paymentToken, paymentChain, address, publicClient]);

  useEffect(() => {
    const state = { mounted: true };
    updateBalance(state);
    return () => {
      state.mounted = false;
    }
  }, [updateBalance]);

  const payValue = parseUnits((sparkAmount / tokenCoinRatio).toString(), tokenDecimals as number);

  // wagmi 2 split the prepare/execute pair differently: `usePrepareContractWrite`
  // → `useSimulateContract` (whose `data.request` is what `writeContract` takes),
  // and `usePrepareSendTransaction` → plain `useSendTransaction` with the params
  // at call time. The simulate/estimate results are still what gates the
  // "Not enough funds in wallet" state below — a failing simulation or gas
  // estimate is exactly what made wagmi 1 withhold the `write`/`sendTransaction`
  // callback.
  const { data: simulation } = useSimulateContract({
    address: paymentToken === 'native' ? undefined : paymentToken as Common.Address,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [beneficiaryAddress as Common.Address, payValue],
    query: { enabled: !!paymentToken?.startsWith('0x') && !!beneficiaryAddress && tokenDecimals !== undefined },
  });

  const { data: writeData, error: writeError, isError: writeIsError, isPending: isWriteLoading, writeContract } = useWriteContract();

  const { data: gasEstimate } = useEstimateGas({
    to: beneficiaryAddress as Common.Address | undefined,
    value: payValue,
    query: { enabled: paymentToken === 'native' && !!beneficiaryAddress && tokenDecimals !== undefined },
  });

  const { data: sendData, error: sendError, isError: sendIsError, isPending: isSendLoading, sendTransaction } = useSendTransaction();

  const { isSuccess: isWriteSuccess } = useWaitForTransactionReceipt({ hash: writeData });
  const { isSuccess: isSendSuccess } = useWaitForTransactionReceipt({ hash: sendData });

  // wagmi 1 signalled "this transaction cannot be sent" by withholding the
  // `write`/`sendTransaction` callback; wagmi 2 always hands them out, so the
  // equivalent signal is whether the simulation (token) or the gas estimate
  // (native) succeeded.
  const payReady = paymentToken === 'native' ? gasEstimate !== undefined : simulation !== undefined;

  useEffect(() => {
    const state = { mounted: true };
    if (isWriteSuccess) {
      updateBalance(state);
      setCurrentPage('pay-spark-success');
    }
    return () => {
      state.mounted = false;
    }
  }, [isWriteSuccess, setCurrentPage, updateBalance]);

  useEffect(() => {
    const state = { mounted: true };
    if (isSendSuccess) {
      updateBalance(state);
      setCurrentPage('pay-spark-success');
    }
    return () => {
      state.mounted = false;
    }
  }, [isSendSuccess, setCurrentPage, updateBalance]);

  useEffect(() => {
    const hash = writeData;
    if (hash && chain) {
      trackTransaction(hash, chain, `${priceString} sent`);
    }
  }, [chain, priceString, trackTransaction, writeData]);

  useEffect(() => {
    const hash = sendData;
    if (hash && chain) {
      trackTransaction(hash, chain, `${priceString} sent`);
    }
  }, [chain, priceString, sendData, trackTransaction]);

  const networkSwitchNeeded = chain?.id !== paymentChain?.id;

  const isActiveAddressLinked = useMemo(() => {
    return !!wallets?.find(wallet => wallet.walletIdentifier.toLowerCase() === address?.toLowerCase() && wallet.type === 'evm');
  }, [address, wallets]);

  const linkCurrentWallet = useCallback(async () => {
    if (!isActiveAddressLinked && !!address && !!chain) {
      try {
        const secret = await userApi.getSignableSecret();
        const siweMessage = getSiweMessage({ address, secret, chainId: chain.id });
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
  }, [isActiveAddressLinked, address, chain, signMessageAsync, showSnackbar]);

  const walletConnected = useMemo(() => {
    return !!address && !!chain;
  }, [address, chain]);

  const selectedToken = useMemo(() => payableTokens.find(token => token.address === paymentToken), [payableTokens, paymentToken]);

  if (isWriteLoading || isSendLoading) {
    return <div className='flex flex-col px-4 gap-4 cg-text-main p-8 items-center'>
      <SpinnerIcon className='spinner w-14 h-14' />
    </div>
  }
  else if (!walletConnected) {
    return (
      <div className='flex flex-col px-4 gap-4 cg-text-main'>
        <h3>Connect wallet to proceed</h3>
        {!!error?.message && <span className='cg-text-warning cg-text-lg-400'>{error?.message}</span>}
        {!address && !chain &&
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
              connectModalOpen,
            }) => {
              const connected = !!mounted && !!account && !!chain;
              lockModal?.(chainModalOpen || connectModalOpen || accountModalOpen);

              const onClick = () => {
                if (!connected) {
                  openConnectModal();
                }
              }

              return (<Button
                role='primary'
                text="Ethereum Wallet"
                iconLeft={<EthereumIcon className='w-5 h-5' />}
                onClick={onClick}
                disabled={connected}
              />);
            }}
          </ConnectButton.Custom>
        }
        {/* {payableChains.map(c => (
          <Button
            key={c.id}
            onClick={async () => {
              lockModal(true);
              await switchNetworkAsync?.(c.id);
              lockModal(false);
            }}
            disabled={c.id === chain?.id}
            text={c.name}
          />
        ))} */}
      </div>
    )
  }
  else if (!isActiveAddressLinked) {
    return (
      <div className='flex flex-col gap-4 px-4 items-center justify-center'>
        <div className='flex flex-col items-center justify-center gap-2'>
          <span className='cg-heading-3 cg-text-main text-center'>Wallet Connected</span>
          <span className='cg-text-lg-400 cg-text-main text-center'>Please confirm ownership of this wallet to connect it to your account</span>
        </div>
        <Button
          text='Confirm Ownership'
          className='w-full max-w-full'
          role='primary'
          onClick={linkCurrentWallet}
        />
        {walletSignError && <span className='error cg-text-md-400'>{walletSignError}</span>}
      </div>
    );
  }
  else {
    return (<div className='flex flex-col px-4 gap-6 cg-text-main'>
      <div className='flex gap-2'>
        <div className='flex flex-col gap-0.5 flex-1'>
          <span className='cg-text-secondary cg-text-md-400'>Chain</span>
          <ScreenAwareDropdown
            className='pay-spark-dropdown'
            triggerContent={<Button
              className='w-full max-w-full'
              role='secondary'
              text={paymentChain?.name || 'Select'}
              iconLeft={<ExternalIcon type={(paymentChain?.name.toLocaleLowerCase() || '') as ExternalIconType} className='w-5 h-5' />}
              iconRight={<ChevronDownIcon className='cg-text-secondary w-5 h-5' />}
            />}
            triggerClassname='w-full'
            items={payableChains.map(chain => <ListItem
              propagateEventsOnClick
              key={chain.id}
              className='w-full'
              title={chain.name}
              icon={<ExternalIcon type={(chain.name.toLocaleLowerCase() || '') as ExternalIconType} className='w-5 h-5' />}
              onClick={() => {
                const paymentTokens = getPayableTokensByChainName(chain.name as PayableChainName);
                setPaymentToken(paymentTokens[0]?.address);
                setTokenBalance(undefined);
                setPaymentChain(payableChains.find(c => c.id === chain.id));
              }}
            />)}
            placement='bottom-start'
          />
        </div>
        <div className='flex flex-col gap-0.5 flex-1'>
          <span className='cg-text-secondary cg-text-md-400'>Currency</span>
          <ScreenAwareDropdown
            className='pay-spark-dropdown'
            triggerContent={<Button
              className='w-full max-w-full'
              role='secondary'
              text={selectedToken?.title || 'Select token'}
              iconLeft={<ExternalIcon type={(selectedToken?.title.toLocaleLowerCase() || '') as ExternalIconType} className='w-5 h-5' />}
              iconRight={<ChevronDownIcon className='cg-text-secondary w-5 h-5' />}
            />}
            triggerClassname='w-full'
            items={payableTokens.map(token => <ListItem
              key={token.address}
              propagateEventsOnClick
              icon={<ExternalIcon type={(token?.title.toLocaleLowerCase() || '') as ExternalIconType} className='w-5 h-5' />}
              className='w-full'
              title={token.title}
              onClick={() => {
                setTokenBalance(undefined);
                setPaymentToken(token.address);
              }}
            />)}
            placement='bottom-end'
          />
        </div>
      </div>

      <div className='flex flex-col gap-2 cg-text-secondary'>
        <div className='flex justify-between gap-2'>
          <span className='flex-1 cg-text-md-500'>Connected Wallet</span>
          <span className='cg-text-md-400'>{getTruncatedId((address || '').toLowerCase())}</span>
        </div>
        <div className='flex justify-between gap-2'>
          <span className='flex-1 cg-text-md-500'>Balance</span>
          <span className='cg-text-md-400'>{balanceString || 'Loading...'}</span>
        </div>
        {/* <span className='cg-text-lg-500'>Available in your wallet</span>
        <div className='flex gap-2 cg-text-secondary items-center'>
          <PaddedIcon
            icon={<ExternalIcon type={selectedToken?.title.toLocaleLowerCase() || ''} className='w-5 h-5' />}
          />
          
        </div> */}
      </div>

      <div className='flex gap-4 cg-text-main'>
        <div className='flex flex-col gap-2 cg-text-lg-500 flex-1'>
          <span className='cg-text-lg-500'>You spend</span>
          <div className='cg-simple-container cg-border-xl p-2 flex gap-2 items-center w-full'>
            <PaddedIcon icon={<ExternalIcon type={(selectedToken?.title.toLocaleLowerCase() || '') as ExternalIconType} className='w-5 h-5' />} />
            {priceString}
          </div>
        </div>

        <div className='flex flex-col gap-2 cg-text-lg-500 flex-1'>
          <span className='cg-text-lg-500'>You receive</span>
          <div className='cg-simple-container cg-border-xl p-2 flex gap-2 items-center w-full'>
            <PaddedIcon icon={<SparkIcon className='w-5 h-5' />} />
            {sparkAmount}
          </div>
        </div>
      </div>

      {!!networkSwitchNeeded && <Button
        role='primary'
        className='w-full max-w-full'
        text='Switch Network'
        onClick={() => {
          if (paymentChain) switchChainAsync({ chainId: paymentChain.id });
        }}
        disabled={!networkSwitchNeeded && (isWriteLoading || isSendLoading || !paymentToken || !payReady)}
      />}
      {!networkSwitchNeeded && <Button
        role='primary'
        className='w-full max-w-full'
        text={!payReady ? 'Not enough funds in wallet' : 'Confirm purchase'}
        loading={isWriteLoading || isSendLoading}
        onClick={async () => {
          if (paymentToken === 'native') {
            if (beneficiaryAddress) sendTransaction({ to: beneficiaryAddress as Common.Address, value: payValue });
          } else if (simulation) {
            writeContract(simulation.request);
          }
        }}
        disabled={!networkSwitchNeeded && (isWriteLoading || isSendLoading || !paymentToken || !payReady)}
      />}
    </div>);
  }
}

export default React.memo(PaySpark);