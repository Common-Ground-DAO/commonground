// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useState } from 'react';
import { CheckCircleIcon, EnvelopeIcon } from '@heroicons/react/20/solid';
import { Key as PasskeyIcon, Password as PasswordIcon, Wallet as WalletIcon } from '@phosphor-icons/react';
import Button from 'components/atoms/Button/Button';
import CgLogoIcon from 'components/atoms/icons/misc/Logo/logo.svg?react';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import PasswordField from 'components/molecules/PasswordField/PasswordField';
import WalletSignature from 'components/molecules/WalletSignature/WalletSignature';
import EmailCodeConfirm from 'components/molecules/EmailCodeConfirm/EmailCodeConfirm';
import { cooldownLabel, useCooldown } from 'hooks/useCooldown';
import { StepError, StepHeader, errorCode } from 'components/organisms/AuthFlow/shared';
import { usePasskeyContext } from 'context/PasskeyProvider';
import errors from 'common/errors';
import { PASSWORD_MIN_LENGTH } from 'common/passwordPolicy';
import { validateEmailInput, validatePassword } from 'common/validators';
import userApi from 'data/api/user';
import loginManager from 'data/appstate/login';
import securityStepState, { nextSecurityStepTask, type SecurityStepTask } from 'data/auth/securityStep';
import { isRateLimited, rateLimitMessage, securityActionErrorMessage } from 'data/auth/authErrors';
import { retryAfterSecondsOf } from 'data/api/apiError';
import 'components/organisms/AuthFlow/AuthFlow.css';
import './SecurityStep.css';

type Status = API.User.getSecurityStatus.Response;
type TaskProps = { status: Status; onDone: () => Promise<void> };


const TASK_LABELS: Record<SecurityStepTask, string> = {
  'email': 'Confirm your email address',
  'new-password': 'Choose a new password',
  'sign-in-method': 'Set up how you sign in',
};

function tasksOf(status: Status): { task: SecurityStepTask; done: boolean }[] {
  const tasks: { task: SecurityStepTask; done: boolean }[] = [];
  if (status.needsVerifiedEmail || status.emailVerified) {
    tasks.push({ task: 'email', done: !status.needsVerifiedEmail });
  }
  if (status.needsNewPassword) {
    tasks.push({ task: 'new-password', done: false });
  }
  tasks.push({ task: 'sign-in-method', done: !status.needsSignInMethod });
  return tasks;
}

/**
 * The account-security step (docs/auth-identity §11): an account without a
 * sign-in method that works here, without a verified email address, or with
 * a password below the policy finishes it before anything else works. The
 * server enforces it; this screen walks through what is missing — the same
 * building blocks as the sign-up (AuthFlow) — and reloads the app when done.
 */
