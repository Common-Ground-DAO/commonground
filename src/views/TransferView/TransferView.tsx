// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router';
import Button from 'components/atoms/Button/Button';
import Jdenticon from 'components/atoms/Jdenticon/Jdenticon';
import { useSignedUrl } from 'hooks/useSignedUrl';
import CgLogoIcon from 'components/atoms/icons/misc/Logo/logo.svg?react';
import { StepError, StepHeader, errorCode } from 'components/organisms/AuthFlow/shared';
import { useConnectionContext } from 'context/ConnectionProvider';
import errors from 'common/errors';
import { rateLimitMessage } from 'data/auth/authErrors';
import { safeNextPath } from 'common/safeNextPath';
import { getUrl } from 'common/util';
import userApi from 'data/api/user';
import loginManager from 'data/appstate/login';
import { forgetTransferToken, getTransferToken } from 'data/auth/transferToken';
import { transferIdentityText } from './transferIdentity';
import 'components/organisms/AuthFlow/AuthFlow.css';
import 'components/organisms/SecurityStep/SecurityStep.css';

const INVALID = "This link has expired or was already used. Go back to the site you came from and get a new one.";

function transferLimitMessage(e: unknown) {
  return rateLimitMessage(e, {
    what: "Too many sign-in links were tried from your network.",
    alternative: "If this account already has a password or a passkey here, you can also log in directly.",
  });
}

/**
 * `/transfer#<token>`: a one-time link from another instance (the app.cg
 * gateway) that signs its account in here (docs/auth-identity §11). The
 * token left the address bar at startup (data/auth/transferToken.ts). The
 * page shows whose account the link belongs to and redeems it only after an
 * explicit "Continue as …"; a different account signed in here is signed out
 * first, never merged.
 */
/** the account's profile image, or its generated avatar */
const AccountImage: React.FC<{ preview: API.User.previewTransferLink.Response }> = ({ preview }) => {
  const imageUrl = useSignedUrl(preview.imageId);
  if (imageUrl) {
    return <img src={imageUrl} alt='' className='rounded-full object-cover' style={{ width: 80, height: 80 }} />;
  }
  return <Jdenticon userId={preview.userId} predefinedSize='80' hideStatus />;
};

const TransferView: React.FC = () => {
  const navigate = useNavigate();
  const { loginState } = useConnectionContext();
  const [token] = useState(() => getTransferToken());
  const [preview, setPreview] = useState<API.User.previewTransferLink.Response | null>(null);
  const [error, setError] = useState<string | undefined>(token ? undefined : INVALID);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!token) {
      return;
    }
    let cancelled = false;
    userApi.previewTransferLink({ token })
      .then(result => {
        if (!cancelled) {
          setPreview(result);
        }
      })
      .catch(e => {
        if (!cancelled) {
          setError(errorCode(e) === errors.server.RATE_LIMIT_EXCEEDED ? transferLimitMessage(e) : INVALID);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [token]);

  const settled = loginState === 'loggedin' || loginState === 'anonymous';
  const currentUserId = loginState === 'loggedin' ? loginManager.currentUser?.userId ?? null : null;
  const sameAccount = !!preview && currentUserId === preview.userId;
  const otherAccount = !!preview && currentUserId !== null && !sameAccount;

  const leave = useCallback((next: string | null | undefined) => {
    forgetTransferToken();
    navigate(safeNextPath(next, window.location.origin) || getUrl({ type: 'home' }), { replace: true });
  }, [navigate]);

  // "This isn't me": the link is used up on the server too, so it cannot be
  // opened again, from this browser's history for example
  const decline = useCallback(() => {
    if (token) {
      userApi.declineTransferLink({ token }).catch(e => console.warn("Could not discard the transfer link", e));
    }
    leave(null);
  }, [token, leave]);

  const continueAs = useCallback(async () => {
    if (!token) {
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      if (loginManager.currentUser) {
        // never into another account's session: sign that one out first
        await loginManager.logout();
      }
      const result = await loginManager.redeemTransferLink(token);
      leave(result.nextPath);
    }
    catch (e) {
      const code = errorCode(e);
      setError(code === errors.server.RATE_LIMIT_EXCEEDED ? transferLimitMessage(e)
        : code === errors.server.TRANSFER_LINK_INVALID ? INVALID
          : "Signing in didn't work. Please try again.");
    }
    finally {
      setBusy(false);
    }
  }, [token, leave]);

  return (
    <div className='transfer-view'>
      <div className='auth-flow auth-flow-page'>
        <div className='auth-flow-logo'>
          <CgLogoIcon />
        </div>
        <div className='auth-flow-step'>
          {!!preview && !error && <>
            <StepHeader
              title={sameAccount ? `You're already signed in as ${preview.displayName}` : `Continue as ${preview.displayName}?`}
              subtitle={sameAccount ? undefined : 'This link signs you in to this account. Only continue if it is yours and you asked for the link.'}
            />
            <div className='flex flex-col items-center gap-2 py-2'>
              <AccountImage preview={preview} />
              <span className='cg-text-lg-500 cg-text-main'>{preview.displayName}</span>
              <span className='cg-text-md-400 cg-text-secondary text-center' style={{ overflowWrap: 'anywhere' }}>{transferIdentityText(preview)}</span>
            </div>
            {otherAccount && <span className='cg-text-md-400 cg-text-secondary text-center'>
              You are signed in here with another account. Continuing signs you out of it.
            </span>}
            {sameAccount
              ? <Button className='w-full' role='primary' text='Continue' onClick={() => leave(null)} />
              : <Button className='w-full' role='primary' text={`Continue as ${preview.displayName}`} onClick={continueAs} loading={busy} disabled={busy || !settled} />}
            {!sameAccount && <Button className='w-full' role='textual' text="This isn't me" onClick={decline} disabled={busy} />}
          </>}
          {!preview && !error && <StepHeader title='Checking your link…' />}
          {!!error && <>
            <StepHeader title="This link doesn't work" />
            <StepError message={error} />
            <Button className='w-full' role='secondary' text='Go to the start page' onClick={() => leave(null)} />
          </>}
        </div>
      </div>
    </div>
  );
};

export default TransferView;
