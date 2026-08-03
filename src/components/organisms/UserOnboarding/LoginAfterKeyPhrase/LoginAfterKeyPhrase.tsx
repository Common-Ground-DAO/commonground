// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useState } from 'react';
import './LoginAfterKeyPhrase.css';

import userApi from 'data/api/user';
import { validateEmailInput, validatePassword } from 'common/validators';
import CircleLogo from "components/atoms/icons/misc/Logo/logo.svg?react";

import Button from "components/atoms/Button/Button";
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';

import { EnvelopeOpenIcon } from "@heroicons/react/20/solid";
import ConnectWalletButton from '../ConnectWalletButton/ConnectWalletButton';
import data from 'data';
import PasswordField from 'components/molecules/PasswordField/PasswordField';

type Properties = {
  user: Models.User.OwnData;
  handleOnboardingClose: () => void;
}

export default function LoginAfterKeyPhrase(props: Properties) {
  const { user, handleOnboardingClose } = props;

  const [email, setEmail] = React.useState(user.email || '');
  const [emailError, setEmailError] = React.useState<string | undefined>();
  const [emailValidateEnabled, setEmailValidateEnabled] = useState(false);

  const [password, setPassword] = React.useState('');
  const [passwordError, setPasswordError] = React.useState<string | undefined>();

  const [genericError, setGenericError] = useState('');

  const [walletData, setWalletData] = React.useState<API.User.prepareWalletAction.Request | undefined>();

  useEffect(() => {
    if (emailValidateEnabled) setEmailError(validateEmailInput(email));
    setGenericError('');
  }, [email, emailValidateEnabled]);

  const setPasswordAndValidate = useCallback((password: string) => {
    setPassword(password);
    setPasswordError(validatePassword(password, 8));
  }, []);

  const hasErrors = (!!email && !!emailError) || (!!password && !!passwordError) || !((!!password && !!email) || !!walletData);

  const onSave = useCallback(async () => {
    try {
      if (user.email !== email) {
        await data.user.updateOwnData({
          email
        });
      }

      if (password) {
        await userApi.setPassword({ password });
      }

      if (walletData) {
        const { signature, data } = walletData;
        await userApi.composed_addWallet({
          type: 'evm',
          data,
          signature,
        }, {
          loginEnabled: true,
          visibility: 'private'
        });
      }

      handleOnboardingClose();
    } catch (e) {
      setGenericError('Something went wrong, please try again later');
    }
  }, [email, handleOnboardingClose, password, user.email, walletData]);

  return (
    <div className="create-account">
      <div className='flex flex-col gap-8'>
        <div className='flex flex-col items-center'>
          <CircleLogo className='logo'/>
          <div className='flex flex-col items-center justify-center gap-2'>
            <span className='cg-heading-1 text-center'>Please add a login method</span>
            <span className='cg-text-lg-400 text-center'>We will be phasing out the keyphrase in future!</span>
          </div>
        </div>
        <div className='flex flex-col gap-4'>
          <TextInputField
            label='Email address*'
            iconLeft={<EnvelopeOpenIcon className='w-5 h-5'/>}
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
            autoComplete='new-password'
          />
        </div>
        <div className='flex items-center gap-2'>
          <div className='cg-separator' />
          <span className='cg-text-secondary cg-text-lg-500'>or</span>
          <div className='cg-separator' />
        </div>
        <ConnectWalletButton
          walletData={walletData}
          setWalletData={setWalletData}
        />
      </div>

      <div className='flex flex-col items-center gap-4 mt-auto'>
        {genericError && <span className='cg-text-error'>{genericError}</span>}
        <Button className='w-full cg-text-lg-500' role="primary" text="Save" disabled={hasErrors} onClick={onSave} />
      </div>
    </div>
  );
}