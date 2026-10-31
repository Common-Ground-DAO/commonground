// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ChevronDownIcon, ChevronUpIcon, DocumentTextIcon, EnvelopeIcon, UserIcon } from '@heroicons/react/20/solid';
import { Key as PasskeyIcon, Wallet as WalletIcon } from '@phosphor-icons/react';
import Button from 'components/atoms/Button/Button';
import BigWalletIcon from 'components/atoms/BigWalletIcon/BigWalletIcon';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import PasswordField from 'components/molecules/PasswordField/PasswordField';
import WalletSignature from 'components/molecules/WalletSignature/WalletSignature';
import { LoginWithKeyPhraseButton, LoginWithKeyPhraseStatus } from 'components/organisms/UserOnboarding/LoginWithKeyPhrase/LoginWithKeyPhrase';
import { usePasskeyContext } from 'context/PasskeyProvider';
import { useUniversalProfile } from 'context/UniversalProfileProvider';
import { useTwitterAuth } from 'hooks/useTwitterAuth';
import config from 'common/config';
import errors from 'common/errors';
import { validateEmailInput } from 'common/validators';
import loginManager from 'data/appstate/login';
import userApi from 'data/api/user';
import luksoApi from 'data/api/lukso';
import { moreLoginMethods, type MoreLoginMethod } from './authFlowMachine';
import { Divider, errorCode, StepError, StepHeader, type LoggedInHandler, type StepProps } from './shared';
import FarcasterSignIn from './FarcasterSignIn';
import LuksoIcon from '../../atoms/icons/24/Lukso.svg?react';
import FarcasterIcon from '../../atoms/icons/24/Farcaster.svg?react';
import XIcon from '../../atoms/icons/24/X.svg?react';

type LoginProps = StepProps & {
  onLoggedIn: LoggedInHandler;
};

const GENERIC_CREDENTIALS_ERROR = "That email, username or password isn't right.";
/** a conditional request outlives its challenge (10 minutes server-side): renew before */
const AUTOFILL_RENEW_MS = 9 * 60 * 1000;
const AUTOFILL_REARM_DELAY_MS = 3_000;
const AUTOFILL_MAX_FAILURES = 3;
const RATE_LIMITED = "Too many attempts. Please wait a few minutes and try again.";

function looksLikeEmail(value: string) {
  return value.includes('@') && validateEmailInput(value.trim()) === undefined;
}

// ---------------------------------------------------------------------------
// The login form: identifier + password with passkey autofill, then the
// passkey button, wallet, "More" and the way to sign-up.

