// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import Button from 'components/atoms/Button/Button';
import CgLogoIcon from 'components/atoms/icons/misc/Logo/logo.svg?react';
import { Key as PasskeyIcon } from '@phosphor-icons/react';
import config from 'common/config';
import errors from 'common/errors';
import userApi from 'data/api/user';
import { retryAfterSecondsOf } from 'data/api/apiError';
import data from 'data';
import { usePasskeyContext } from 'context/PasskeyProvider';
import { useSnackbarContext } from 'context/SnackbarContext';
import { getAuthMode } from 'data/auth/authMode';
import { abortPasskeyCeremony, passkeyAutoRegisterSupported } from 'data/auth/passkeyCeremony';
import { authFlowReducer, initialAuthFlowState, needsEmailVerification, type AuthFlowConfig } from './authFlowMachine';
import { errorCode, StepError, StepHeader, type LoginMethodName } from './shared';
import { LoginCode, LoginFarcaster, LoginForm, LoginLukso, LoginRecoveryPhrase, LoginWallet } from './LoginSteps';
import { SignupDetails, SignupMethod, SignupPassword, SignupVerify, SignupWallet, type CreateAccount } from './SignupSteps';
import './AuthFlow.css';

type Props = {
  initialMode?: 'login' | 'signup';
  /** 'modal': inside the onboarding modal; 'page': the /login route */
  variant: 'modal' | 'page';
  onLoggedIn: (method: LoginMethodName) => void;
  /** the account exists and is logged in; continue with the onboarding tail steps */
  onSignedUp: (info: { email: string | null }) => void;
};

const AUTO_REGISTER_TIMEOUT_MS = 8_000;

function onceFlag(kind: 'autoRegister' | 'prompt', userId: string) {
  const key = `cg-passkey-offer-${kind}:${userId}`;
  return {
    seen: () => {
      try {
        return localStorage.getItem(key) === '1';
      }
      catch {
        return true;
      }
    },
    mark: () => {
      try {
        localStorage.setItem(key, '1');
      }
      catch {
        // private mode: no prompt then
      }
    },
  };
}

/**
 * Login and sign-up (docs/frontend "Auth flow"). One login form — email or
 * username + password with passkey autofill, a code by email, a passkey
 * button, a wallet and "More" — and a sign-up that verifies the email address
 * before the account exists and then asks how the person will sign in.
 * Rendered by the onboarding modal (UserOnboarding) and the /login route.
 */
