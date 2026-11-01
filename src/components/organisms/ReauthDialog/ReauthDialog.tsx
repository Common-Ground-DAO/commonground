// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useMemo, useState } from 'react';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import Button from 'components/atoms/Button/Button';
import PasswordField from 'components/molecules/PasswordField/PasswordField';
import WalletSignature from 'components/molecules/WalletSignature/WalletSignature';
import { usePasskeyContext } from 'context/PasskeyProvider';
import { useOwnUser, useOwnWallets } from 'context/OwnDataProvider';
import userApi from 'data/api/user';
import loginManager from 'data/appstate/login';
import stepUpManager, { type StepUpRequest } from 'data/auth/stepUp';
import errors from 'common/errors';
import { rateLimitMessage } from 'data/auth/authErrors';
import './ReauthDialog.css';

type Props = {
  request: StepUpRequest;
  /** true after a successful re-authentication, false when cancelled */
  onDone: (confirmed: boolean) => void;
};

type Method = 'choose' | 'password' | 'wallet';

/**
 * "Confirm it's you to {action}" (docs/auth-identity §8): re-authentication
 * before a sensitive action, opened by StepUpProvider when the server answers
 * REAUTH_REQUIRED (or a screen asks for a fresh authentication first). A
 * passkey is offered first, then the password, then a sign-in wallet. Every
 * WebAuthn ceremony starts from a click in here.
 */
const ReauthDialog: React.FC<Props> = ({ request, onDone }) => {
  const passkey = usePasskeyContext();
  const ownUser = useOwnUser();
  const wallets = useOwnWallets();
  const hasPasskeys = (ownUser?.passkeys?.length || 0) > 0;
  const canUsePasskey = hasPasskeys && passkey.supported && !passkey.legacy;
  const hasLoginWallet = request.allowWallet && !!wallets?.some(wallet => wallet.loginEnabled && wallet.type === 'evm');

  const [method, setMethod] = useState<Method>(canUsePasskey ? 'choose' : 'password');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const confirmed = useCallback((validUntil: number) => {
    stepUpManager.markAuthenticated(validUntil);
    onDone(true);
  }, [onDone]);

  const confirmWithPasskey = useCallback(async () => {
    setError(undefined);
    const outcome = await passkey.reauthenticate();
    if (outcome.status === 'ok') {
      onDone(true);
    }
    else if (outcome.status === 'error') {
      setError(outcome.message);
    }
  }, [passkey, onDone]);

  const submitPassword = useCallback(async () => {
    if (!password) {
      return;
    }
    setError(undefined);
    setLoading(true);
    try {
      const { validUntil } = await userApi.reauthenticate({ type: 'password', password });
      confirmed(validUntil);
    }
    catch (e) {
      const code = e instanceof Error ? e.message : undefined;
      if (code === errors.server.NOT_ALLOWED) {
        setError("That password isn't correct.");
      }
      else if (code === errors.server.RATE_LIMIT_EXCEEDED) {
        setError(rateLimitMessage(e, { what: "Too many attempts to confirm it's you." }));
      }
      else {
        setError("Something went wrong, please try again.");
      }
    }
    finally {
      setLoading(false);
    }
  }, [password, confirmed]);

  const walletSigned = useCallback(async (data: API.User.prepareWalletAction.Request) => {
    const prepared = await userApi.prepareWalletAction(data);
    if (!prepared.readyForLogin) {
      throw new Error("This wallet can't be used to sign in to your account.");
    }
    try {
      const { validUntil } = await userApi.reauthenticate({ type: 'wallet' });
      confirmed(validUntil);
    }
    catch (e) {
      const code = e instanceof Error ? e.message : undefined;
      throw new Error(code === errors.server.RATE_LIMIT_EXCEEDED
        ? rateLimitMessage(e, { what: "Too many attempts to confirm it's you." })
        : "This wallet can't be used to sign in to your account.");
    }
  }, [confirmed]);

  const signOut = useCallback(async () => {
    onDone(false);
    await loginManager.logout();
  }, [onDone]);

  const alternatives = useMemo(() => {
    const items: React.ReactNode[] = [];
    if (method !== 'password') {
      items.push(<Button key='password' role='textual' className='w-full' text='Use your password' onClick={() => { setError(undefined); setMethod('password'); }} />);
    }
    if (canUsePasskey && method !== 'choose') {
      items.push(<Button key='passkey' role='textual' className='w-full' text='Use a passkey' onClick={() => { setError(undefined); setMethod('choose'); }} />);
    }
    if (hasLoginWallet && method !== 'wallet') {
      items.push(<Button key='wallet' role='textual' className='w-full' text='Use a wallet' onClick={() => { setError(undefined); setMethod('wallet'); }} />);
    }
    return items;
  }, [method, canUsePasskey, hasLoginWallet]);

  return (
    <ScreenAwareModal
      isOpen
      hideHeader
      onClose={() => onDone(false)}
      customClassname='reauth-dialog-modal'
    >
      <div className='reauth-dialog'>
        <div className='flex flex-col gap-1'>
          <span className='cg-heading-3 cg-text-main'>Confirm it's you</span>
          <span className='cg-text-md-400 cg-text-secondary'>To {request.action}, confirm it's you first.</span>
        </div>

        {method === 'choose' && <Button
          className='w-full'
          role='primary'
          text='Use a passkey'
          onClick={confirmWithPasskey}
          loading={passkey.status === 'busy'}
          disabled={passkey.status === 'busy'}
        />}

        {method === 'password' && <form
          className='flex flex-col gap-3'
          onSubmit={ev => { ev.preventDefault(); submitPassword(); }}
        >
          <PasswordField
            label='Password'
            sublabel=''
            password={password}
            setPassword={setPassword}
            autoComplete='current-password'
            autoFocus
          />
          {/* the only button in the form: submits it (click or Enter) */}
          <Button
            className='w-full'
            role='primary'
            text='Confirm'
            loading={loading}
            disabled={!password || loading}
          />
        </form>}

        {method === 'wallet' && <WalletSignature
          signText='Confirm with this wallet'
          hint='Sign a message with a wallet you use to sign in.'
          onSigned={walletSigned}
        />}

        {!!error && <span className='cg-text-md-400 cg-text-error'>{error}</span>}

        {/* no passkey here and no sign-in wallet: the password may not exist
            either (e.g. an account that signs in with X) — a fresh sign-in
            also counts */}
        {!hasPasskeys && !hasLoginWallet && <div className='flex flex-col gap-2'>
          <span className='cg-text-sm-400 cg-text-secondary'>
            No password on this account? Sign out and sign in again to continue.
          </span>
          <Button className='w-full' role='chip' text='Sign out' onClick={signOut} />
        </div>}

        {alternatives.length > 0 && <div className='flex flex-col gap-1'>{alternatives}</div>}

        <Button className='w-full' role='secondary' text='Cancel' onClick={() => onDone(false)} />
      </div>
    </ScreenAwareModal>
  );
};

export default ReauthDialog;