export const LoginForm: React.FC<LoginProps & {
  identifier: string;
  setIdentifier: (value: string) => void;
}> = ({ state, dispatch, config: flowConfig, onLoggedIn, identifier, setIdentifier }) => {
  const passkey = usePasskeyContext();
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState<'password' | 'passkey' | 'twitter' | null>(null);
  const [showMore, setShowMore] = useState(false);
  const [autofillRun, setAutofillRun] = useState(0);

  const onLoggedInRef = useRef(onLoggedIn);
  onLoggedInRef.current = onLoggedIn;

  // Passkey autofill on the username field ("username webauthn"): armed
  // while the form is shown; a modal ceremony replaces it, so it is armed
  // again afterwards. Renewed every 9 minutes (the challenge expires) and
  // after a failure (a few times, with a pause).
  const { autofillSupported, armAutofill } = passkey;
  const autofillFailures = useRef(0);
  useEffect(() => {
    if (!autofillSupported) {
      return;
    }
    let rearmTimeout: ReturnType<typeof setTimeout> | undefined;
    const disarm = armAutofill(
      response => {
        autofillFailures.current = 0;
        onLoggedInRef.current('passkey', response);
      },
      message => {
        if (message) {
          dispatch({ type: 'ERROR', message });
        }
        autofillFailures.current += 1;
        if (autofillFailures.current <= AUTOFILL_MAX_FAILURES) {
          rearmTimeout = setTimeout(() => setAutofillRun(run => run + 1), AUTOFILL_REARM_DELAY_MS);
        }
      },
    );
    const renew = setTimeout(() => setAutofillRun(run => run + 1), AUTOFILL_RENEW_MS);
    return () => {
      clearTimeout(renew);
      if (rearmTimeout) {
        clearTimeout(rearmTimeout);
      }
      disarm();
    };
  }, [autofillSupported, armAutofill, autofillRun, dispatch]);

  const submitPassword = useCallback(async () => {
    if (!identifier.trim() || !password) {
      dispatch({ type: 'ERROR', message: "Enter your email or username and your password." });
      return;
    }
    setLoading('password');
    try {
      const response = await loginManager.login({ aliasOrEmail: identifier.trim(), password });
      await onLoggedInRef.current('password', response);
    }
    catch (e) {
      const code = errorCode(e);
      dispatch({
        type: 'ERROR',
        message: code === errors.server.RATE_LIMIT_EXCEEDED ? RATE_LIMITED
          // one message for unknown account and wrong password
          : code === errors.server.NOT_FOUND || code === errors.server.NOT_ALLOWED || code === errors.server.VALIDATION || code === errors.server.INVALID_REQUEST
            ? GENERIC_CREDENTIALS_ERROR
            : "Something went wrong, please try again.",
      });
    }
    finally {
      setLoading(null);
    }
  }, [identifier, password, dispatch]);

  const passkeyLogin = useCallback(async () => {
    setLoading('passkey');
    try {
      const outcome = await passkey.login();
      if (outcome.status === 'ok') {
        await onLoggedInRef.current('passkey', outcome.result);
        return;
      }
      if (outcome.status === 'error') {
        dispatch({ type: 'ERROR', message: outcome.message });
      }
      setAutofillRun(run => run + 1);
    }
    finally {
      setLoading(null);
    }
  }, [passkey, dispatch]);

  const twitterLogin = useCallback(async () => {
    setLoading('twitter');
    try {
      const response = await loginManager.login({ account: 'twitter' });
      await onLoggedInRef.current('twitter', response);
    }
    catch (e) {
      dispatch({
        type: 'ERROR',
        message: errorCode(e) === errors.server.ACCOUNT_DOES_NOT_EXIST
          ? "No account here is linked to this X account. Sign in another way, then link X in your settings."
          : "Signing in with X didn't work. Please try again.",
      });
    }
    finally {
      setLoading(null);
    }
  }, [dispatch]);
  // useTwitterAuth reports the finished X authorization while rendering:
  // continue outside of render
  const { attemptConnectTwitter, buttonDisabled: twitterDisabled } = useTwitterAuth(() => {
    setTimeout(twitterLogin, 0);
  });

  const switchToEmailCode = useCallback(() => {
    dispatch({ type: 'USE_EMAIL_CODE' });
  }, [dispatch]);

  const showPasskeyButton = passkey.supported || passkey.legacy;
  const more = moreLoginMethods(flowConfig);

  return (
    <div className='auth-flow-step'>
      <StepHeader title='Log in' subtitle='Welcome back to Common Ground' />

      <form
        className='auth-flow-form'
        onSubmit={ev => { ev.preventDefault(); submitPassword(); }}
      >
        <TextInputField
          label='Email or username'
          iconLeft={<UserIcon className='w-5 h-5' />}
          value={identifier}
          onChange={setIdentifier}
          placeholder='name@email.com'
          autoComplete='username webauthn'
          autoCapitalize='none'
          name='username'
        />
        <PasswordField
          label='Password'
          sublabel=''
          placeholder='Password'
          password={password}
          setPassword={setPassword}
          autoComplete='current-password'
        />
        <StepError message={state.error} />
        {/* the only button inside the form: it submits (click or Enter) */}
        <Button
          className='w-full'
          role='primary'
          text='Log in'
          loading={loading === 'password'}
          disabled={loading !== null}
        />
      </form>

      {config.EMAIL_ENABLED && <Button
        className='w-full'
        role='textual'
        text='Email me a code instead'
        onClick={switchToEmailCode}
        disabled={loading !== null}
      />}

      <Divider />

      {showPasskeyButton && <Button
        className='w-full'
        role='secondary'
        iconLeft={<PasskeyIcon className='w-5 h-5' weight='duotone' />}
        text='Sign in with a passkey'
        onClick={passkeyLogin}
        loading={loading === 'passkey'}
        disabled={loading !== null}
      />}
      <Button
        className='w-full'
        role='secondary'
        iconLeft={<WalletIcon className='w-5 h-5' weight='duotone' />}
        text='Wallet'
        onClick={() => dispatch({ type: 'USE_WALLET' })}
        disabled={loading !== null}
      />
      <Button
        className='w-full'
        role='borderless'
        text='More'
        ariaExpanded={showMore}
        iconRight={showMore ? <ChevronUpIcon className='w-5 h-5' /> : <ChevronDownIcon className='w-5 h-5' />}
        onClick={() => setShowMore(value => !value)}
      />
      {showMore && <div className='auth-flow-more'>
        {more.includes('lukso') && <MoreButton method='lukso' dispatch={dispatch} disabled={loading !== null} />}
        {more.includes('farcaster') && <MoreButton method='farcaster' dispatch={dispatch} disabled={loading !== null} />}
        {config.TWITTER_AUTH_ENABLED && <Button
          className='w-full'
          role='chip'
          iconLeft={<XIcon className='w-5 h-5' />}
          text='X'
          onClick={attemptConnectTwitter}
          loading={loading === 'twitter'}
          disabled={twitterDisabled || loading !== null}
        />}
        {more.includes('recovery-phrase') && <MoreButton method='recovery-phrase' dispatch={dispatch} disabled={loading !== null} />}
        <span className='cg-text-sm-400 cg-text-secondary text-center'>
          These only work for accounts that already have them linked.
        </span>
      </div>}

      <div className='auth-flow-footer cg-text-md-400 cg-text-secondary'>
        <span>New here?</span>
        <Button role='textual' text='Create an account' onClick={() => dispatch({ type: 'SHOW_SIGNUP' })} />
      </div>
    </div>
  );
};

