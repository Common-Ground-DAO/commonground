// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useState } from 'react';
import config from 'common/config';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import { EnvelopeOpenIcon } from '@heroicons/react/20/solid';
import PasswordField from 'components/molecules/PasswordField/PasswordField';
import { validateEmailInput, validatePassword } from 'common/validators';
import Button from 'components/atoms/Button/Button';
import userApi from 'data/api/user';
import { OnboardingStep } from 'context/UserOnboarding';
import { useSnackbarContext } from 'context/SnackbarContext';

export type OnboardingEmailState = {
  type: 'password' | 'code';
  email: string;
  password: string;
  error: string;
  valid: boolean;
  loading: boolean;
}

type Props = {
  step: OnboardingStep;
  onSubmit: (data: { type: 'password' | 'code', email: string; password: string; }) => Promise<void>;
  state: OnboardingEmailState;
  setState: React.Dispatch<React.SetStateAction<OnboardingEmailState>>;
};

type ButtonProps = Props & {
  text?: string;
};

let emailSentTimestamp = 0;

export const OnboardingEmailStatus: React.FC<Props> = ({ step, onSubmit, state, setState }) => {
  const { type, email, password } = state;

  const [emailError, setEmailError] = useState<string | undefined>();
  const [emailValidateEnabled, setEmailValidateEnabled] = useState(false);
  const [passwordError, setPasswordError] = useState<string | undefined>();
  const [passwordValidateEnabled, setPasswordValidateEnabled] = useState(false);
  const { showSnackbar } = useSnackbarContext();

  useEffect(() => {
    const emailError = validateEmailInput(email);
    if (emailValidateEnabled) setEmailError(emailError);
    const passwordError = validatePassword(password, 8);
    if (passwordValidateEnabled) setPasswordError(passwordError);
    if (!emailError && !passwordError) {
      if (!state.valid) setState(oldState => ({ ...oldState, valid: true, error: '' }));
    }
    else if (state.valid) {
      setState(oldState => ({ ...oldState, valid: false, error: '' }));
    }
  }, [email, password, state.valid, emailValidateEnabled, passwordValidateEnabled]);

  const onClickSubmit = useCallback(async () => {
    try {
      setState(oldState => ({ ...oldState, loading: true, error: '' }));
      let emailAvailable = true;
      if (step === 'create-other-option') {
        emailAvailable = await userApi.isEmailAvailable({ email });
      }
      if (!emailAvailable) {
        setEmailError('Email is already in use');
      }
      else {
        await onSubmit({ type, email, password });
      }
      setState(oldState => ({ ...oldState, loading: false, error: '' }));
    } catch (e) {
      let message = (e as unknown as any).message || (e as unknown as any).toString();
      setState(oldState => ({ ...oldState, loading: false, error: message?.replace('Error:', '') }));
    }
  }, [step, email, onSubmit, password]);

  useEffect(() => {
    if (step.startsWith('create') && type === 'code') {
      setState(oldState => ({ ...oldState, type: 'password' }));
    }
  }, [step, type]);

  return (<div className='flex flex-col py-8 px-4 items-center justify-between min-h-full gap-8'>
    <div className='flex flex-col flex-1 items-center justify-center w-full'>
      <div className='cg-heading-2 mt-2 mb-8 text-center'>Email</div>
      <div className='flex flex-col items-center justify-center gap-4 max-w-xs w-full'>
        <TextInputField
          label='Email address*'
          iconLeft={<EnvelopeOpenIcon className='w-5 h-5' />}
          placeholder='name@email.com'
          value={email}
          onChange={value => setState(oldState => ({ ...oldState, email: value }))}
          error={emailError}
          type='email'
          autoComplete='email'
          name='email'
          onBlur={() => setEmailValidateEnabled(true)}
        />
        <PasswordField
          password={password}
          label={type === 'password' ? 'Password*' : 'One-time code*'}
          setPassword={value => setState(oldState => ({ ...oldState, password: value }))}
          passwordError={passwordError}
          onBlur={() => setPasswordValidateEnabled(true)}
          onEnterPressed={onClickSubmit}
          sublabel={type === 'password' ? 'Requires 8+ characters' : '10-digit code sent to your email'}
        />
        {step.startsWith('login') && config.EMAIL_ENABLED && <div className='w-full cg-text-md-500 cg-text-main'>
          Hint: {type === 'password' ? 'You can also use a one-time code which will be sent to your email.' : 'You can also use your password to log in.'}
        </div>}
        {type === 'code' && <Button
          loading={state.loading}
          className='w-full cg-text-lg-500'
          role="primary"
          text="Send code"
          onClick={() => {
            if (!email) {
              showSnackbar({ text: `Please enter an email address`, type: 'warning' });
            }
            else if (emailSentTimestamp + 30_000 > Date.now()) {
              showSnackbar({ text: `Please wait ${Math.floor((emailSentTimestamp + 30_000 - Date.now()) / 1000)} seconds before requesting another code`, type: 'warning' });
            }
            else {
              setState(oldState => ({ ...oldState, loading: true }));
              userApi.sendOneTimePasswordForLogin({ email })
                .then(() => {
                  emailSentTimestamp = Date.now();
                  showSnackbar({ text: `We've sent you a one-time code to ${email}`, type: 'info' });
                })
                .catch(e => {
                  showSnackbar({ text: `Failed to send code: Invalid email`, type: 'warning' });
                })
                .finally(() => {
                  setState(oldState => ({ ...oldState, loading: false }));
                });
            }
          }}
        />}
        {step.startsWith('login') && config.EMAIL_ENABLED && <Button
          loading={state.loading}
          className='w-full cg-text-lg-500'
          role="primary"
          text={type === 'password' ? 'Switch to one-time code' : 'Switch to password'}
          onClick={() => {
            setState(oldState => ({ ...oldState, type: oldState.type === 'password' ? 'code' : 'password' }));
          }}
        />}
      </div>
      {!!state.error && <span className='cg-text-lg-500 text-center cg-text-error'>{state.error}</span>}
    </div>
  </div>);
}

export const OnboardingEmailButton: React.FC<ButtonProps> = ({ step, onSubmit, state, setState, text }) => {
  const { type, email, password } = state;

  const onClickSubmit = useCallback(async () => {
    try {
      setState(oldState => ({ ...oldState, loading: true }));
      let emailAvailable = true;
      if (step === 'create-other-option') {
        emailAvailable = await userApi.isEmailAvailable({ email });
      }
      if (!emailAvailable) {
        setState(oldState => ({ ...oldState, error: 'Email is already in use' }));
      }
      else {
        await onSubmit({ type, email, password });
      }
    } catch (e) {
      let message = (e as unknown as any).message || (e as unknown as any).toString();
      setState(oldState => ({ ...oldState, error: message?.replace('Error:', '') }))
    }
    setState(oldState => ({ ...oldState, loading: false }));
  }, [step, email, onSubmit, password]);

  return (
    <Button
      loading={state.loading}
      className='w-full cg-text-lg-500'
      role="primary"
      text={text === undefined ? "Login" : text}
      disabled={!state.valid}
      onClick={onClickSubmit}
    />
  );
}