const SecurityStep: React.FC = () => {
  const [status, setStatus] = useState<Status | null>(null);
  const [loadError, setLoadError] = useState<string | undefined>();

  const refresh = useCallback(async () => {
    try {
      const next = await userApi.getSecurityStatus();
      setLoadError(undefined);
      if (!next.required) {
        // everything is in place: start the app properly (realtime
        // connection, push, data) on the page the user was going to
        securityStepState.set(false);
        window.location.reload();
        return;
      }
      securityStepState.set(true);
      setStatus(next);
    }
    catch {
      setLoadError("Your account status could not be loaded. Please try again.");
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const task = status ? nextSecurityStepTask(status) : null;

  let content: React.ReactNode = null;
  if (status && status.needsSignInMethod && status.recentSignIn === false) {
    // nothing to confirm "it's you" with, and the sign-in is too old
    content = <SignInAgain />;
  }
  else if (status && task === 'email') {
    content = <EmailTask status={status} onDone={refresh} />;
  }
  else if (status && task === 'new-password') {
    content = <NewPasswordTask status={status} onDone={refresh} />;
  }
  else if (status && task === 'sign-in-method') {
    content = <SignInMethodTask status={status} onDone={refresh} />;
  }

  return (
    <div className='auth-flow auth-flow-page security-step'>
      <div className='auth-flow-logo'>
        <CgLogoIcon />
      </div>
      <div className='auth-flow-step'>
        <StepHeader
          title='Secure your account'
          subtitle='Before you continue, your account needs a way to sign in on this site and a confirmed email address.'
        />
        {!!status && <ol className='security-step-tasks'>
          {tasksOf(status).map(({ task: item, done }) => (
            <li key={item} className={`cg-text-md-500 ${done ? 'done' : item === task ? 'active' : ''}`}>
              {done ? <CheckCircleIcon className='w-5 h-5' /> : <span className='security-step-dot' />}
              {TASK_LABELS[item]}
            </li>
          ))}
        </ol>}
        <StepError message={loadError} />
        {!!loadError && <Button className='w-full' role='secondary' text='Try again' onClick={refresh} />}
      </div>
      {content}
      <div className='auth-flow-step'>
        <Button className='w-full' role='textual' text='Sign out' onClick={() => loginManager.logout()} />
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Email: a code to the address; the address becomes the account's address
// once the code comes back

const EmailTask: React.FC<TaskProps> = ({ status, onDone }) => {
  const [email, setEmail] = useState(status.pendingEmail || status.email || '');
  const [sentTo, setSentTo] = useState<string | null>(status.pendingEmail || null);
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);
  // "send again" (the mail got lost) after a short wait
  const { left: cooldownLeft, start: startCooldown } = useCooldown();

  const send = useCallback(async () => {
    const address = email.trim();
    const problem = validateEmailInput(address);
    if (problem) {
      setError(problem);
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      await userApi.requestEmailVerification({ email: address });
      setSentTo(address);
      startCooldown();
    }
    catch (e) {
      if (isRateLimited(e) && sentTo) {
        startCooldown(retryAfterSecondsOf(e));
      }
      const message = isRateLimited(e) && sentTo
        ? rateLimitMessage(e, { what: "We can't send another code right now.", alternative: "Use the code from the last email (check your spam folder)." })
        : securityActionErrorMessage(e, "The code could not be sent. Please try again.");
      if (message) {
        setError(message);
      }
    }
    finally {
      setLoading(false);
    }
  }, [email, sentTo, startCooldown]);

  const resendLabel = cooldownLabel('Send the code again', cooldownLeft);
  return (
    <div className='auth-flow-step'>
      <StepHeader title={TASK_LABELS.email} subtitle='Important messages about your account go there, and you can sign in with a code sent to it.' />
      <form className='auth-flow-form' onSubmit={ev => { ev.preventDefault(); send(); }}>
        <TextInputField
          label='Email address'
          iconLeft={<EnvelopeIcon className='w-5 h-5' />}
          value={email}
          onChange={value => { setEmail(value); setError(undefined); }}
          placeholder='name@email.com'
          type='email'
          autoComplete='email'
          name='email'
        />
        <Button className='w-full' role={sentTo ? 'secondary' : 'primary'} text={sentTo ? resendLabel : 'Send code'} loading={loading} disabled={loading || (!!sentTo && cooldownLeft > 0)} />
      </form>
      <StepError message={error} />
      {!!sentTo && <EmailCodeConfirm email={sentTo} onConfirmed={onDone} />}
    </div>
  );
};

// ---------------------------------------------------------------------------
// The session's sign-in is too old and the account has nothing to confirm
// "it's you" with: sign in again, or get a new link from the old site

const SignInAgain: React.FC = () => (
  <div className='auth-flow-step'>
    <StepHeader
      title='Please sign in again'
      subtitle='For your security, setting up how you sign in needs a recent sign-in. Sign out, then sign in again — or, if you came here with a link from the old site, get a new link there.'
    />
    <Button className='w-full' role='primary' text='Sign out' onClick={() => loginManager.logout()} />
  </div>
);

// ---------------------------------------------------------------------------
// A password below the policy: replace it (the server asks to confirm the
// current one first — "Confirm it's you")

const NewPasswordTask: React.FC<TaskProps> = ({ status, onDone }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  const submit = useCallback(async () => {
    const problem = validatePassword(password, PASSWORD_MIN_LENGTH) || undefined;
    setError(problem);
    if (problem) {
      return;
    }
    setLoading(true);
    try {
      await userApi.setPassword({ password });
      await onDone();
    }
    catch (e) {
      const message = securityActionErrorMessage(e, "The password could not be changed. Please try again.");
      if (message) {
        setError(message);
      }
    }
    finally {
      setLoading(false);
    }
  }, [password, onDone]);

  return (
    <div className='auth-flow-step'>
      <StepHeader title={TASK_LABELS['new-password']} subtitle={`Your password is shorter than ${PASSWORD_MIN_LENGTH} characters. You'll confirm the current one first.`} />
      <form className='auth-flow-form' onSubmit={ev => { ev.preventDefault(); submit(); }}>
        {!!status.email && <input type='email' name='email' autoComplete='username' value={status.email} readOnly hidden />}
        <PasswordField
          label='New password'
          sublabel=''
          placeholder='New password'
          password={password}
          setPassword={value => { setPassword(value); setError(undefined); }}
          passwordError={error}
          autoComplete='new-password'
        />
        <PasswordHints />
        <Button className='w-full' role='primary' text='Change password' loading={loading} disabled={loading} />
      </form>
    </div>
  );
};

const PasswordHints: React.FC = () => (
  <ul className='auth-flow-hints cg-text-sm-400 cg-text-secondary'>
    <li>At least {PASSWORD_MIN_LENGTH} characters — longer is better.</li>
    <li>A few random words make a strong, memorable password.</li>
    <li>Don't reuse a password from another site. A password manager helps.</li>
  </ul>
);

// ---------------------------------------------------------------------------
// A sign-in method that works here: a passkey, a password or a wallet

const SignInMethodTask: React.FC<TaskProps> = ({ status, onDone }) => {
  const passkey = usePasskeyContext();
  const [method, setMethod] = useState<'choose' | 'password' | 'wallet'>('choose');
  const [error, setError] = useState<string | undefined>();
  const [confirmed, setConfirmed] = useState(false);

  const createPasskey = useCallback(async () => {
    setError(undefined);
    const outcome = await passkey.register();
    if (outcome.status === 'ok') {
      await onDone();
    }
    else if (outcome.status === 'reauthenticated') {
      // the ceremony needs a click of its own after the dialog
      setConfirmed(true);
    }
    else if (outcome.status === 'error' && outcome.code !== errors.server.REAUTH_REQUIRED) {
      setError(outcome.message);
    }
  }, [passkey, onDone]);

  if (method === 'password') {
    return <FirstPassword status={status} onDone={onDone} onBack={() => setMethod('choose')} />;
  }
  if (method === 'wallet') {
    return <SignInWallet onDone={onDone} onBack={() => setMethod('choose')} />;
  }
  return (
    <div className='auth-flow-step'>
      <StepHeader title={TASK_LABELS['sign-in-method']} subtitle='How will you sign in here from now on?' />
      {passkey.supported && <div className='auth-flow-method auth-flow-method-primary'>
        <Button
          className='w-full'
          role='primary'
          iconLeft={<PasskeyIcon className='w-5 h-5' weight='duotone' />}
          text={confirmed ? 'Create the passkey now' : 'Create a passkey'}
          onClick={createPasskey}
          loading={passkey.status === 'busy'}
          disabled={passkey.status === 'busy'}
        />
        <span className='cg-text-sm-400 cg-text-secondary'>Recommended. Sign in with your fingerprint, face or screen lock — nothing to remember, nothing to phish.</span>
      </div>}
      <Button
        className='w-full'
        role={passkey.supported ? 'secondary' : 'primary'}
        iconLeft={<PasswordIcon className='w-5 h-5' weight='duotone' />}
        text='Use a password'
        onClick={() => setMethod('password')}
      />
      <Button
        className='w-full'
        role='secondary'
        iconLeft={<WalletIcon className='w-5 h-5' weight='duotone' />}
        text='Use a wallet'
        onClick={() => setMethod('wallet')}
      />
      <StepError message={error} />
    </div>
  );
};

const FirstPassword: React.FC<TaskProps & { onBack: () => void }> = ({ status, onDone, onBack }) => {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  const submit = useCallback(async () => {
    const problem = validatePassword(password, PASSWORD_MIN_LENGTH) || undefined;
    setError(problem);
    if (problem) {
      return;
    }
    setLoading(true);
    try {
      await userApi.setPassword({ password });
      await onDone();
    }
    catch (e) {
      const message = securityActionErrorMessage(e, "The password could not be saved. Please try again.");
      if (message) {
        setError(message);
      }
    }
    finally {
      setLoading(false);
    }
  }, [password, onDone]);

  return (
    <div className='auth-flow-step'>
      <StepHeader title='Choose a password' onBack={onBack} />
      <form className='auth-flow-form' onSubmit={ev => { ev.preventDefault(); submit(); }}>
        {/* lets password managers store the password under the right account */}
        {!!status.email && <input type='email' name='email' autoComplete='username' value={status.email} readOnly hidden />}
        <PasswordField
          label='Password'
          sublabel=''
          placeholder='Password'
          password={password}
          setPassword={value => { setPassword(value); setError(undefined); }}
          passwordError={error}
          autoComplete='new-password'
        />
        <PasswordHints />
        <Button className='w-full' role='primary' text='Save password' loading={loading} disabled={loading} />
      </form>
    </div>
  );
};

const SignInWallet: React.FC<Pick<TaskProps, 'onDone'> & { onBack: () => void }> = ({ onDone, onBack }) => {
  const signed = useCallback(async (request: API.User.prepareWalletAction.Request) => {
    try {
      const prepared = await userApi.prepareWalletAction(request);
      if (prepared.readyForCreation) {
        // a wallet the account does not have yet
        await userApi.addPreparedWallet({ loginEnabled: true, visibility: 'private' });
      }
      else if (prepared.isOwnWallet && !prepared.readyForLogin) {
        // already linked to this account: switch its sign-in on
        const wallets = await userApi.getWallets({});
        const wallet = wallets.find(w => w.walletIdentifier.toLowerCase() === request.data.address.toLowerCase() && w.type === 'evm');
        if (!wallet) {
          throw new Error("This wallet can't be used to sign in.");
        }
        await userApi.updateWallet({ id: wallet.id, loginEnabled: true });
      }
      else if (!prepared.isOwnWallet) {
        throw new Error("This wallet belongs to another account.");
      }
    }
    catch (e) {
      const code = errorCode(e);
      if (code && Object.values(errors.server).includes(code as any)) {
        throw new Error(code === errors.server.RATE_LIMIT_EXCEEDED ? rateLimitMessage(e) : "This wallet could not be added. Please try again.");
      }
      throw e;
    }
    await onDone();
  }, [onDone]);

  return (
    <div className='auth-flow-step'>
      <StepHeader title='Sign in with a wallet' subtitle='Sign a message to prove the wallet is yours.' onBack={onBack} />
      <WalletSignature signText='Use this wallet to sign in' onSigned={signed} />
    </div>
  );
};

export default SecurityStep;
