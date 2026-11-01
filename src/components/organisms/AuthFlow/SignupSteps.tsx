// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useState } from 'react';
import { EnvelopeIcon, UserIcon } from '@heroicons/react/20/solid';
import { Key as PasskeyIcon, Password as PasswordIcon, Wallet as WalletIcon } from '@phosphor-icons/react';
import Button from 'components/atoms/Button/Button';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import PasswordField from 'components/molecules/PasswordField/PasswordField';
import WalletSignature from 'components/molecules/WalletSignature/WalletSignature';
import SignupCaptcha from 'components/molecules/SignupCaptcha/SignupCaptcha';
import { usePasskeyContext } from 'context/PasskeyProvider';
import errors from 'common/errors';
import { validateEmailInput, validatePassword } from 'common/validators';
import { PASSWORD_MIN_LENGTH } from 'common/passwordPolicy';
import userApi from 'data/api/user';
import { signalUnknownCredential } from 'data/auth/passkeyCeremony';
import { getSignalRpId } from 'data/auth/authMode';
import { captchaAtCreateUser, emailAlreadyVerified, needsEmailVerification, signupMethods, type SignupData } from './authFlowMachine';
import { errorCode, StepError, StepHeader, type StepProps } from './shared';

/** `captchaToken`: only where createUser checks the captcha itself (no email code step) */
export type CreateAccount = (method: Omit<API.User.createUser.Request, 'device' | 'recaptchaToken' | 'displayAccount' | 'useCgProfile'>, captchaToken?: string) => Promise<boolean>;

const CAPTCHA_FIRST = "Please solve the captcha first.";

/**
 * The captcha of a step that calls createUser directly (instances without the
 * email code step); renders nothing when the code request covered it.
 */
function useCreateUserCaptcha(config: StepProps['config']) {
  const needed = captchaAtCreateUser(config);
  const [token, setToken] = useState('');
  const [widgetKey, setWidgetKey] = useState(0);
  const element = needed ? <SignupCaptcha key={widgetKey} onChange={setToken} /> : null;
  return {
    needed,
    token: needed ? token : undefined,
    missing: needed && !token,
    element,
    /** a token is single-use: after a failed attempt, solve again */
    reset: useCallback(() => {
      setToken('');
      setWidgetKey(key => key + 1);
    }, []),
  };
}

const MIN_PASSWORD_LENGTH = PASSWORD_MIN_LENGTH;
const RATE_LIMITED = "Too many attempts. Please wait a few minutes and try again.";
const RESEND_COOLDOWN_MS = 30_000;
const DISPLAY_NAME_PATTERN = /^[a-z0-9_-]{3,30}$/i;
const NAME_RULE = "Use 3-30 characters: letters, numbers, - and _.";
let lastSignupCodeAt = 0;

// ---------------------------------------------------------------------------
// 1. Display name (doubles as username), email — and the captcha, which the
//    server checks with the email code request (instances with mail)

