// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import Button from 'components/atoms/Button/Button';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import { cooldownLabel, useCooldown } from 'hooks/useCooldown';
import { EMAIL_CODE_LENGTH } from 'common/authInputRules';
import PasswordField from 'components/molecules/PasswordField/PasswordField';
import WalletSignature from 'components/molecules/WalletSignature/WalletSignature';
import { usePasskeyContext } from 'context/PasskeyProvider';
import { useOwnUser, useOwnWallets } from 'context/OwnDataProvider';
import userApi from 'data/api/user';
import loginManager from 'data/appstate/login';
import stepUpManager, { type StepUpRequest } from 'data/auth/stepUp';
import errors from 'common/errors';
import { rateLimitMessage } from 'data/auth/authErrors';
import { retryAfterSecondsOf } from 'data/api/apiError';
import { reauthMethods, shownReauthMethod, type ReauthMethod } from './reauthMethods';
import './ReauthDialog.css';

type Props = {
  request: StepUpRequest;
  /** true after a successful re-authentication, false when cancelled */
  onDone: (confirmed: boolean) => void;
};

/**
 * "Confirm it's you to {action}" (docs/auth-identity §8): re-authentication
 * before a sensitive action, opened by StepUpProvider when the server answers
 * REAUTH_REQUIRED (or a screen asks for a fresh authentication first) — also
 * in a session that came from a transfer link, which is an ordinary sign-in
 * once the account is complete. Of the account's own methods a passkey is
 * offered first, then the password, a sign-in wallet and a verified email (reauthMethods).
 * Every WebAuthn ceremony starts from a click in here.
 */
