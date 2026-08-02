// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import OnboardingLogo from '../OnboardingLogo';
import BigWalletIcon from 'components/atoms/BigWalletIcon/BigWalletIcon';
import Button from 'components/atoms/Button/Button';
import { useUserOnboardingContext, type OnboardingStep, type OnboardingWalletData } from 'context/UserOnboarding';
import type loginManager from 'data/appstate/login';
import { useSignIn, useSignInMessage, QRCode, SignInButton } from '@farcaster/auth-kit';
import userApi from 'data/api/user';
import accountsApi from 'data/api/accounts';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import FarcasterIcon from '../../../atoms/icons/24/Farcaster.svg?react';

type Step = Extract<OnboardingStep, "create-other-option" | "login-other-option" | "create-profile-setup" | "login-finished">;

type Props = {
  step: Step;
  loginFinished: (data: API.Accounts.Farcaster.verifyLogin.Response) => void;
}

export const FarcasterStatus: React.FC<Props> = (props) => {
  const [nonce, setNonce] = useState<string | undefined>();
  const { step } = props;

  useEffect(() => {
    setNonce(undefined);
    if (step === 'create-other-option' || step === 'login-other-option') {
      let mounted = true;
      userApi.getSignableSecret().then((nonce) => {
        if (mounted) {
          setNonce(nonce);
        }
      }).catch((e) => {
        console.error(e);
      });
      return () => {
        mounted = false;
      };
    }
  }, [(step === 'create-other-option' || step === 'login-other-option')]);

  return (<div className='flex flex-col py-8 px-4 items-center justify-between min-h-full'>
    <div className='flex flex-col gap-4 items-center justify-center'>
      <div className='flex flex-col items-center justify-center gap-2'>
        {!nonce ? <span className='cg-text-lg-400 cg-text-main text-center'>Loading...</span> : null}
        {!!nonce ? <InnerStatus {...props} nonce={nonce} /> : null}
      </div>
    </div>
  </div>);
}

export const InnerStatus: React.FC<Props & { nonce: string }> = ({ nonce, loginFinished }) => {
  const { isMobile } = useWindowSizeContext();
  const { data, signIn, error, isError, url, isConnected, connect, appClient, channelToken } = useSignIn({
    nonce,
    onSuccess: (data) => {
      console.log('onSuccess', data);
    },
    onError: (error) => {
      console.error('onError', error);
    },
  });

  const isConnecting = useRef(false);
  useEffect(() => {
    if (!isConnecting.current && !isConnected) {
      isConnecting.current = true;
      connect().finally(() => {
        isConnecting.current = false;
      });
    }
  }, [isConnected]);

  useEffect(() => {
    if (channelToken) {
      const interval = setInterval(() => {
        appClient?.status({ channelToken }).then((status) => {
          if (status.isError) {
            console.error("Error receiving Farcaster status", status.error);
          }
          if (status.data.state === 'pending') {
            console.log("Farcaster login status pending");
          }
          else if (status.data.state === 'completed') {
            console.log("Farcaster login status completed", status.data);
            clearInterval(interval);
            const { message, signature } = status.data;
            if (!!message && !!signature) accountsApi.farcasterVerifyLogin({ message, signature }).then((result) => {
              console.log("Farcaster_verifyLogin", result);
              loginFinished(result);
            });
          }
        });
      }, 1000);
      return () => clearInterval(interval);
    }
  }, [channelToken]);

  return (<>
    {!!url
      ? !isMobile
        ? <QRCode uri={url} size={340} />
        : <a
            href={url}
            rel='noopener noreferrer'
            style={{
              border: '1px solid var(--border-secondary)',
              backgroundColor: 'var(--surface-background-2nd)',
            }}
            target="_blank"
            className='flex justify-center items-center cg-text-main cg-border-l p-4 gap-2'
          >
            <FarcasterIcon className='w-6 h-6' />
            <span className="cg-text-lg-400">Log in</span>
          </a>
      : <span className='cg-text-lg-400 cg-text-main text-center'>Loading...</span>}
    {isError && !!error?.message &&  <span className='cg-text-lg-400 text-palette-error-700 text-center'>{error.message}</span>}
  </>);
}