export const SignupDetails: React.FC<StepProps> = ({ state, dispatch, config }) => {
  const [displayName, setDisplayName] = useState(state.signup.displayName);
  const [email, setEmail] = useState(state.signup.email);
  const [captchaToken, setCaptchaToken] = useState('');
  const [captchaKey, setCaptchaKey] = useState(0);
  const [nameError, setNameError] = useState<string | undefined>();
  const [emailError, setEmailError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  // already confirmed in this flow (came back from the method step)
  const alreadyVerified = emailAlreadyVerified(state.signup, email);
  const verifyEmail = needsEmailVerification(config) && !alreadyVerified;

  const submit = useCallback(async () => {
    const name = displayName.trim();
    const address = email.trim();
    // same rule as the server's CgProfileDisplayName
    let nameProblem = DISPLAY_NAME_PATTERN.test(name) ? undefined : NAME_RULE;
    const emailProblem = validateEmailInput(address);
    setEmailError(emailProblem);
    if (nameProblem || emailProblem) {
      setNameError(nameProblem);
      return;
    }
    if (verifyEmail && !captchaToken) {
      dispatch({ type: 'ERROR', message: CAPTCHA_FIRST });
      return;
    }
    setLoading(true);
    try {
      try {
        if (!(await userApi.isCgProfileNameAvailable({ displayName: name }))) {
          nameProblem = "This name is already taken, please pick another one.";
        }
      }
      catch (e) {
        nameProblem = errorCode(e) === errors.server.VALIDATION
          ? NAME_RULE
          : "The name could not be checked, please try again.";
      }
      setNameError(nameProblem);
      if (nameProblem) {
        return;
      }
      if (verifyEmail) {
        // the server answers the same way whether or not the address is
        // taken; the owner of a taken address gets a notice instead of a code
        // (the captcha is checked here, before any mail goes out)
        await userApi.requestSignupEmailCode({ email: address, recaptchaToken: captchaToken });
        lastSignupCodeAt = Date.now();
      }
      else if (!needsEmailVerification(config) && !(await userApi.isEmailAvailable({ email: address }))) {
        setEmailError("This email address is already in use.");
        return;
      }
      const data: SignupData = { displayName: name, email: address };
      dispatch({ type: 'DETAILS_SUBMITTED', data });
    }
    catch (e) {
      const code = errorCode(e);
      if (code === errors.server.CAPTCHA_FAILED) {
        // single-use token: a new one is needed
        setCaptchaToken('');
        setCaptchaKey(key => key + 1);
      }
      dispatch({
        type: 'ERROR',
        message: code === errors.server.RATE_LIMIT_EXCEEDED ? RATE_LIMITED
          : code === errors.server.CAPTCHA_FAILED ? "Please solve the captcha again."
            : "Something went wrong, please try again.",
      });
    }
    finally {
      setLoading(false);
    }
  }, [displayName, email, captchaToken, verifyEmail, config, dispatch]);

  return (
    <div className='auth-flow-step'>
      <StepHeader title='Create your account' subtitle='Already have one?' />
      <Button className='auth-flow-inline-link' role='textual' text='Log in instead' onClick={() => dispatch({ type: 'SHOW_LOGIN' })} />
      <form className='auth-flow-form' onSubmit={ev => { ev.preventDefault(); submit(); }}>
        <TextInputField
          label='Display name'
          subLabel='Also your username. Letters, numbers, - and _'
          iconLeft={<UserIcon className='w-5 h-5' />}
          value={displayName}
          onChange={value => { setDisplayName(value); setNameError(undefined); }}
          placeholder='your_name'
          error={nameError}
          autoComplete='nickname'
          autoCapitalize='none'
          name='displayName'
          maxLetters={30}
        />
        <TextInputField
          label='Email address'
          subLabel={alreadyVerified ? "Confirmed." : verifyEmail ? "We'll send you a code to confirm it." : undefined}
          iconLeft={<EnvelopeIcon className='w-5 h-5' />}
          value={email}
          onChange={value => { setEmail(value); setEmailError(undefined); }}
          placeholder='name@email.com'
          error={emailError}
          type='email'
          autoComplete='email'
          name='email'
        />
        {verifyEmail && <SignupCaptcha key={captchaKey} onChange={setCaptchaToken} />}
        <StepError message={state.error} />
        <Button className='w-full' role='primary' text='Continue' loading={loading} disabled={loading} />
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 2. Confirm the email address (before the account exists)

export const SignupVerify: React.FC<StepProps> = ({ state, dispatch }) => {
  const [code, setCode] = useState('');
  const [loading, setLoading] = useState<'verify' | 'resend' | null>(null);
  const [info, setInfo] = useState<string | undefined>();
  const { email } = state.signup;

  const verify = useCallback(async () => {
    const value = code.replace(/\s+/g, '');
    if (!/^[0-9]{6}$/.test(value)) {
      dispatch({ type: 'ERROR', message: "Enter the 6-digit code from the email." });
      return;
    }
    setLoading('verify');
    try {
      await userApi.verifySignupEmailCode({ email, code: value });
      dispatch({ type: 'EMAIL_VERIFIED' });
    }
    catch (e) {
      const errCode = errorCode(e);
      dispatch({
        type: 'ERROR',
        message: errCode === errors.server.VERIFY_EMAIL_EXPIRED_TOKEN ? "This code has expired. Send a new one."
          : errCode === errors.server.RATE_LIMIT_EXCEEDED ? "Too many wrong codes. Send a new one."
            : "That code isn't right. Check the email and try again.",
      });
    }
    finally {
      setLoading(null);
    }
  }, [code, email, dispatch]);

  const resend = useCallback(async () => {
    const wait = lastSignupCodeAt + RESEND_COOLDOWN_MS - Date.now();
    if (wait > 0) {
      setInfo(`You can request a new code in ${Math.ceil(wait / 1000)} seconds.`);
      return;
    }
    setLoading('resend');
    try {
      // same address, same session: the captcha solved before still counts
      await userApi.requestSignupEmailCode({ email });
      lastSignupCodeAt = Date.now();
      setCode('');
      setInfo("We sent you a new code.");
      dispatch({ type: 'ERROR', message: '' });
    }
    catch (e) {
      const errCode = errorCode(e);
      if (errCode === errors.server.CAPTCHA_FAILED) {
        // the captcha window ran out: back to the details for a new one
        dispatch({ type: 'SIGNUP_FAILED', code: errCode });
        return;
      }
      dispatch({ type: 'ERROR', message: errCode === errors.server.RATE_LIMIT_EXCEEDED ? RATE_LIMITED : "The code could not be sent. Please try again." });
    }
    finally {
      setLoading(null);
    }
  }, [email, dispatch]);

  return (
    <div className='auth-flow-step'>
      <StepHeader
        title='Check your email'
        subtitle={<>We sent a 6-digit code to <b>{email}</b>.</>}
        onBack={() => dispatch({ type: 'BACK' })}
      />
      <form className='auth-flow-form' onSubmit={ev => { ev.preventDefault(); verify(); }}>
        <TextInputField
          label='Code'
          value={code}
          onChange={setCode}
          placeholder='123456'
          autoComplete='one-time-code'
          name='code'
          maxLetters={7}
          autoFocus
        />
        <StepError message={state.error} />
        {!!info && <span className='cg-text-md-400 cg-text-secondary'>{info}</span>}
        <Button className='w-full' role='primary' text='Confirm email' loading={loading === 'verify'} disabled={loading !== null} />
      </form>
      <Button className='w-full' role='textual' text='Send a new code' onClick={resend} loading={loading === 'resend'} disabled={loading !== null} />
      <Button className='w-full' role='textual' text='Use a different email' onClick={() => dispatch({ type: 'BACK' })} disabled={loading !== null} />
    </div>
  );
};

// ---------------------------------------------------------------------------
// 3. "How will you sign in?"

export const SignupMethod: React.FC<StepProps & { createAccount: CreateAccount }> = ({ state, dispatch, config, createAccount }) => {
  const passkey = usePasskeyContext();
  const [loading, setLoading] = useState(false);
  const methods = signupMethods(config);
  // only for the passkey here; password and wallet have it on their own step
  const captcha = useCreateUserCaptcha(config);

  const createPasskey = useCallback(async () => {
    if (captcha.missing) {
      dispatch({ type: 'ERROR', message: CAPTCHA_FIRST });
      return;
    }
    setLoading(true);
    try {
      const outcome = await passkey.register({ displayName: state.signup.displayName });
      if (outcome.status === 'cancelled' || outcome.status === 'reauthenticated') {
        return;
      }
      if (outcome.status === 'error') {
        if (outcome.code === errors.server.EMAIL_VERIFICATION_REQUIRED) {
          dispatch({ type: 'SIGNUP_FAILED', code: outcome.code });
        }
        else {
          dispatch({ type: 'ERROR', message: outcome.message });
        }
        return;
      }
      // the passkey waits in the session; create the account right away
      const created = await createAccount({ usePreparedPasskey: true }, captcha.token);
      if (!created) {
        captcha.reset();
        // no account will ever own this credential: let the browser forget it
        await signalUnknownCredential(getSignalRpId(), outcome.result.credentialId);
      }
    }
    finally {
      setLoading(false);
    }
  }, [passkey, state.signup.displayName, createAccount, dispatch, captcha]);

  return (
    <div className='auth-flow-step'>
      <StepHeader title='How will you sign in?' subtitle={`Signing up as ${state.signup.displayName}`} onBack={() => dispatch({ type: 'BACK' })} />
      {methods.includes('passkey') && <div className='auth-flow-method auth-flow-method-primary'>
        <Button
          className='w-full'
          role='primary'
          iconLeft={<PasskeyIcon className='w-5 h-5' weight='duotone' />}
          text='Create a passkey'
          onClick={createPasskey}
          loading={loading}
          disabled={loading}
        />
        <span className='cg-text-sm-400 cg-text-secondary'>Recommended. Sign in with your fingerprint, face or screen lock — nothing to remember, nothing to phish.</span>
        {captcha.element}
      </div>}
      {methods.includes('password') && <Button
        className='w-full'
        role={methods.includes('passkey') ? 'secondary' : 'primary'}
        iconLeft={<PasswordIcon className='w-5 h-5' weight='duotone' />}
        text='Use a password'
        onClick={() => dispatch({ type: 'CHOOSE_METHOD', method: 'password' })}
        disabled={loading}
      />}
      {methods.includes('wallet') && <Button
        className='w-full'
        role='secondary'
        iconLeft={<WalletIcon className='w-5 h-5' weight='duotone' />}
        text='Use a wallet'
        onClick={() => dispatch({ type: 'CHOOSE_METHOD', method: 'wallet' })}
        disabled={loading}
      />}
      <StepError message={state.error} />
      <span className='cg-text-sm-400 cg-text-secondary text-center'>You can add more ways to sign in later in your settings.</span>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 3b. Password

export const SignupPassword: React.FC<StepProps & { createAccount: CreateAccount }> = ({ state, dispatch, config, createAccount }) => {
  const [password, setPassword] = useState('');
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  const captcha = useCreateUserCaptcha(config);

  const submit = useCallback(async () => {
    const problem = validatePassword(password, MIN_PASSWORD_LENGTH) || undefined;
    setPasswordError(problem);
    if (problem) {
      return;
    }
    if (captcha.missing) {
      dispatch({ type: 'ERROR', message: CAPTCHA_FIRST });
      return;
    }
    setLoading(true);
    try {
      if (!(await createAccount({ useEmailAndPassword: { email: state.signup.email, password } }, captcha.token))) {
        captcha.reset();
      }
    }
    finally {
      setLoading(false);
    }
  }, [password, state.signup.email, createAccount, captcha, dispatch]);

  return (
    <div className='auth-flow-step'>
      <StepHeader title='Choose a password' onBack={() => dispatch({ type: 'BACK' })} />
      <form className='auth-flow-form' onSubmit={ev => { ev.preventDefault(); submit(); }}>
        {/* lets password managers store the new password under the right account */}
        <input type='email' name='email' autoComplete='username' value={state.signup.email} readOnly hidden />
        <PasswordField
          label='Password'
          sublabel=''
          placeholder='Password'
          password={password}
          setPassword={value => { setPassword(value); setPasswordError(undefined); }}
          passwordError={passwordError}
          autoComplete='new-password'
        />
        <ul className='auth-flow-hints cg-text-sm-400 cg-text-secondary'>
          <li>At least {MIN_PASSWORD_LENGTH} characters — longer is better.</li>
          <li>A few random words make a strong, memorable password.</li>
          <li>Don't reuse a password from another site. A password manager helps.</li>
        </ul>
        {captcha.element}
        <StepError message={state.error} />
        <Button className='w-full' role='primary' text='Create account' loading={loading} disabled={loading} />
      </form>
    </div>
  );
};

// ---------------------------------------------------------------------------
// 3c. Wallet (SIWE)

export const SignupWallet: React.FC<StepProps & { createAccount: CreateAccount }> = ({ state, dispatch, config, createAccount }) => {
  const captcha = useCreateUserCaptcha(config);
  const signed = useCallback(async (data: API.User.prepareWalletAction.Request) => {
    const prepared = await userApi.prepareWalletAction(data);
    if (!prepared.readyForCreation) {
      throw new Error(prepared.readyForLogin
        ? "This wallet already belongs to an account. Log in with it instead."
        : "This wallet can't be used for a new account.");
    }
    if (!(await createAccount({ usePreparedWallet: true }, captcha.token))) {
      captcha.reset();
    }
  }, [createAccount, captcha]);

  return (
    <div className='auth-flow-step'>
      <StepHeader title='Sign up with a wallet' subtitle='Sign a message to prove the wallet is yours.' onBack={() => dispatch({ type: 'BACK' })} />
      {captcha.element}
      <WalletSignature signText='Create account with this wallet' onSigned={signed} disabled={captcha.missing} />
      <StepError message={state.error} />
    </div>
  );
};
