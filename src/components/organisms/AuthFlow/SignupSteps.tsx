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
import { EMAIL_CODE_GUESSES, EMAIL_CODE_LENGTH, EMAIL_CODE_PATTERN, normalizeEmailCode, PROFILE_NAME_PATTERN, PROFILE_NAME_RULE } from 'common/authInputRules';
import userApi from 'data/api/user';
import { limitKindOf, retryAfterSecondsOf } from 'data/api/apiError';
import { isRateLimited, rateLimitMessage } from 'data/auth/authErrors';
import { cooldownLabel, startCooldownFor, useCooldown } from 'hooks/useCooldown';
import { signalUnknownCredential } from 'data/auth/passkeyCeremony';
import { getSignalRpId } from 'data/auth/authMode';
import { accountLimitMessage, captchaAtCreateUser, emailAlreadyVerified, needsEmailVerification, signupMethods, type SignupData } from './authFlowMachine';
import { errorCode, StepError, StepHeader, type StepProps } from './shared';

/** `captchaToken`: only where createUser checks the captcha itself (no email code step) */
export type CreateAccount = (method: Omit<API.User.createUser.Request, 'device' | 'recaptchaToken' | 'displayAccount' | 'useCgProfile'>, captchaToken?: string) => Promise<boolean>;

const CAPTCHA_FIRST = "Please solve the captcha first.";

/**
 * The captcha of a step that calls createUser directly (instances without the
 * email code step); renders nothing when the code request covered it.
 * `handedOver`: a token the method step's captcha produced (no widget then,
 * until a failed attempt used it up).
 */
function useCreateUserCaptcha(config: StepProps['config'], handedOver?: string) {
  const needed = captchaAtCreateUser(config);
  const [token, setToken] = useState(handedOver ?? '');
  const [showWidget, setShowWidget] = useState(!handedOver);
  const [widgetKey, setWidgetKey] = useState(0);
  const element = needed && showWidget ? <SignupCaptcha key={widgetKey} onChange={setToken} /> : null;
  return {
    needed,
    token: needed ? token : undefined,
    missing: needed && !token,
    element,
    /** a token is single-use: after a failed attempt, solve again */
    reset: useCallback(() => {
      setToken('');
      setShowWidget(true);
      setWidgetKey(key => key + 1);
    }, []),
  };
}

const MIN_PASSWORD_LENGTH = PASSWORD_MIN_LENGTH;
/** a code mailed in this flow still works this long (the server keeps it 15 minutes) */
const CODE_REUSE_MS = 10 * 60 * 1000;
let lastSignupCode: { email: string; at: number } | null = null;

const signupCodeKey = (email: string) => `signup:${email.trim().toLowerCase()}`;

/** a code for this address was mailed in this flow and still works: no new one (and no captcha) needed */
function recentSignupCode(email: string) {
  return !!lastSignupCode
    && lastSignupCode.email === email.trim().toLowerCase()
    && Date.now() - lastSignupCode.at < CODE_REUSE_MS;
}

function rememberSignupCode(email: string) {
  lastSignupCode = { email: email.trim().toLowerCase(), at: Date.now() };
  startCooldownFor(signupCodeKey(email));
}

/**
 * The code of this flow can't be relied on any more (it failed, ran out or
 * the server wants a new captcha): the next "Continue" asks for a new one,
 * with the captcha.
 */
function forgetSignupCode() {
  lastSignupCode = null;
}