const ReauthDialog: React.FC<Props> = ({ request, onDone }) => {
  const passkey = usePasskeyContext();
  const ownUser = useOwnUser();
  const wallets = useOwnWallets();
  const hasPasskeys = (ownUser?.passkeys?.length || 0) > 0;
  const canUsePasskey = hasPasskeys && passkey.supported && !passkey.legacy;
  const hasLoginWallet = request.allowWallet && !!wallets?.some(wallet => wallet.loginEnabled && wallet.type === 'evm');
  // whether the account has a password at all (null: not known yet)
  const [hasPassword, setHasPassword] = useState<boolean | null>(null);
  const [passwordPending, setPasswordPending] = useState(true);
  const [emailAddress, setEmailAddress] = useState<string | null>(null);
  const canUseEmail = !!emailAddress;
  const [emailSent, setEmailSent] = useState(false);
  const [emailCode, setEmailCode] = useState('');
  const { left: resendWait, start: startResendWait } = useCooldown();
  const methods = useMemo(() => reauthMethods({ canUsePasskey, hasPassword, hasLoginWallet, canUseEmail }), [canUsePasskey, hasPassword, hasLoginWallet, canUseEmail]);

  // a passkey or a wallet right away; the password form only once the
  // account is known to have one (no password field that goes away again)
  const [method, setMethod] = useState<ReauthMethod | null>(() => shownReauthMethod(null, { canUsePasskey, hasPassword: null, hasLoginWallet, passwordPending: true }));

  useEffect(() => {
    let active = true;
    userApi.getSecurityStatus()
      .then(status => {
        if (active) {
          setHasPassword(status.hasPassword);
          setEmailAddress(status.canReauthenticateWithEmail ? status.email : null);
        }
      })
      // unknown: the password is offered and the server answers
      .catch(() => undefined)
      .finally(() => { if (active) setPasswordPending(false); });
    return () => { active = false; };
  }, []);

  // a method the account turned out not to have gives way to the next one
  useEffect(() => {
    const shown = shownReauthMethod(method, { canUsePasskey, hasPassword, hasLoginWallet, canUseEmail, passwordPending });
    if (shown !== method) {
      setMethod(shown);
    }
  }, [method, canUsePasskey, hasPassword, hasLoginWallet, canUseEmail, passwordPending]);
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

  const sendEmailCode = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      await userApi.requestReauthenticationCode();
      setEmailSent(true);
      setEmailCode('');
      startResendWait();
    }
    catch (e) {
      if (e instanceof Error && e.message === errors.server.RATE_LIMIT_EXCEEDED) {
        startResendWait(retryAfterSecondsOf(e));
        setError(rateLimitMessage(e));
      }
      else {
        setError('The code could not be sent. Please try again.');
      }
    }
    finally { setLoading(false); }
  }, [startResendWait]);

  const confirmEmailCode = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      const { validUntil } = await userApi.reauthenticate({ type: 'verificationCode', code: emailCode });
      confirmed(validUntil);
    }
    catch (e) {
      setError(e instanceof Error && e.message === errors.server.RATE_LIMIT_EXCEEDED
        ? rateLimitMessage(e) : 'That code is incorrect or expired. Try again or request a new code.');
    }
    finally { setLoading(false); }
  }, [emailCode, confirmed]);

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
    if (methods.includes('password') && !passwordPending && method !== 'password') {
      items.push(<Button key='password' role='textual' className='w-full' text='Use your password' onClick={() => { setError(undefined); setMethod('password'); }} />);
    }
    if (methods.includes('passkey') && method !== 'passkey') {
      items.push(<Button key='passkey' role='textual' className='w-full' text='Use a passkey' onClick={() => { setError(undefined); setMethod('passkey'); }} />);
    }
    if (methods.includes('wallet') && method !== 'wallet') {
      items.push(<Button key='wallet' role='textual' className='w-full' text='Use a wallet' onClick={() => { setError(undefined); setMethod('wallet'); }} />);
    }
    if (methods.includes('email') && method !== 'email') {
      items.push(<Button key='email' role='textual' className='w-full' text='Use an email code' onClick={() => { setError(undefined); setMethod('email'); }} />);
    }
    return items;
  }, [method, methods, passwordPending]);

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

        {method === 'passkey' && <Button
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

        {method === 'email' && <div className='flex flex-col gap-3'>
          <span className='cg-text-sm-400 cg-text-secondary'>
            {emailSent ? 'Enter the code sent to' : 'Send a confirmation code to'} {emailAddress}.
          </span>
          {emailSent && <form className='flex flex-col gap-3' onSubmit={ev => { ev.preventDefault(); void confirmEmailCode(); }}>
            <TextInputField label='Confirmation code' value={emailCode}
              onChange={value => setEmailCode(value.replace(/\D/g, '').slice(0, EMAIL_CODE_LENGTH))}
              inputMode='numeric' autoComplete='one-time-code' maxLetters={EMAIL_CODE_LENGTH} autoFocus disabled={loading} />
            <Button role='primary' text='Confirm' loading={loading} disabled={loading || emailCode.length !== EMAIL_CODE_LENGTH} />
          </form>}
          <Button role={emailSent ? 'textual' : 'primary'}
            text={cooldownLabel(emailSent ? 'Send a new code' : 'Send code', resendWait)}
            onClick={sendEmailCode} disabled={loading || resendWait > 0} loading={loading && !emailSent} />
        </div>}

        {method === 'wallet' && <WalletSignature
          signText='Confirm with this wallet'
          hint='Sign a message with a wallet you use to sign in.'
          onSigned={walletSigned}
        />}

        {!!error && <span className='cg-text-md-400 cg-text-error'>{error}</span>}

        {/* no usable passkey and no sign-in wallet: the password may not
            exist either (e.g. an account that signs in with X) — a fresh
            sign-in also counts */}
        {!canUsePasskey && !hasLoginWallet && !canUseEmail && !passwordPending && hasPassword !== true && <div className='flex flex-col gap-2'>
          <span className='cg-text-sm-400 cg-text-secondary'>
            {hasPassword === false
              ? "There's no password on this account. Sign out and sign in again to continue."
              : "No password on this account? Sign out and sign in again to continue."}
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
