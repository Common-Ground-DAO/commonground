// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useState } from 'react';
import "./CreateAccount.css";

import { validatePassword, validateEmailInput } from 'common/validators';

import Button from "components/atoms/Button/Button";
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';

import { ReactComponent as CircleLogo } from "components/atoms/icons/misc/Logo/logo.svg";
import { EnvelopeOpenIcon } from '@heroicons/react/20/solid';
import Checkbox from 'components/atoms/Checkbox/Checkbox';
import ConnectWalletButton from '../ConnectWalletButton/ConnectWalletButton';

import "./CreateAccount.css";
import PasswordField from 'components/molecules/PasswordField/PasswordField';
import { OnboardingStep } from 'context/UserOnboarding';

type Props = {
  handleChangeState: (state: OnboardingStep) => void;
  email: string;
  setEmail: (email: string) => void;
  password: string;
  setPassword: (password: string) => void;
  subscribeNewsletter: boolean;
  setSubscribeNewsletter: (value: boolean) => void;
  walletData: API.User.prepareWalletAction.Request | undefined;
  setWalletData: React.Dispatch<React.SetStateAction<API.User.prepareWalletAction.Request | undefined>>;
};

export default function CreateAccount(props: Props) {
  const { handleChangeState, password, setPassword, email, setEmail, subscribeNewsletter, setSubscribeNewsletter, walletData, setWalletData } = props;
  const [emailValidateEnabled, setEmailValidateEnabled] = useState(false);
  const [emailError, setEmailError] = React.useState<string | undefined>();
  const [passwordError, setPasswordError] = React.useState<string | undefined>();

  useEffect(() => {
    if (emailValidateEnabled) setEmailError(validateEmailInput(email));
  }, [email, emailValidateEnabled]);

  const setPasswordAndValidate = useCallback((password: string) => {
    setPassword(password);
    setPasswordError(validatePassword(password, 8));
  }, [setPassword]);

  const hasErrors = (!!email && !!emailError) || (!!password && !!passwordError) || !((!!password && !!email) || !!walletData);

  return (
    <div className="create-account">
      <div className='flex flex-col gap-8'>
        <div className='flex flex-col items-center'>
          <CircleLogo className='logo' />
          <span className='cg-heading-1 text-center'>Finally,<br />Common Ground</span>
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
          <div className='flex items-center gap-2 cg-text-lg-500 cursor-pointer' onClick={() => setSubscribeNewsletter(!subscribeNewsletter)}>
            <Checkbox checked={subscribeNewsletter} /> <span>Get news and updates from your communities in your inbox</span>
          </div>
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
          <span>Already have an account? </span>
          <span className='underline cursor-pointer' onClick={() => {/*handleChangeState('login') */}}>Login</span>
        </div>
        <Button className='w-full cg-text-lg-500' role="primary" text="Next" disabled={hasErrors} onClick={() => handleChangeState('create-profile-setup')} />
      </div>
    </div>
  );
}