const AuthFlow: React.FC<Props> = ({ initialMode = 'login', variant, onLoggedIn, onSignedUp }) => {
  const passkey = usePasskeyContext();
  const { showSnackbar } = useSnackbarContext();
  const authMode = getAuthMode();
  const flowConfig = useMemo<AuthFlowConfig>(() => ({
    emailEnabled: config.EMAIL_ENABLED,
    legacy: authMode.legacyCgid,
    passkeysSupported: passkey.supported,
  }), [authMode.legacyCgid, passkey.supported]);
  const reducer = useMemo(() => authFlowReducer(flowConfig), [flowConfig]);
  const [state, dispatch] = useReducer(reducer, initialMode, initialAuthFlowState);
  const [identifier, setIdentifier] = useState('');
  const loggedInWith = useRef<LoginMethodName>('password');
  const finished = useRef(false);

  // the flow ended: hand over exactly once
  useEffect(() => {
    if (state.step !== 'done' || finished.current) {
      return;
    }
    finished.current = true;
    if (state.outcome === 'signup') {
      onSignedUp({ email: state.signup.email || null });
    }
    else {
      onLoggedIn(loggedInWith.current);
    }
  }, [state.step, state.outcome, state.signup.email, onLoggedIn, onSignedUp]);

  // nothing of ours keeps running when the flow goes away
  useEffect(() => () => abortPasskeyCeremony(), []);

  const handleLoggedIn = useCallback(async (method: LoginMethodName, response: API.User.login.Response) => {
    loggedInWith.current = method;
    const userId = response.ownData.id;
    const offerPasskeys = method === 'password' && !authMode.legacyCgid && passkey.supported && response.ownData.passkeys.length === 0;
    if (!offerPasskeys) {
      dispatch({ type: 'LOGGED_IN', offerPasskey: false });
      return;
    }
    // 1) once: let the password manager quietly add a passkey (conditional create)
    const autoRegister = onceFlag('autoRegister', userId);
    if (!autoRegister.seen()) {
      autoRegister.mark();
      if (await passkeyAutoRegisterSupported()) {
        // the timeout covers fetching the options, too: once it fired, the
        // ceremony never starts (and a running one is aborted)
        let timedOut = false;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<{ status: 'cancelled' }>(resolve => {
          timer = setTimeout(() => {
            timedOut = true;
            abortPasskeyCeremony();
            resolve({ status: 'cancelled' });
          }, AUTO_REGISTER_TIMEOUT_MS);
        });
        const outcome = await Promise.race([
          passkey.register({ useAutoRegister: true, beforeStart: () => !timedOut }),
          timeout,
        ]);
        clearTimeout(timer);
        if (outcome.status === 'ok') {
          showSnackbar({ type: 'info', text: 'A passkey was added to your account. Next time, sign in with it.' });
          dispatch({ type: 'LOGGED_IN', offerPasskey: false });
          return;
        }
      }
    }
    // 2) once: ask
    const prompt = onceFlag('prompt', userId);
    if (!prompt.seen()) {
      prompt.mark();
      dispatch({ type: 'LOGGED_IN', offerPasskey: true });
      return;
    }
    dispatch({ type: 'LOGGED_IN', offerPasskey: false });
  }, [authMode.legacyCgid, passkey, showSnackbar]);

  const createAccount = useCallback<CreateAccount>(async (method, captchaToken) => {
    try {
      const { displayName, email } = state.signup;
      await data.user.createUser({
        ...method,
        displayAccount: 'cg',
        useCgProfile: {
          type: 'cg',
          displayName,
          imageId: null,
          extraData: { type: 'cg', description: '', homepage: '', links: [] },
        },
        // after the email code the server already has the captcha
        ...(captchaToken ? { recaptchaToken: captchaToken } : {}),
      });
      if (!needsEmailVerification(flowConfig) && !method.useEmailAndPassword && !!email) {
        // without the code step the address is not verified at sign-up; keep
        // it anyway (the account was just created: a fresh authentication).
        // A server that sends mail (a legacy CG ID process, where this step
        // is skipped) only takes a confirmed address: then mail it a code —
        // the account can confirm it in its settings.
        await data.user.updateOwnData({ email }).catch(async e => {
          if (errorCode(e) === errors.server.EMAIL_VERIFICATION_REQUIRED) {
            await userApi.requestEmailVerification({ email })
              .catch(err => console.warn("Could not send the email confirmation", err));
          }
          else {
            console.warn("Could not store the email address", e);
          }
        });
      }
      dispatch({ type: 'ACCOUNT_CREATED' });
      return true;
    }
    catch (e) {
      dispatch({ type: 'SIGNUP_FAILED', code: errorCode(e) || errors.server.UNKNOWN, retryAfterSeconds: retryAfterSecondsOf(e) });
      return false;
    }
  }, [state.signup, flowConfig]);

  const stepProps = { state, dispatch, config: flowConfig };

  let content: React.ReactNode = null;
  switch (state.step) {
    case 'login':
      content = <LoginForm {...stepProps} onLoggedIn={handleLoggedIn} identifier={identifier} setIdentifier={setIdentifier} />;
      break;
    case 'login-code':
      content = <LoginCode {...stepProps} onLoggedIn={handleLoggedIn} initialEmail={identifier} />;
      break;
    case 'login-wallet':
      content = <LoginWallet {...stepProps} onLoggedIn={handleLoggedIn} />;
      break;
    case 'login-lukso':
      content = <LoginLukso {...stepProps} onLoggedIn={handleLoggedIn} />;
      break;
    case 'login-farcaster':
      content = <LoginFarcaster {...stepProps} onLoggedIn={handleLoggedIn} />;
      break;
    case 'login-recovery-phrase':
      content = <LoginRecoveryPhrase {...stepProps} onLoggedIn={handleLoggedIn} />;
      break;
    case 'signup-details':
      content = <SignupDetails {...stepProps} />;
      break;
    case 'signup-verify':
      content = <SignupVerify {...stepProps} />;
      break;
    case 'signup-method':
      content = <SignupMethod {...stepProps} createAccount={createAccount} />;
      break;
    case 'signup-password':
      content = <SignupPassword {...stepProps} createAccount={createAccount} />;
      break;
    case 'signup-wallet':
      content = <SignupWallet {...stepProps} createAccount={createAccount} />;
      break;
    case 'offer-passkey':
      content = <OfferPasskey {...stepProps} />;
      break;
    case 'done':
      content = null;
      break;
  }

  return (
    <div className={`auth-flow auth-flow-${variant}`}>
      <div className='auth-flow-logo'>
        <CgLogoIcon />
      </div>
      {content}
    </div>
  );
};

/** One-time "Add a passkey" prompt after a password login */
const OfferPasskey: React.FC<Pick<React.ComponentProps<typeof SignupMethod>, 'state' | 'dispatch'>> = ({ state, dispatch }) => {
  const passkey = usePasskeyContext();
  const { showSnackbar } = useSnackbarContext();
  // the "Confirm it's you" dialog was needed: the ceremony needs a new click
  const [confirmed, setConfirmed] = useState(false);

  const add = useCallback(async () => {
    const outcome = await passkey.register();
    if (outcome.status === 'ok') {
      showSnackbar({ type: 'info', text: 'Passkey added. Next time, sign in with it.' });
      dispatch({ type: 'PASSKEY_OFFER_DONE' });
    }
    else if (outcome.status === 'reauthenticated') {
      setConfirmed(true);
    }
    else if (outcome.status === 'error') {
      // a cancelled "Confirm it's you" is not an error
      if (outcome.code !== errors.server.REAUTH_REQUIRED) {
        dispatch({ type: 'ERROR', message: outcome.message });
      }
    }
  }, [passkey, showSnackbar, dispatch]);

  return (
    <div className='auth-flow-step'>
      <div className='auth-flow-offer-icon'>
        <PasskeyIcon className='w-10 h-10' weight='duotone' />
      </div>
      <StepHeader title='Sign in faster next time' subtitle='Add a passkey: your fingerprint, face or screen lock instead of a password. It cannot be phished or leaked.' />
      <Button
        className='w-full'
        role='primary'
        text={confirmed ? 'Create the passkey now' : 'Add a passkey'}
        onClick={add}
        loading={passkey.status === 'busy'}
        disabled={passkey.status === 'busy'}
      />
      <Button className='w-full' role='secondary' text='Not now' onClick={() => dispatch({ type: 'PASSKEY_OFFER_DONE' })} />
      <StepError message={state.error} />
      <span className='cg-text-sm-400 cg-text-secondary text-center'>You can manage passkeys anytime in your account settings.</span>
    </div>
  );
};

export default AuthFlow;
