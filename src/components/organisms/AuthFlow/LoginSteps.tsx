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
import { EMAIL_CODE_GUESSES, EMAIL_CODE_LENGTH, EMAIL_CODE_PATTERN, normalizeEmailCode } from 'common/authInputRules';
import loginManager from 'data/appstate/login';
import userApi from 'data/api/user';
import { retryAfterSecondsOf } from 'data/api/apiError';
import { isRateLimited, rateLimitMessage } from 'data/auth/authErrors';
import { identifierProblem } from 'data/auth/loginInput';
import { cooldownLabel, useCooldown } from 'hooks/useCooldown';
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

function looksLikeEmail(value: string) {
  return value.includes('@') && validateEmailInput(value.trim()) === undefined;
}

/** "a code by email, a passkey or a wallet": the other ways to sign in on this instance */
function otherMethods(options: { code: boolean; passkey: boolean; password?: boolean }) {
  const methods = [
    ...(options.password ? ['your password'] : []),
    ...(options.code ? ['a code by email'] : []),
    ...(options.passkey ? ['a passkey'] : []),
    'a wallet',
  ];
  return methods.length > 1 ? `${methods.slice(0, -1).join(', ')} or ${methods[methods.length - 1]}` : methods[0];
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
  const [identifierError, setIdentifierError] = useState<string | undefined>();
  const [wrongPasswords, setWrongPasswords] = useState(0);

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

  const showPasskeyButton = passkey.supported || passkey.legacy;

  const submitPassword = useCallback(async () => {
    const problem = identifierProblem(identifier);
    setIdentifierError(problem);
    if (problem) {
      return;
    }
    if (!password) {
      dispatch({ type: 'ERROR', message: "Enter your password." });
      return;
    }
    setLoading('password');
    try {
      const response = await loginManager.login({ aliasOrEmail: identifier.trim(), password });
      await onLoggedInRef.current('password', response);
    }
    catch (e) {
      const code = errorCode(e);
      let message: string;
      if (isRateLimited(e)) {
        message = rateLimitMessage(e, {
          what: "Too many sign-in attempts.",
          alternative: `You can sign in right away with ${otherMethods({ code: config.EMAIL_ENABLED, passkey: showPasskeyButton })}.`,
        });
      }
      // one message for unknown account and wrong password
      else if (code === errors.server.NOT_FOUND || code === errors.server.NOT_ALLOWED || code === errors.server.VALIDATION || code === errors.server.INVALID_REQUEST) {
        const wrong = wrongPasswords + 1;
        setWrongPasswords(wrong);
        message = wrong >= 2 && config.EMAIL_ENABLED
          ? `${GENERIC_CREDENTIALS_ERROR} Forgot your password? Sign in with a code by email instead, then set a new password in your settings.`
          : GENERIC_CREDENTIALS_ERROR;
      }
      else {
        message = "Something went wrong, please try again.";
      }
      dispatch({ type: 'ERROR', message });
    }
    finally {
      setLoading(null);
    }
  }, [identifier, password, wrongPasswords, showPasskeyButton, dispatch]);

  const passkeyLogin = useCallback(async () => {
    setLoading('passkey');
    try {
      const outcome = await passkey.login();
      if (outcome.status === 'ok') {
        await onLoggedInRef.current('passkey', outcome.result);
        return;
      }
      if (outcome.status === 'error') {
        dispatch({
          type: 'ERROR',
          message: outcome.code === errors.server.RATE_LIMIT_EXCEEDED
            ? `${outcome.message} You can sign in right away with ${otherMethods({ code: config.EMAIL_ENABLED, passkey: false, password: true })}.`
            : outcome.message,
        });
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
          onChange={value => { setIdentifier(value); setIdentifierError(undefined); }}
          error={identifierError}
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
// One-time code by email: the address, then the code; "Send a new code"
// waits for the server's per-address cooldown (a countdown on the button)

export const LoginCode: React.FC<LoginProps & { initialEmail: string }> = ({ state, dispatch, onLoggedIn, initialEmail }) => {
  const passkey = usePasskeyContext();
  const [email, setEmail] = useState(looksLikeEmail(initialEmail) ? initialEmail.trim() : '');
  const [emailError, setEmailError] = useState<string | undefined>();
  const [code, setCode] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [loading, setLoading] = useState<'send' | 'login' | null>(null);
  const [info, setInfo] = useState<string | undefined>();
  // wrong guesses of the current code: it stops working after EMAIL_CODE_GUESSES
  const [wrongGuesses, setWrongGuesses] = useState(0);
  const target = (sentTo ?? email).trim().toLowerCase();
  const { left: resendLeft, start: startCooldown } = useCooldown(undefined, `login:${target}`);
  const alternatives = otherMethods({ code: false, password: true, passkey: passkey.supported || passkey.legacy });

  const sendCode = useCallback(async (address: string) => {
    const problem = validateEmailInput(address) !== undefined ? "Enter the email address of your account (e.g. name@example.com)." : undefined;
    setEmailError(problem);
    if (problem) {
      return;
    }
    setLoading('send');
    try {
      await userApi.sendOneTimePasswordForLogin({ email: address });
      startCooldown();
      setSentTo(address);
      setCode('');
      setWrongGuesses(0);
      setInfo(sentTo ? "We sent you a new code. It replaces the previous one." : undefined);
      dispatch({ type: 'ERROR', message: '' });
    }
    catch (e) {
      const code = errorCode(e);
      if (isRateLimited(e)) {
        startCooldown(retryAfterSecondsOf(e));
      }
      setInfo(undefined);
      dispatch({
        type: 'ERROR',
        message: isRateLimited(e)
          ? rateLimitMessage(e, {
            what: "We can't send another code to this address right now.",
            alternative: `Use the last code we sent (check your spam folder), or sign in with ${alternatives}.`,
          })
          : code === errors.server.EMAIL_DISABLED ? "This site can't send emails right now."
            : "The code could not be sent. Please try again.",
      });
    }
    finally {
      setLoading(null);
    }
  }, [sentTo, alternatives, startCooldown, dispatch]);

  const submitCode = useCallback(async () => {
    if (!sentTo) {
      return;
    }
    const value = normalizeEmailCode(code);
    if (!EMAIL_CODE_PATTERN.test(value)) {
      dispatch({ type: 'ERROR', message: `Enter the ${EMAIL_CODE_LENGTH}-digit code from the email (numbers only).` });
      return;
    }
    if (wrongGuesses >= EMAIL_CODE_GUESSES) {
      dispatch({ type: 'ERROR', message: "This code was entered wrong too often and no longer works. Send a new one." });
      return;
    }
    setLoading('login');
    setInfo(undefined);
    try {
      const response = await loginManager.login({ email: sentTo, code: value });
      await onLoggedIn('code', response);
    }
    catch (e) {
      let message: string;
      if (isRateLimited(e)) {
        message = rateLimitMessage(e, {
          what: "Too many wrong codes for this address.",
          alternative: `You can sign in right away with ${alternatives}.`,
        });
      }
      else if (errorCode(e) !== errors.server.VERIFY_EMAIL_INVALID_TOKEN && errorCode(e) !== errors.server.VERIFY_EMAIL_EXPIRED_TOKEN) {
        // not a guess (network, server): nothing counted
        message = "Something went wrong, please try again.";
      }
      else {
        // the answer is the same for a wrong, used-up or expired code and an
        // address that got none; the count is the web app's own
        const guesses = wrongGuesses + 1;
        setWrongGuesses(guesses);
        const left = EMAIL_CODE_GUESSES - guesses;
        message = left <= 0 ? "That code isn't right or has expired, and that was the last try for it. Send a new one."
          : `That code isn't right or has expired (codes work for 15 minutes). Check the email${left <= 2 ? ` (${left} ${left === 1 ? 'try' : 'tries'} left for this code)` : ''} or send a new one.`;
      }
      dispatch({ type: 'ERROR', message });
    }
    finally {
      setLoading(null);
    }
  }, [sentTo, code, wrongGuesses, alternatives, onLoggedIn, dispatch]);

  return (
    <div className='auth-flow-step'>
      <StepHeader
        title='Log in with a code'
        subtitle={sentTo
          ? <>If an account uses <b>{sentTo}</b> as its confirmed address, we sent it a code. No code? If your address was never confirmed, sign in another way and confirm it in your settings.</>
          : "We'll email you a one-time code."}
        onBack={() => dispatch({ type: 'BACK' })}
      />
      {!sentTo && <form className='auth-flow-form' noValidate onSubmit={ev => { ev.preventDefault(); sendCode(email.trim()); }}>
        <TextInputField
          label='Email address'
          iconLeft={<EnvelopeIcon className='w-5 h-5' />}
          value={email}
          onChange={value => { setEmail(value); setEmailError(undefined); }}
          error={emailError}
          placeholder='name@email.com'
          type='email'
          autoComplete='email'
          name='email'
        />
        <StepError message={state.error} />
        <Button
          className='w-full'
          role='primary'
          text={cooldownLabel('Send code', resendLeft)}
          loading={loading === 'send'}
          disabled={loading !== null || resendLeft > 0}
        />
      </form>}
      {!!sentTo && <>
        <form className='auth-flow-form' onSubmit={ev => { ev.preventDefault(); submitCode(); }}>
          <TextInputField
            label='Code'
            value={code}
            onChange={setCode}
            placeholder='12345678'
            autoComplete='one-time-code'
            inputMode='numeric'
            name='code'
            maxLetters={EMAIL_CODE_LENGTH + 1}
            autoFocus
          />
          <StepError message={state.error} />
          {!!info && <span className='cg-text-md-400 cg-text-secondary' role='status'>{info}</span>}
          <Button className='w-full' role='primary' text='Log in' loading={loading === 'login'} disabled={!code.trim() || loading !== null} />
        </form>
        <Button
          className='w-full'
          role='textual'
          text={cooldownLabel('Send a new code', resendLeft)}
          onClick={() => sendCode(sentTo)}
          loading={loading === 'send'}
          disabled={loading !== null || resendLeft > 0}
        />
        <Button
          className='w-full'
          role='textual'
          text='Use a different email'
          onClick={() => { setSentTo(null); setCode(''); setInfo(undefined); dispatch({ type: 'ERROR', message: '' }); }}
          disabled={loading !== null}
        />
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
      throw new Error(isRateLimited(e) ? rateLimitMessage(e) : "Signing in with this wallet didn't work. Please try again.");
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
