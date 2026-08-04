// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { EnvelopeOpenIcon } from '@heroicons/react/20/solid';
import config from 'common/config';
import { validateEmailInput, validatePassword } from 'common/validators';
import Button from 'components/atoms/Button/Button';
import PasswordField from 'components/molecules/PasswordField/PasswordField';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import { useOwnUser } from 'context/OwnDataProvider'
import { useSnackbarContext } from 'context/SnackbarContext';
import data from 'data';
import userApi from 'data/api/user';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {useEmailConfirmationContext} from 'context/EmailConfirmationProvider';

type Props = {
  saveOnCloseMode?: boolean;
  goBack?: () => void;
}

const EmailPage: React.FC<Props> = ({ saveOnCloseMode, goBack }) => {
  const ownUser = useOwnUser();
  const { showSnackbar } = useSnackbarContext();
  const [email, setEmail] = React.useState(ownUser?.email || '');
  const [emailError, setEmailError] = React.useState<string | undefined>();
  const [emailValidateEnabled, setEmailValidateEnabled] = useState(false);
  const [loadingSubmit, setLoadingSubmit] = useState(false);

  const [password, setPassword] = React.useState('');
  const [passwordError, setPasswordError] = React.useState<string | undefined>();
  const emailContext = useEmailConfirmationContext();

  useEffect(() => {
    if (emailValidateEnabled) setEmailError(validateEmailInput(email));
  }, [email, emailValidateEnabled]);

  const setPasswordAndValidate = useCallback((password: string) => {
    setPassword(password);
    setPasswordError(validatePassword(password, 8));
  }, []);

  // Keep data up-to-date to save on-close
  const requestInfo = useRef<{
    userOwnEmail: string
    email: string;
    emailError: string | undefined;
    password: string;
    passwordError: string | undefined;
    emailVerified: boolean;
  }>(undefined);

  useEffect(() => {
    requestInfo.current = {
      userOwnEmail: ownUser?.email || '',
      email,
      emailError,
      password,
      passwordError,
      emailVerified: ownUser?.emailVerified || false
    }
  }, [email, emailError, ownUser?.email, ownUser?.emailVerified, ownUser?.newsletter, password, passwordError]);

  const onSubmit = useCallback(async () => {
    if (!requestInfo.current) return;

    const {
      email,
      emailError,
      password,
      passwordError,
      userOwnEmail,
      emailVerified
    } = requestInfo.current;

    if (passwordError || emailError) return;
    if (email === userOwnEmail && !password) return;

    try {
      if (email !== userOwnEmail) {
        await data.user.updateOwnData({ email });
        if (config.EMAIL_ENABLED) {
          await userApi.requestEmailVerification({ email });
          showSnackbar({ type: 'warning', text: `We've sent you an email with a verification link, please check your inbox` });
        }
      }
      if (password) await userApi.setPassword({ password });

      const updateText = 'E-mail' + (password ? ' and password' : '') + ' updated';
      showSnackbar({ type: 'info', text: updateText });
    } catch (e) {
      console.error(e);
      showSnackbar({ type: 'warning', text: 'Failed to update info' });
    }
  }, [emailContext, showSnackbar])

  useEffect(() => {
    // Save on close if saveOnCloseMode is enabled
    return () => {
      if (saveOnCloseMode) onSubmit();
    };
  }, [onSubmit, saveOnCloseMode]);

  return (<div className='flex flex-col gap-4 px-4'>
    <TextInputField
      label='Email address*'
      iconLeft={<EnvelopeOpenIcon className='w-5 h-5' />}
      placeholder='name@email.com'
      value={email}
      onChange={setEmail}
      error={emailError}
      type='email'
      autoComplete='email'
      name='email'
      onBlur={() => setEmailValidateEnabled(true)}
    />
    <PasswordField
      password={password}
      setPassword={setPasswordAndValidate}
      passwordError={passwordError}
      label='Password (optional)'
    />
    <div className='cg-text-md-500 cg-text-main'>
      Hint: Setting a password is optional, you can also log in using one-time codes sent to your email.
    </div>
    {!saveOnCloseMode && <Button
      role='primary'
      text='Add Email Account'
      disabled={!!emailError || !!passwordError || !email || !password}
      onClick={async () => {
        setLoadingSubmit(true);
        await onSubmit();
        goBack?.();
      }}
      loading={loadingSubmit}
    />}
  </div>);
}

export default React.memo(EmailPage);