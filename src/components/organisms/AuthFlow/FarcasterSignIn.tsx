// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useRef, useState } from 'react';
import { useSignIn, QRCode } from '@farcaster/auth-kit';
import userApi from 'data/api/user';
import accountsApi from 'data/api/accounts';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import FarcasterIcon from '../../atoms/icons/24/Farcaster.svg?react';

type Props = {
  onVerified: (result: API.Accounts.Farcaster.verifyLogin.Response) => void;
};

/**
 * Sign in with Farcaster (QR code on desktop, deep link on mobile). The
 * nonce is a fresh server secret; the signed message is verified by
 * Accounts/farcasterVerifyLogin, whose result says whether an account is
 * linked to this Farcaster id.
 */
const FarcasterSignIn: React.FC<Props> = ({ onVerified }) => {
  const [nonce, setNonce] = useState<string | undefined>();

  useEffect(() => {
    let mounted = true;
    userApi.getSignableSecret().then((value) => {
      if (mounted) {
        setNonce(value);
      }
    }).catch((e) => {
      console.error(e);
    });
    return () => {
      mounted = false;
    };
  }, []);

  if (!nonce) {
    return <span className='cg-text-lg-400 cg-text-main text-center'>Loading...</span>;
  }
  return <FarcasterChannel nonce={nonce} onVerified={onVerified} />;
};

const FarcasterChannel: React.FC<Props & { nonce: string }> = ({ nonce, onVerified }) => {
  const { isMobile } = useWindowSizeContext();
  const { error, isError, url, isConnected, connect, appClient, channelToken } = useSignIn({ nonce });
  const onVerifiedRef = useRef(onVerified);
  onVerifiedRef.current = onVerified;

  const isConnecting = useRef(false);
  useEffect(() => {
    if (!isConnecting.current && !isConnected) {
      isConnecting.current = true;
      connect().finally(() => {
        isConnecting.current = false;
      });
    }
  // connect once per disconnect, as before (connect's identity is not stable)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isConnected]);

  useEffect(() => {
    if (!channelToken) {
      return;
    }
    const interval = setInterval(() => {
      appClient?.status({ channelToken }).then((status) => {
        if (status.isError) {
          console.error("Error receiving Farcaster status", status.error);
        }
        else if (status.data.state === 'completed') {
          clearInterval(interval);
          const { message, signature } = status.data;
          if (!!message && !!signature) {
            accountsApi.farcasterVerifyLogin({ message, signature })
              .then(result => onVerifiedRef.current(result))
              .catch(e => console.error("Farcaster verification failed", e));
          }
        }
      });
    }, 1000);
    return () => clearInterval(interval);
  }, [channelToken, appClient]);

  return (<div className='flex flex-col items-center gap-2'>
    {!!url
      ? !isMobile
        ? <QRCode uri={url} size={280} />
        : <a
            href={url}
            rel='noopener noreferrer'
            target="_blank"
            className='flex justify-center items-center cg-text-main cg-border-l p-4 gap-2 auth-flow-farcaster-link'
          >
            <FarcasterIcon className='w-6 h-6' />
            <span className="cg-text-lg-400">Open Farcaster</span>
          </a>
      : <span className='cg-text-lg-400 cg-text-main text-center'>Loading...</span>}
    {isError && !!error?.message && <span className='cg-text-md-400 cg-text-error text-center'>{error.message}</span>}
  </div>);
};

export default FarcasterSignIn;
