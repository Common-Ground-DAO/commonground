// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useRef } from 'react'
import config from 'common/config';
import UserSettingsButton from '../../../molecules/UserSettingsButton/UserSettingsButton';
import { EnvelopeIcon } from '@heroicons/react/24/solid';
import { ChevronRightIcon } from '@heroicons/react/20/solid';
import { PageType } from '../UserSettingsModalContent';
import { ReactComponent as EthereumIcon } from '../../../atoms/icons/24/Ethereum.svg';
import { ReactComponent as XIcon } from '../../../atoms/icons/24/X.svg';
import { ReactComponent as LuksoIcon } from '../../../atoms/icons/24/Lukso.svg';
import { ReactComponent as FarcasterIcon } from '../../../atoms/icons/24/Farcaster.svg';
import { useOwnUser } from 'context/OwnDataProvider';
import { ConnectButton } from '@rainbow-me/rainbowkit';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { useTwitterAuth } from 'hooks/useTwitterAuth';
import userApi from 'data/api/user';
import { useSnackbarContext } from 'context/SnackbarContext';
import { useUniversalProfile } from 'context/UniversalProfileProvider';

type Props = {
  setPage: (pageType: PageType, callback?: () => void) => void;
  lockModal: (lock: boolean) => void;
};

const AvailableProvidersPage: React.FC<Props> = (props) => {
  const ownUser = useOwnUser();
  const { isMobile } = useWindowSizeContext();
  const { connectToUniversalProfile, isConnected: isLuksoConnected, hasExtension: hasUniversalProfileExtension } = useUniversalProfile();
  const { showSnackbar } = useSnackbarContext();
  const { setPage, lockModal } = props;
  const enableRainbowRedirect = useRef<boolean>(false);
  const enableLuksoRedirect = useRef<boolean>(false);

  const onTwitterLogin = useCallback(async () => {
    try {
      await userApi.addUserAccount({ type: 'twitter' });
      setPage('home');
    } catch (e) {
      console.error(e);
      showSnackbar({ type: 'warning', text: 'Failed to add account, please try again later' });
    }
  }, [setPage, showSnackbar]);

  const { attemptConnectTwitter, buttonDisabled } = useTwitterAuth(onTwitterLogin);

  if (enableLuksoRedirect.current && isLuksoConnected) {
    enableLuksoRedirect.current = false;
    setPage('sign-with-universal-profile');
  }

  const hasTwitterAcc = ownUser?.accounts?.find(acc => acc.type === 'twitter');
  const hasLuksoAcc = ownUser?.accounts?.find(acc => acc.type === 'lukso');
  const hasFarcasterAcc = ownUser?.accounts?.find(acc => acc.type === 'farcaster');
  const showIdentitiesSection = !ownUser?.email || !hasTwitterAcc || !hasLuksoAcc || !hasFarcasterAcc;

  const onConnectUniversalProfileClick = useCallback(() => {
    if (!hasUniversalProfileExtension) {
      showSnackbar({
        type: "warning",
        text: "Please install Universal Profile extension first",
      });
      window.open(
        "https://chrome.google.com/webstore/detail/universal-profiles/abpickdkkbnbcoepogfhkhennhfhehfn",
        "_blank",
        "noreferrer",
      );
      return;
    } else {
      if (!isLuksoConnected) {
        enableLuksoRedirect.current = true;
        connectToUniversalProfile();
      } else {
        setPage("sign-with-universal-profile");
      }
    }
  }, [
    connectToUniversalProfile,
    hasUniversalProfileExtension,
    isLuksoConnected,
    setPage,
    showSnackbar,
  ]);

  const onConnectFarcasterClick = useCallback(() => {
    setPage('sign-with-farcaster');
  }, []);

  return (<div className='flex flex-col gap-4 px-4'>
    {showIdentitiesSection && <div className='flex flex-col items-start gap-2 self-stretch'>
      <span className='cg-text-lg-500 cg-text-main'>Identities</span>
      <div className='flex flex-col self-stretch gap-2'>
        {!ownUser?.email && <UserSettingsButton
          text={<div className='flex flex-col cg-text-main'>
            <span className='cg-text-lg-500'>Email account</span>
            <span className='cg-text-md-400'>Add an email and password</span>
          </div>}
          leftElement={<EnvelopeIcon className='w-5 h-5' />}
          rightElement={<ChevronRightIcon className='w-5 h-5' />}
          onClick={() => setPage('email-account-available-providers')}
        />}

        {!hasTwitterAcc && config.TWITTER_AUTH_ENABLED && <UserSettingsButton
          disabled={buttonDisabled}
          text={<div className='flex flex-col cg-text-main'>
            <span className='cg-text-lg-500'>x.com</span>
          </div>}
          leftElement={<XIcon className='w-5 h-5' />}
          rightElement={<ChevronRightIcon className='w-5 h-5' />}
          onClick={attemptConnectTwitter}
        />}
        {!hasLuksoAcc && <UserSettingsButton
        className={`w-full ${isMobile ? 'opacity-50' : ''}`}
          disabled={isMobile}
          text={<div className='flex flex-col cg-text-main'>
            <span className='cg-text-lg-500'>Universal Profile</span>
            {isMobile && <span className='cg-text-md-400 cg-text-secondary whitespace-nowrap text-ellipsis overflow-hidden'>Desktop only</span>}
          </div>}
          leftElement={<LuksoIcon className='w-5 h-5' />}
          rightElement={<ChevronRightIcon className='w-5 h-5' />}
          onClick={onConnectUniversalProfileClick}
        />}
        {!hasFarcasterAcc && <UserSettingsButton
          text={<div className='flex flex-col cg-text-main'>
            <span className='cg-text-lg-500'>Farcaster</span>
          </div>}
          leftElement={<FarcasterIcon className='w-5 h-5' />}
          rightElement={<ChevronRightIcon className='w-5 h-5' />}
          onClick={onConnectFarcasterClick}
        />}
      </div>
    </div>}
    <div className='flex flex-col items-start gap-2 self-stretch'>
      <span className='cg-text-lg-500 cg-text-main'>Wallets</span>
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
          lockModal?.(chainModalOpen || connectModalOpen || accountModalOpen);
          const connected = mounted && account && chain;

          // Move pages if has connected now
          if (enableRainbowRedirect.current && connected) {
            enableRainbowRedirect.current = false;
            setTimeout(() => setPage('sign-wallet'), 0);
          }

          const onClick = () => {
            if (!connected) {
              enableRainbowRedirect.current = true;
              openConnectModal();
            } else {
              setPage('sign-wallet');
            }
          }

          return (<UserSettingsButton
            className='self-stretch'
            text={<div className='flex flex-col cg-text-main'>
              <span className='cg-text-lg-500'>Ethereum Wallet</span>
              <span className='cg-text-md-400 cg-text-secondary'>Rainbow, MetaMask, and more</span>
            </div>}
            leftElement={<EthereumIcon className='w-5 h-5' />}
            rightElement={<ChevronRightIcon className='w-5 h-5' />}
            onClick={onClick}
          />);
        }}
      </ConnectButton.Custom>
    </div>
  </div>);
}

export default React.memo(AvailableProvidersPage);