/** a refused code request (sign-up): the account limit of the network, or the mail limits */
function signupCodeLimitMessage(e: unknown) {
  if (limitKindOf(e) === 'accounts') {
    return accountLimitMessage(retryAfterSecondsOf(e));
  }
  return rateLimitMessage(e, {
    what: "Too many codes were requested from your network or for this address right now.",
    alternative: "Or use another network (e.g. mobile data instead of Wi-Fi). Already have an account? Log in instead.",
  });
}

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
  // came back from the code step with the same address: that code still works
  const reuseCode = verifyEmail && recentSignupCode(email);

  const submit = useCallback(async () => {
    const name = displayName.trim();
    const address = email.trim();
    // same rule as the server's CgProfileDisplayName
    let nameProblem = PROFILE_NAME_PATTERN.test(name) ? undefined : PROFILE_NAME_RULE;
    const emailProblem = validateEmailInput(address);
    setEmailError(emailProblem);
    if (nameProblem || emailProblem) {
      setNameError(nameProblem);
      return;
    }
    if (verifyEmail && !reuseCode && !captchaToken) {
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
          ? PROFILE_NAME_RULE
          : "The name could not be checked, please try again.";
      }
      setNameError(nameProblem);
      if (nameProblem) {
        return;
      }
      if (verifyEmail && !reuseCode) {
        // the server answers the same way whether or not the address is
        // taken; the owner of a taken address gets a notice instead of a code
        // (the captcha is checked here, before any mail goes out)
        await userApi.requestSignupEmailCode({ email: address, recaptchaToken: captchaToken });
        rememberSignupCode(address);
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
        // the server wants the captcha: show it, even for an address with a code
        forgetSignupCode();
      }
      // the token is single-use and may be spent: solve again for the next try
      setCaptchaToken('');
      setCaptchaKey(key => key + 1);
      dispatch({
        type: 'ERROR',
        message: isRateLimited(e) ? signupCodeLimitMessage(e)
          : code === errors.server.CAPTCHA_FAILED ? "Please solve the captcha again."
            : code === errors.server.VALIDATION ? "That email doesn’t seem right, please double check."
              : "Something went wrong, please try again.",
      });
    }
    finally {
      setLoading(false);
    }
  }, [displayName, email, captchaToken, verifyEmail, reuseCode, config, dispatch]);

  return (
    <div className='auth-flow-step'>
      <StepHeader title='Create your account' subtitle='Already have one?' />
      <Button className='auth-flow-inline-link' role='textual' text='Log in instead' onClick={() => dispatch({ type: 'SHOW_LOGIN' })} />
      <form className='auth-flow-form' noValidate onSubmit={ev => { ev.preventDefault(); submit(); }}>
        {/* no visible labels: the placeholders name the fields (like the login form) */}
        <TextInputField
          ariaLabel='Display name'
          subLabel='Also your username. Letters, numbers, - and _'
          iconLeft={<UserIcon className='w-5 h-5' />}
          value={displayName}
          onChange={value => { setDisplayName(value); setNameError(undefined); }}
          placeholder='Display name'
          error={nameError}
          autoComplete='nickname'
          autoCapitalize='none'
          name='displayName'
          maxLetters={30}
        />
        <TextInputField
          ariaLabel='Email address'
          subLabel={alreadyVerified ? "Confirmed." : reuseCode ? "We already sent you a code." : verifyEmail ? "We'll send you a code to confirm it." : undefined}
          iconLeft={<EnvelopeIcon className='w-5 h-5' />}
          value={email}
          onChange={value => { setEmail(value); setEmailError(undefined); }}
          placeholder='Email address'
          error={emailError}
          type='email'
          autoComplete='email'
          name='email'
        />
        {verifyEmail && !reuseCode && <SignupCaptcha key={captchaKey} onChange={setCaptchaToken} />}
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
  // wrong guesses of the current code: it stops working after EMAIL_CODE_GUESSES
  const [wrongGuesses, setWrongGuesses] = useState(0);
  const { email } = state.signup;
  const { left: resendLeft, start: startResendCooldown } = useCooldown(undefined, signupCodeKey(email));
  const codeUsedUp = wrongGuesses >= EMAIL_CODE_GUESSES;

  const verify = useCallback(async () => {
    const value = normalizeEmailCode(code);
    if (!EMAIL_CODE_PATTERN.test(value)) {
      dispatch({ type: 'ERROR', message: `Enter the ${EMAIL_CODE_LENGTH}-digit code from the email (numbers only).` });
      return;
    }
    if (codeUsedUp) {
      dispatch({ type: 'ERROR', message: "This code was entered wrong too often and no longer works. Send a new one." });
      return;
    }
    setLoading('verify');
    setInfo(undefined);
    try {
      await userApi.verifySignupEmailCode({ email, code: value });
      dispatch({ type: 'EMAIL_VERIFIED' });
    }
    catch (e) {
      const errCode = errorCode(e);
      // going back to the details asks for a new code from now on
      forgetSignupCode();
      let message: string;
      if (errCode === errors.server.VERIFY_EMAIL_EXPIRED_TOKEN) {
        message = "This code has expired (codes work for 15 minutes). Send a new one.";
      }
      else if (isRateLimited(e)) {
        setWrongGuesses(EMAIL_CODE_GUESSES);
        message = "This code was entered wrong too often and no longer works. Send a new one.";
      }
      else if (errCode !== errors.server.VERIFY_EMAIL_INVALID_TOKEN) {
        // not a guess (network, server): nothing counted
        message = "Something went wrong, please try again.";
      }
      else {
        const guesses = wrongGuesses + 1;
        setWrongGuesses(guesses);
        const left = EMAIL_CODE_GUESSES - guesses;
        message = left <= 0 ? "That code isn't right, and it was the last try for this code. Send a new one."
          : left <= 2 ? `That code isn't right. Check the email and try again (${left} ${left === 1 ? 'try' : 'tries'} left for this code).`
            : "That code isn't right. Check the email and try again.";
      }
      dispatch({ type: 'ERROR', message });
    }
    finally {
      setLoading(null);
    }
  }, [code, email, codeUsedUp, wrongGuesses, dispatch]);

  const resend = useCallback(async () => {
    setLoading('resend');
    try {
      // same address, same session: the captcha solved before still counts
      await userApi.requestSignupEmailCode({ email });
      rememberSignupCode(email);
      startResendCooldown();
      setCode('');
      setWrongGuesses(0);
      setInfo("We sent you a new code. It replaces the previous one.");
      dispatch({ type: 'ERROR', message: '' });
    }
    catch (e) {
      const errCode = errorCode(e);
      if (errCode === errors.server.CAPTCHA_FAILED) {
        // the captcha window ran out: back to the details for a new one
        forgetSignupCode();
        dispatch({ type: 'SIGNUP_FAILED', code: errCode });
        return;
      }
      if (isRateLimited(e)) {
        startResendCooldown(retryAfterSecondsOf(e));
      }
      setInfo(undefined);
      dispatch({
        type: 'ERROR',
        message: !isRateLimited(e) ? "The code could not be sent. Please try again."
          : limitKindOf(e) === 'accounts' ? accountLimitMessage(retryAfterSecondsOf(e))
            : rateLimitMessage(e, {
              what: "We can't send another code to this address right now.",
              alternative: "Check your spam folder for the last one.",
            }),
      });
    }
    finally {
      setLoading(null);
    }
  }, [email, dispatch, startResendCooldown]);

  return (
    <div className='auth-flow-step'>
      <StepHeader
        title='Check your email'
        subtitle={<>We sent an {EMAIL_CODE_LENGTH}-digit code to <b>{email}</b>.</>}
        onBack={() => dispatch({ type: 'BACK' })}
      />
      <form className='auth-flow-form' onSubmit={ev => { ev.preventDefault(); verify(); }}>
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
        <Button className='w-full' role='primary' text='Confirm email' loading={loading === 'verify'} disabled={loading !== null} />
      </form>
      <Button
        className='w-full'
        role='textual'
        text={cooldownLabel('Send a new code', resendLeft)}
        onClick={resend}
        loading={loading === 'resend'}
        disabled={loading !== null || resendLeft > 0}
      />
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
  // below the methods: the passkey uses it here, password and wallet get it
  // handed to their step (CHOOSE_METHOD), which asks for one only without it
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
      </div>}
      {methods.includes('password') && <Button
        className='w-full'
        role={methods.includes('passkey') ? 'secondary' : 'primary'}
        iconLeft={<PasswordIcon className='w-5 h-5' weight='duotone' />}
        text='Use a password'
        onClick={() => dispatch({ type: 'CHOOSE_METHOD', method: 'password', captchaToken: captcha.token })}
        disabled={loading}
      />}
      {methods.includes('wallet') && <Button
        className='w-full'
        role='secondary'
        iconLeft={<WalletIcon className='w-5 h-5' weight='duotone' />}
        text='Use a wallet'
        onClick={() => dispatch({ type: 'CHOOSE_METHOD', method: 'wallet', captchaToken: captcha.token })}
        disabled={loading}
      />}
      {methods.includes('passkey') && captcha.element}
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
  const captcha = useCreateUserCaptcha(config, state.signup.captchaToken);

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
      <form className='auth-flow-form' noValidate onSubmit={ev => { ev.preventDefault(); submit(); }}>
        {/* lets password managers store the new password under the right account */}
        <input type='email' name='email' autoComplete='username' value={state.signup.email} readOnly hidden />
        <PasswordField
          label='Password'
          hideLabel
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
  const captcha = useCreateUserCaptcha(config, state.signup.captchaToken);
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
