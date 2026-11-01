// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { EnvelopeOpenIcon } from '@heroicons/react/20/solid';
import config from 'common/config';
import { validateEmailInput, validatePassword } from 'common/validators';
import { PASSWORD_MIN_LENGTH } from 'common/passwordPolicy';
import Button from 'components/atoms/Button/Button';
import PasswordField from 'components/molecules/PasswordField/PasswordField';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import { useOwnUser } from 'context/OwnDataProvider'
import { useSnackbarContext } from 'context/SnackbarContext';
import data from 'data';
import userApi from 'data/api/user';
import React, { useCallback, useEffect, useRef, useState } from 'react';
import {useEmailConfirmationContext} from 'context/EmailConfirmationProvider';
import { securityActionErrorMessage } from 'data/auth/authErrors';
import { signedOutDevicesText } from 'data/auth/signedOut';
import EmailCodeConfirm from 'components/molecules/EmailCodeConfirm/EmailCodeConfirm';
import ConfirmEmailAgain from 'components/molecules/EmailCodeConfirm/ConfirmEmailAgain';

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

  // a confirmation code was sent to this new address
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [password, setPassword] = React.useState('');
  const [passwordError, setPasswordError] = React.useState<string | undefined>();
  const emailContext = useEmailConfirmationContext();

  useEffect(() => {
    if (emailValidateEnabled) setEmailError(validateEmailInput(email));
  }, [email, emailValidateEnabled]);

  const setPasswordAndValidate = useCallback((password: string) => {
    setPassword(password);
    setPasswordError(validatePassword(password, PASSWORD_MIN_LENGTH));
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

  /** 'pending': a new address waits for its confirmation code */
  const onSubmit = useCallback(async (): Promise<'pending' | 'done' | undefined> => {
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
      let pending = false;
      if (email !== userOwnEmail) {
        if (config.EMAIL_ENABLED) {
          // the address changes once the code sent to it comes back
          await userApi.requestEmailVerification({ email });
          setPendingEmail(email);
          pending = true;
          showSnackbar({ type: 'warning', text: `We've sent a confirmation code and link to ${email}. Your address changes once you confirm it.` });
        }
        else {
          await data.user.updateOwnData({ email });
        }
      }
      // a replaced password signs the other devices out
      const changed = password ? await userApi.setPassword({ password }) : null;
      const signedOut = changed ? signedOutDevicesText(changed.signedOutDevices, changed.signOutDelayed) : null;

      if (!pending || password) {
        const updateText = pending ? 'Password updated' : 'E-mail' + (password ? ' and password' : '') + ' updated';
        showSnackbar({ type: 'info', text: signedOut ? `${updateText}. ${signedOut}` : updateText });
      }
      return pending ? 'pending' : 'done';
    } catch (e) {
      console.error(e);
      // email and password changes ask "Confirm it's you" first; nothing to
      // show when that was cancelled
      const message = securityActionErrorMessage(e, 'Failed to update info');
      if (message) {
        showSnackbar({ type: 'warning', text: message });
      }
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
    {config.EMAIL_ENABLED && !!ownUser?.email && !ownUser.emailVerified && !pendingEmail && <ConfirmEmailAgain
      email={ownUser.email}
      onConfirmed={() => showSnackbar({ type: 'info', text: 'E-mail confirmed' })}
    />}
    <div className='cg-text-md-500 cg-text-main'>
      Hint: Setting a password is optional, you can also log in using one-time codes sent to your email.
    </div>
    {!saveOnCloseMode && <Button
      role='primary'
      text='Add Email Account'
      disabled={!!emailError || !!passwordError || !email || !password}
      onClick={async () => {
        setLoadingSubmit(true);
        const result = await onSubmit();
        setLoadingSubmit(false);
        if (result !== 'pending') {
          goBack?.();
        }
      }}
      loading={loadingSubmit}
    />}
    {!!pendingEmail && <EmailCodeConfirm
      email={pendingEmail}
      subLabel={`We sent an 8-digit code to ${pendingEmail}. You can also open the link in that mail.`}
      onConfirmed={() => {
        setPendingEmail(null);
        showSnackbar({ type: 'info', text: 'E-mail updated' });
        goBack?.();
      }}
    />}
  </div>);
}

export default React.memo(EmailPage);