const MORE_LABELS: Record<MoreLoginMethod, { text: string; icon: React.ReactNode }> = {
  'lukso': { text: 'Universal Profile', icon: <LuksoIcon className='w-5 h-5' /> },
  'farcaster': { text: 'Farcaster', icon: <FarcasterIcon className='w-5 h-5' /> },
  'recovery-phrase': { text: 'Recovery phrase (legacy)', icon: <DocumentTextIcon className='w-5 h-5' /> },
};

const MoreButton: React.FC<{ method: MoreLoginMethod; dispatch: StepProps['dispatch']; disabled: boolean }> = ({ method, dispatch, disabled }) => (
  <Button
    className='w-full'
    role='chip'
    iconLeft={<>{MORE_LABELS[method].icon}</>}
    text={MORE_LABELS[method].text}
    onClick={() => dispatch({ type: 'USE_MORE', method })}
    disabled={disabled}
  />
);

// ---------------------------------------------------------------------------
// One-time code by email

let lastCodeSentAt = 0;
const RESEND_COOLDOWN_MS = 30_000;

export const LoginCode: React.FC<LoginProps & { initialEmail: string }> = ({ state, dispatch, onLoggedIn, initialEmail }) => {
  const [email, setEmail] = useState(looksLikeEmail(initialEmail) ? initialEmail.trim() : '');
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [loading, setLoading] = useState<'send' | 'login' | null>(null);

  const sendCode = useCallback(async () => {
    const address = email.trim();
    if (validateEmailInput(address) !== undefined) {
      dispatch({ type: 'ERROR', message: "Enter the email address of your account." });
      return;
    }
    const wait = lastCodeSentAt + RESEND_COOLDOWN_MS - Date.now();
    if (wait > 0) {
      dispatch({ type: 'ERROR', message: `Please wait ${Math.ceil(wait / 1000)} seconds before requesting another code.` });
      return;
    }
    setLoading('send');
    try {
      await userApi.sendOneTimePasswordForLogin({ email: address });
      lastCodeSentAt = Date.now();
      setSentTo(address);
      dispatch({ type: 'ERROR', message: '' });
    }
    catch (e) {
      const code = errorCode(e);
      dispatch({
        type: 'ERROR',
        message: code === errors.server.RATE_LIMIT_EXCEEDED ? RATE_LIMITED
          : code === errors.server.EMAIL_DISABLED ? "This site can't send emails right now."
            : "The code could not be sent. Please try again.",
      });
    }
    finally {
      setLoading(null);
    }
  }, [email, dispatch]);

  const submitCode = useCallback(async () => {
    if (!sentTo || !code.trim()) {
      return;
    }
    setLoading('login');
    try {
      const response = await loginManager.login({ email: sentTo, code: code.trim() });
      await onLoggedIn('code', response);
    }
    catch (e) {
      dispatch({
        type: 'ERROR',
        message: errorCode(e) === errors.server.RATE_LIMIT_EXCEEDED ? RATE_LIMITED : "That code isn't right or has expired.",
      });
    }
    finally {
      setLoading(null);
    }
  }, [sentTo, code, onLoggedIn, dispatch]);

  return (
    <div className='auth-flow-step'>
      <StepHeader
        title='Log in with a code'
        subtitle={sentTo ? <>If an account uses <b>{sentTo}</b>, we sent it a code.</> : "We'll email you a one-time code."}
        onBack={() => dispatch({ type: 'BACK' })}
      />
      {!sentTo && <form className='auth-flow-form' onSubmit={ev => { ev.preventDefault(); sendCode(); }}>
        <TextInputField
          label='Email address'
          iconLeft={<EnvelopeIcon className='w-5 h-5' />}
          value={email}
          onChange={setEmail}
          placeholder='name@email.com'
          type='email'
          autoComplete='email'
          name='email'
        />
        <StepError message={state.error} />
        <Button className='w-full' role='primary' text='Send code' loading={loading === 'send'} disabled={loading !== null} />
      </form>}
      {!!sentTo && <>
        <form className='auth-flow-form' onSubmit={ev => { ev.preventDefault(); submitCode(); }}>
          <TextInputField
            label='Code'
            value={code}
            onChange={setCode}
            placeholder='Code from the email'
            autoComplete='one-time-code'
            name='code'
            autoFocus
          />
          <StepError message={state.error} />
          <Button className='w-full' role='primary' text='Log in' loading={loading === 'login'} disabled={!code.trim() || loading !== null} />
        </form>
        <Button className='w-full' role='textual' text='Send a new code' onClick={() => { setSentTo(null); setCode(''); }} disabled={loading !== null} />
      </>}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Wallet (SIWE)

export const LoginWallet: React.FC<LoginProps> = ({ state, dispatch, onLoggedIn }) => {
  const signed = useCallback(async (data: API.User.prepareWalletAction.Request) => {
    const prepared = await userApi.prepareWalletAction(data);
    if (!prepared.readyForLogin) {
      throw new Error(prepared.walletExists === false
        ? "No account here signs in with this wallet."
        : "This wallet can't be used to sign in.");
    }
    let response: API.User.login.Response;
    try {
      response = await loginManager.login({ account: 'wallet' });
    }
    catch (e) {
      throw new Error(errorCode(e) === errors.server.RATE_LIMIT_EXCEEDED ? RATE_LIMITED : "Signing in with this wallet didn't work. Please try again.");
    }
    await onLoggedIn('wallet', response);
  }, [onLoggedIn]);

  return (
    <div className='auth-flow-step'>
      <StepHeader title='Log in with a wallet' subtitle='Sign a message with the wallet linked to your account.' onBack={() => dispatch({ type: 'BACK' })} />
      <WalletSignature signText='Sign in with this wallet' onSigned={signed} />
      <StepError message={state.error} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// LUKSO Universal Profile (already linked accounts only)

export const LoginLukso: React.FC<LoginProps> = ({ state, dispatch, onLoggedIn }) => {
  const { hasExtension, isConnected, connectToUniversalProfile, confirmOwnership, universalProfileAddress } = useUniversalProfile();
  const [loading, setLoading] = useState(false);

  const signIn = useCallback(async () => {
    setLoading(true);
    try {
      const proof = await confirmOwnership();
      if (!proof) {
        return;
      }
      const prepared = await luksoApi.prepareLuksoAction(proof);
      if (!prepared.readyForLogin) {
        dispatch({ type: 'ERROR', message: "No account here is linked to this Universal Profile. Sign in another way, then link it in your settings." });
        return;
      }
      const response = await loginManager.login({ account: 'lukso' });
      await onLoggedIn('lukso', response);
    }
    catch (e) {
      console.error("Universal Profile login failed", e);
      dispatch({ type: 'ERROR', message: "Signing in with this Universal Profile didn't work. Please try again." });
    }
    finally {
      setLoading(false);
    }
  }, [confirmOwnership, onLoggedIn, dispatch]);

  return (
    <div className='auth-flow-step'>
      <StepHeader title='Log in with Universal Profile' onBack={() => dispatch({ type: 'BACK' })} />
      {!hasExtension && <>
        <span className='cg-text-md-400 cg-text-secondary text-center'>You need the Universal Profile browser extension.</span>
        <Button
          className='w-full'
          role='primary'
          text='Get the extension'
          onClick={() => window.open('https://chrome.google.com/webstore/detail/universal-profiles/abpickdkkbnbcoepogfhkhennhfhehfn', '_blank', 'noreferrer')}
        />
      </>}
      {hasExtension && !isConnected && <Button className='w-full' role='primary' text='Connect Universal Profile' onClick={connectToUniversalProfile} />}
      {hasExtension && isConnected && <>
        <BigWalletIcon walletAddress={universalProfileAddress || ''} style={{ justifySelf: 'center' }} />
        <Button className='w-full' role='primary' text='Sign in with this profile' onClick={signIn} loading={loading} disabled={loading} />
      </>}
      <StepError message={state.error} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// Farcaster (already linked accounts only)

export const LoginFarcaster: React.FC<LoginProps> = ({ state, dispatch, onLoggedIn }) => {
  const verified = useCallback(async (result: API.Accounts.Farcaster.verifyLogin.Response) => {
    if (!result.readyForLogin) {
      dispatch({ type: 'ERROR', message: "No account here is linked to this Farcaster account. Sign in another way, then link it in your settings." });
      return;
    }
    try {
      const response = await loginManager.login({ account: 'farcaster' });
      await onLoggedIn('farcaster', response);
    }
    catch (e) {
      console.error("Farcaster login failed", e);
      dispatch({ type: 'ERROR', message: "Signing in with Farcaster didn't work. Please try again." });
    }
  }, [onLoggedIn, dispatch]);

  return (
    <div className='auth-flow-step'>
      <StepHeader title='Log in with Farcaster' subtitle='Scan the code with your Farcaster app.' onBack={() => dispatch({ type: 'BACK' })} />
      <FarcasterSignIn onVerified={verified} />
      <StepError message={state.error} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// 12-word recovery phrase: legacy CG ID (gateway) instances only

export const LoginRecoveryPhrase: React.FC<LoginProps> = ({ state, dispatch, onLoggedIn }) => {
  const success = useCallback(async () => {
    try {
      const response = await loginManager.login({ account: 'wallet' });
      await onLoggedIn('recovery-phrase', response);
    }
    catch (e) {
      console.error("Recovery phrase login failed", e);
      dispatch({ type: 'ERROR', message: "Signing in with this recovery phrase didn't work." });
    }
  }, [onLoggedIn, dispatch]);

  return (
    <div className='auth-flow-step'>
      <StepHeader title='Recovery phrase' onBack={() => dispatch({ type: 'BACK' })} />
      <LoginWithKeyPhraseStatus />
      <LoginWithKeyPhraseButton success={success} />
      <StepError message={state.error} />
    </div>
  );
};
