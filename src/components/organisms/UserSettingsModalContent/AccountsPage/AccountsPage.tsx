// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import UserSettingsButton from '../../../molecules/UserSettingsButton/UserSettingsButton';
import { useOwnUser, useOwnWallets } from 'context/OwnDataProvider';
import { ChevronRightIcon, EnvelopeIcon, IdentificationIcon } from '@heroicons/react/20/solid';
import { Key as PasskeyIcon } from '@phosphor-icons/react';
import { PageType } from '../UserSettingsModalContent';
import { getTruncatedId } from '../../../../util';
import { ReactComponent as XIcon } from '../../../atoms/icons/24/X.svg';
import { ReactComponent as FuelIcon } from '../../../atoms/icons/24/Fuel.svg';
import { ReactComponent as AeternityIcon } from '../../../atoms/icons/24/Aeternity.svg';
import { ReactComponent as EthereumIcon } from '../../../atoms/icons/24/Ethereum.svg';
import { ReactComponent as LuksoIcon } from '../../../atoms/icons/24/Lukso.svg';
import { ReactComponent as FarcasterIcon } from '../../../atoms/icons/24/Farcaster.svg';

export type ExternalAccountType = Exclude<Models.User.ProfileItemType, 'cg' | 'bot'>;

type Props = {
  setPage: (pageType: PageType) => void;
  setCurrentWallet: (walletId: string) => void;
  setCurrentAccount: (account: ExternalAccountType) => void;
};

const isExternalAccount = (
  account: Models.User.ProfileItemWithDetails,
): account is Models.User.ProfileItemWithDetails & { type: ExternalAccountType } =>
  account.type !== 'cg' && account.type !== 'bot';

export const getAccountIcon = (accountType: Models.User.ProfileItemType) => {
  switch(accountType) {
    case 'twitter': return <XIcon className='w-5 h-5 self-center' />
    case 'lukso': return <LuksoIcon className='w-5 h-5 self-center' />
    case 'farcaster': return <FarcasterIcon className='w-5 h-5 self-center' />
    default: return <></>;
  }
}

export const getAccountName = (accountType: Models.User.ProfileItemType) => {
  switch(accountType) {
    case 'twitter': return 'X';
    case 'lukso': return 'Universal Profile';
    case 'farcaster': return 'Farcaster';
    default: return '';
  }
}

const getWalletIcon = (type: Models.Wallet.Type) => {
  switch (type) {
    case 'cg_evm':
    case 'evm':
      return <EthereumIcon className='w-5 h-5' />;
    case 'fuel':
      return <FuelIcon className='w-5 h-5' />;
    case 'aeternity':
      return <AeternityIcon className='w-5 h-5' />;
    default:
      return <></>;
  }
}

const AccountsPage: React.FC<Props> = (props) => {
  const { setCurrentWallet, setCurrentAccount, setPage } = props;
  const ownUser = useOwnUser();
  const wallets = useOwnWallets();
  return (<div className='flex flex-col px-4 gap-4 cg-text-main'>
  <div className='flex flex-col gap-2'>
    {!!ownUser?.email && <UserSettingsButton
      leftElement={<EnvelopeIcon className='w-5 h-5' />}
      text={ownUser.email}
      rightElement={<ChevronRightIcon className='w-5 h-5' />}
      onClick={() => setPage('email-account-accounts')}
    />}
    {ownUser?.accounts.filter(isExternalAccount).map(acc => <UserSettingsButton
      key={acc.type}
      leftElement={getAccountIcon(acc.type)}
      text={acc.displayName}
      rightElement={<ChevronRightIcon className='w-5 h-5' />}
      onClick={() => {
        setCurrentAccount(acc.type);
        setPage('external-account');
      }}
    />)}
    {wallets?.map(wallet => <UserSettingsButton
      onClick={() => {
        setCurrentWallet(wallet.id);
        setPage('wallet');
      }}
      key={wallet.id}
      leftElement={getWalletIcon(wallet.type)}
      text={wallet.type === "cg_evm" ? "Seed Phrase (legacy)" : getTruncatedId(wallet.walletIdentifier)}
      rightElement={<ChevronRightIcon className='w-5 h-5' />}
    />)}
  </div>
  <div className='cg-separator' />
  <UserSettingsButton
    leftElement={<IdentificationIcon className='w-5 h-5' />}
    text='Add Wallet or Identity'
    rightElement={<ChevronRightIcon className='w-5 h-5' />}
    onClick={() => setPage('available-providers')}
  />
  <UserSettingsButton
    leftElement={<PasskeyIcon className='w-5 h-5' />}
    text='Passkeys'
    rightElement={<ChevronRightIcon className='w-5 h-5' />}
    onClick={() => setPage('passkey-settings')}
  />
</div>);
}

export default React.memo(AccountsPage);
