// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSignIn, QRCode } from '@farcaster/auth-kit';
import userApi from 'data/api/user';
import accountsApi from 'data/api/accounts';
import { PageType } from '../UserSettingsModalContent';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import FarcasterIcon from '../../../atoms/icons/24/Farcaster.svg?react';

type Props = {
  setPage: (pageType: PageType) => void;
}

export const SignWithFarcaster: React.FC<Props> = (props) => {
  const [nonce, setNonce] = useState<string | undefined>();

  useEffect(() => {
    setNonce(undefined);
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
  }, []);

  return (<div className='flex flex-col py-8 px-4 items-center justify-between min-h-full'>
    <div className='flex flex-col gap-4 items-center justify-center'>
      <div className='flex flex-col items-center justify-center gap-2'>
        {!nonce ? <span className='cg-text-lg-400 cg-text-main text-center'>Loading...</span> : null}
        {!!nonce ? <InnerSign {...props} nonce={nonce} /> : null}
      </div>
    </div>
  </div>);
}

export const InnerSign: React.FC<Props & { nonce: string }> = ({ nonce, setPage }) => {
  const [createError, setCreateError] = useState<string | undefined>();
  const { isMobile } = useWindowSizeContext();
  const [creatingAccount, setCreatingAccount] = useState(false);

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
        setTimeout(() => {
          isConnecting.current = false;
        }, 0);
      });
    }
  }, [isConnected]);

  useEffect(() => {
    let mounted = true;
    let interval: any;
    if (channelToken) {
      setCreateError(undefined);
      interval = setInterval(() => {
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
            if (!!message && !!signature) {
              setCreatingAccount(true);
              accountsApi.farcasterVerifyLogin({ message, signature }).then(async (result) => {
                console.log("Farcaster_verifyLogin", result);
                if (result.readyForCreation) {
                  await userApi.addUserAccount({type:'farcaster'});
                  if (!mounted) return;
                  setPage('accounts');
                }
                else if (result.readyForLogin) {
                  setCreateError("Farcaster account already exists, log out first if you want to switch to this account.");
                }
                else {
                  setCreateError("Farcaster account error");
                }
              }).catch(e => {
                console.log("Farcaster verify error", e);
                setCreateError("Farcaster verify error");
              }).finally(() => {
                setCreatingAccount(false);
              });
            }
          }
        });
      }, 1000);
    }
    return () => {
      mounted = false;
      clearInterval(interval);
    }
  }, [channelToken]);

  return (<>
    {!createError && !creatingAccount && (
      !!url
      ? !isMobile
        ? <QRCode uri={url} size={340} />
        : <a
            href={url}
            rel='noopener noreferrer'
            style={{
              border: '1px solid var(--border-secondary)'
            }}
            target="_blank"
            className='flex justify-center items-center cg-text-main cg-border-l p-4 gap-2'
          >
            <FarcasterIcon className='w-6 h-6' />
            <span className="cg-text-lg-400">Log in</span>
          </a>
      : <div className='cg-text-lg-400 cg-text-main p-8'>Loading...</div>
    )}
    {!!creatingAccount && <div className='cg-text-lg-400 cg-text-main p-8'>Adding farcaster account...</div>}
    {!!createError && <span className='cg-text-lg-400 text-palette-error-700 text-center'>{createError}</span>}
    {isError && !!error?.message && <span className='cg-text-lg-400 text-palette-error-700 text-center'>{error.message}</span>}
  </>);
}