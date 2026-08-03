// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useRef } from 'react'
import { ConnectButton } from '@rainbow-me/rainbowkit';
import Button, { ButtonRole } from 'components/atoms/Button/Button';
import EthereumIcon from '../../../atoms/icons/24/Ethereum.svg?react';
import LuksoIcon from '../../../atoms/icons/24/Lukso.svg?react';
import FarcasterIcon from '../../../atoms/icons/24/Farcaster.svg?react';
import MetamaskIcon from '../../../atoms/icons/24/MetamaskIcon.svg?react';
import XIcon from '../../../atoms/icons/24/X.svg?react';
import { EnvelopeIcon, DocumentTextIcon } from '@heroicons/react/20/solid';
import { OnboardingStep } from 'context/UserOnboarding';
import { useTwitterAuth } from 'hooks/useTwitterAuth';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import { useUniversalProfile } from 'context/UniversalProfileProvider';
import { useAccount } from 'wagmi';

export type LoginButtonType =
  'x' |
  'metamask' |
  'eth' |
  'lukso' |
  'email' |
  'keyphrase' |
  'farcaster';

export type LoginOption =
  'rainbow' |
  'universal-profile' |
  'email-password' |
  'keyphrase' |
  'farcaster';

type Props = {
  setLoginOption: (option: LoginOption) => void;
  attemptTwitterLogin: (data: API.Twitter.finishLogin.Response) => void;
  availableButtons: LoginButtonType[];
  warning?: string;
}

const SplashLoginActions: React.FC<Props> = (props) => {
  const { attemptTwitterLogin, setLoginOption, warning, availableButtons } = props;
  const { attemptConnectTwitter, buttonDisabled: twitterButtonDisabled } = useTwitterAuth(attemptTwitterLogin);
  const { connectToUniversalProfile, hasExtension: hasUniversalProfileExtension, isConnected: isUniversalProfileConnected } = useUniversalProfile();
  const { address: ethAddress } = useAccount();

  const enableRainbowRedirect = useRef<boolean>(false);
  const enableUniversalProfileRedirect = useRef<boolean>(false);

  useEffect(() => {
    // Move pages if rainbow connected
    if (enableRainbowRedirect.current && !!ethAddress) {
      enableRainbowRedirect.current = false;
      setLoginOption('rainbow');
    }

    if (enableUniversalProfileRedirect.current && isUniversalProfileConnected) {
      enableUniversalProfileRedirect.current = false;
      setLoginOption('universal-profile');
    }
  }, [ethAddress, isUniversalProfileConnected, setLoginOption]);

  const renderButton = (buttonType: LoginButtonType, primary?: boolean) => {
    const role: ButtonRole = primary ? 'primary' : 'chip';
    switch (buttonType) {
      case 'x':
        return <Button
          key='x'
          className='splash-login-button'
          role={role}
          text={<>
            <XIcon className='w-5 h-5' /><br/>
            X
          </>}
          onClick={attemptConnectTwitter}
          disabled={twitterButtonDisabled}
        />;
      case 'email':
        return <Button
          key='email'
          className='splash-login-button'
          role={role}
          text={<>
            <EnvelopeIcon className='w-5 h-5' /><br/>
            Email address
          </>}
          onClick={() => setLoginOption('email-password')}
        />;
      case 'eth':
      case 'metamask':
        return <ConnectButton.Custom key={buttonType}>
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
            // lockModal?.(chainModalOpen || connectModalOpen || accountModalOpen);
            const connected = mounted && account?.address && chain;

            const onClick = () => {
              if (!connected) {
                enableRainbowRedirect.current = true;
                openConnectModal();
              } else {
                setLoginOption('rainbow');
              }
            }

            const icon = buttonType === 'eth'
              ? <EthereumIcon className='w-5 h-5' />
              : <div className='flex'>
                <MetamaskIcon className='w-5 h-5' style={{ zIndex: 1 }} />
                <EthereumIcon className='w-5 h-5 -ml-1' />
              </div>

            return <Button
              key='eth'
              className='splash-login-button'
              role={role}
              text={<>
                {icon}<br/>
                Ethereum Wallet
              </>}
              onClick={onClick}
            />
          }}
        </ConnectButton.Custom>;
      case 'lukso':
        return <Button
          key='lukso'
          className='splash-login-button'
          role={role}
          text={<>
            <LuksoIcon className='w-5 h-5' /><br/>
            Universal Profile
          </>}
          onClick={() => {
            if (!hasUniversalProfileExtension) {
              window.open('https://chrome.google.com/webstore/detail/universal-profiles/abpickdkkbnbcoepogfhkhennhfhehfn', '_blank', 'noreferrer');
            } else if (!isUniversalProfileConnected) {
              enableUniversalProfileRedirect.current = true;
              connectToUniversalProfile();
            } else {
              setLoginOption('universal-profile');
            }
          }}
        />;
      case 'keyphrase':
        return <Button
          key='12-word-keyphrase'
          className='splash-login-button'
          role={role}
          text={<>
            <DocumentTextIcon className='w-5 h-5' /><br/>
            Keyphrase (legacy)
          </>}
          onClick={() => setLoginOption('keyphrase')}
        />;
      case 'farcaster':
        return <Button
          key='farcaster'
          className='splash-login-button'
          role={role}
          text={<>
            <FarcasterIcon className='w-5 h-5' /><br/>
            Farcaster
          </>}
          onClick={() => setLoginOption('farcaster')}
        />;
      default:
        return null;
    }
  }

  return (<div className='flex flex-row flex-wrap items-center justify-start self-center gap-2 max-w-xs w-full'>
    {/*warning && <div className='flex items-start gap-1 self-stretch cg-text-secondary'>
      <InformationCircleIcon className='w-5 h-5 ' />
      <span className='cg-text-md-400'>{warning}</span>
    </div>*/}
    {availableButtons.map(btnType => renderButton(btnType))}
  </div>);
}

export default SplashLoginActions;