// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './EmailEditor.css';
import PaddedIcon from 'components/atoms/PaddedIcon/PaddedIcon';
import React, { useCallback, useState } from 'react'
import { EnvelopeIcon, EnvelopeOpenIcon } from '@heroicons/react/20/solid';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import { useOwnUser } from 'context/OwnDataProvider';
import { validateEmailInput, validatePassword } from 'common/validators';
import config from 'common/config';
import EmailCodeConfirm from 'components/molecules/EmailCodeConfirm/EmailCodeConfirm';
import { PASSWORD_MIN_LENGTH } from 'common/passwordPolicy';
import Button from 'components/atoms/Button/Button';
import Checkbox from 'components/atoms/Checkbox/Checkbox';
import data from 'data';
import userApi from 'data/api/user';
import { securityActionErrorMessage } from 'data/auth/authErrors';
import { useSnackbarContext } from 'context/SnackbarContext';
import PasswordField from 'components/molecules/PasswordField/PasswordField';
import { useEmailConfirmationContext } from 'context/EmailConfirmationProvider';

type Props = {};

const EmailEditor: React.FC<Props> = () => {
  const ownUser = useOwnUser();
  const { showSnackbar } = useSnackbarContext();
  const [email, setEmail] = useState(ownUser?.email || '');
  const [emailError, setEmailError] = React.useState<string | undefined>();
  const emailContext = useEmailConfirmationContext();

  // a confirmation code was sent to this new address
  const [pendingEmail, setPendingEmail] = useState<string | null>(null);
  const [password, setPassword] = React.useState('');
  const [passwordError, setPasswordError] = React.useState<string | undefined>();

  const [newsletterActive, setNewsletterActive] = useState(ownUser?.newsletter || false);

  const setEmailAndValidate = useCallback((email: string) => {
    setEmail(email);
    setEmailError(validateEmailInput(email));
  }, []);

  const setPasswordAndValidate = useCallback((password: string) => {
    setPassword(password);
    setPasswordError(validatePassword(password, PASSWORD_MIN_LENGTH));
  }, []);

  const onSubmit = useCallback(async () => {
    if (passwordError || emailError) return;
    showSnackbar({ type: 'info', text: 'Saving...' });

    try {
      if (newsletterActive) await userApi.subscribeNewsletter({ email });
      else await userApi.unsubscribeNewsletter({ email });

      // unsubscribe old emails
      if (ownUser?.email && email !== ownUser.email) {
        await userApi.unsubscribeNewsletter({ email: ownUser.email });
      }

      // only update emails if they are different
      if (email !== ownUser?.email) {
        if (config.EMAIL_ENABLED) {
          // the address changes once the code sent to it comes back
          await userApi.requestEmailVerification({ email });
          setPendingEmail(email);
          showSnackbar({ type: 'info', text: `We've sent a confirmation code and link to ${email}. Your address changes once you confirm it.` });
        }
        else {
          await data.user.updateOwnData({ email });
        }
      }
      if (password.length > 0) {
        await userApi.setPassword({ password });
        showSnackbar({ type: 'info', text: 'Password updated' });
      }
      
    } catch (e) {
      console.error(e);
      // email and password changes ask "Confirm it's you"; nothing to show
      // when that was cancelled
      const message = securityActionErrorMessage(e, 'Failed to update info');
      if (message) {
        showSnackbar({ type: 'warning', text: message });
      }
    }

  }, [email, emailContext, emailError, newsletterActive, ownUser?.email, password, passwordError, showSnackbar]);

  const codeField = pendingEmail ? <EmailCodeConfirm
    email={pendingEmail}
    subLabel={`We sent an 8-digit code to ${pendingEmail}. You can also open the link in that mail.`}
    onConfirmed={() => {
      setPendingEmail(null);
      showSnackbar({ type: 'info', text: 'E-mail updated' });
    }}
  /> : null;

  return (<div className='email-editor-container'>
    <div className='flex items-center gap-2 cg-text-main'>
      <PaddedIcon className='cg-text-main' icon={<EnvelopeIcon className='w-5 h-5' />} />
      <span className='cg-text-lg-500'>Email Account</span>
    </div>
    <div className='email-editor-container'>
      <TextInputField
        label='Email address*'
        iconLeft={<EnvelopeOpenIcon className='w-5 h-5' />}
        placeholder='name@email.com'
        value={email}
        onChange={setEmailAndValidate}
        error={emailError}
        type='email'
        autoComplete='email'
        name='email'
      />
      <PasswordField
        password={password}
        setPassword={setPasswordAndValidate}
        passwordError={passwordError}
        autoComplete='new-password'
      />
      <div className='flex items-center justify-between gap-2 px-3 flex-wrap'>
        <div className='cursor-pointer flex items-center gap-2' onClick={() => setNewsletterActive(old => !old)}>
          <Checkbox checked={newsletterActive} />
          <span className='cg-text-main cg-text-lg-500'>Get news and updates from your communities in your inbox</span>
        </div>
        <Button
          disabled={password.length === 0 || email.length === 0 || !!emailError || !!passwordError}
          text='Save'
          role='primary'
          onClick={onSubmit}
        />
      </div>
      {codeField}
    </div>
  </div>);
}

export default React.memo(EmailEditor);