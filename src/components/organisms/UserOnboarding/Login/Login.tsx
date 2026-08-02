// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useState } from 'react';
import './Login.css';
import loginManager from '../../../../data/appstate/login';
import { validateEmailInput, validatePassword } from 'common/validators';

import Button from "components/atoms/Button/Button";
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';

import { ReactComponent as CircleLogo } from "components/atoms/icons/misc/Logo/logo.svg";
import ConnectWalletButton from '../ConnectWalletButton/ConnectWalletButton';

import './Login.css';
import PasswordField from 'components/molecules/PasswordField/PasswordField';
import { EnvelopeOpenIcon } from '@heroicons/react/20/solid';
import { OnboardingStep } from 'context/UserOnboarding';
import userApi from 'data/api/user';

type Properties = {
  handleChangeState: (state: OnboardingStep) => void;
  onClose: () => void;
}

export default function Login(props: Properties) {
  const { handleChangeState, onClose } = props;

  const [genericError, setGenericError] = React.useState('');

  const [email, setEmail] = React.useState('');
  const [emailError, setEmailError] = React.useState<string | undefined>();
  const [emailValidateEnabled, setEmailValidateEnabled] = useState(false);

  const [password, setPassword] = React.useState('');
  const [passwordError, setPasswordError] = React.useState<string | undefined>();

  const [walletData, setWalletData] = React.useState<API.User.prepareWalletAction.Request | undefined>();

  useEffect(() => {
    if (emailValidateEnabled) setEmailError(validateEmailInput(email));
    setGenericError('');
  }, [email, emailValidateEnabled]);

  const setPasswordAndValidate = useCallback((password: string) => {
    setPassword(password);
    setPasswordError(validatePassword(password, 8));
    setGenericError('');
  }, []);

  const onLogin = React.useCallback(async () => {
    let result: API.User.createUser.Response | null = null;
    if (password) {
      try {
        result = await loginManager.login({ aliasOrEmail: email, password });
      } catch (e) {
        setGenericError('E-mail and/or password are incorrect.');
      }
    } else {
      if (!!walletData) {
        try {
          const prepareResult = await userApi.prepareWalletAction(walletData);
          if (prepareResult.readyForLogin) {
            result = await loginManager.login({ account: 'wallet' });
          }
          else {
            throw new Error("This wallet is not ready for login");
          }
        } catch (e) {
          setGenericError('This wallet is currently not assigned to login for any user.');
        }
      }
    }

    if (result) {
      onClose();
    }
  }, [password, email, walletData, onClose]);

  const hasErrors = (!!email && !!emailError) || (!!password && !!passwordError) || !((!!password && !!email) || !!walletData);

  return (
    <div className="create-account">
      <div className='flex flex-col gap-8'>
        <div className='flex flex-col items-center'>
          <CircleLogo className='logo' />
          <span className='cg-heading-1 text-center'>Welcome back!</span>
        </div>
        <div className='flex flex-col gap-4'>
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
          />
        </div>
        <div className='flex items-center gap-2'>
          <div className='cg-separator' />
          <span className='cg-text-secondary cg-text-lg-500'>or</span>
          <div className='cg-separator' />
        </div>
        <div className='flex flex-col gap-2'>
          <ConnectWalletButton
            walletData={walletData}
            setWalletData={setWalletData}
          />
        </div>
      </div>

      <div className='flex flex-col items-center gap-4 mt-auto'>
        <div className="cg-text-secondary cg-text-lg-500">
          <span>Do you have a 12-word keyphrase? </span>
          <span className='underline cursor-pointer' onClick={() => {/*handleChangeState('keyphrase') */}}>Login here</span>
        </div>
        <div className="cg-text-secondary cg-text-lg-500">
          <span>New here? </span>
          <span className='underline cursor-pointer' onClick={() => {/*handleChangeState('create') */}}>Sign up</span>
        </div>
        <div className='flex flex-col gap-2 w-full'>
          {genericError && <span className='cg-text-lg-500 text-center cg-text-error'>{genericError}</span>}
          <Button className='w-full cg-text-lg-500' role="primary" text="Login" disabled={hasErrors} onClick={onLogin} />
        </div>
      </div>
    </div>
  );
}