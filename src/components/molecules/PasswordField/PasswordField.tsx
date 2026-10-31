// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback } from 'react'
import './PasswordField.css';
import { KeyIcon } from '@heroicons/react/20/solid';
import TextInputField from '../inputs/TextInputField/TextInputField';
import { EyeIcon, EyeSlashIcon } from '@heroicons/react/24/outline';

type Props = {
  label?: string;
  sublabel?: string;
  placeholder?: string;
  password: string;
  passwordError?: string;
  setPassword: (password: string) => void;
  autoComplete?: string;
  onBlur?: (e: React.FocusEvent<Element>) => void;
  onEnterPressed?: () => void;
  maxLetters?: number;
  autoFocus?: boolean;
}

const PasswordField: React.FC<Props> = (props) => {
  const { label, sublabel, placeholder, password, passwordError, autoComplete, setPassword, onBlur, onEnterPressed, maxLetters, autoFocus } = props;
  const [isPasswordVisible, setIsPasswordVisible] = React.useState<boolean>(false);

  const onKeyPress = useCallback((ev: React.KeyboardEvent) => {
    if (ev.key === 'Enter') {
      onEnterPressed?.();
    }
  }, [onEnterPressed]);

  return <TextInputField
    type={isPasswordVisible ? "text" : "password"}
    label={label || 'Password*'}
    subLabel={sublabel ?? 'Requires 8+ characters'}
    iconLeft={<KeyIcon className='w-5 h-5' />}
    placeholder={placeholder ?? '********'}
    value={password}
    onChange={setPassword}
    error={passwordError}
    inputClassName={`password-field${isPasswordVisible ? '' : ' text-hidden'}`}
    iconRight={<div className="password-field-visibility" onClick={() => setIsPasswordVisible(!isPasswordVisible)}>{!isPasswordVisible ? <EyeSlashIcon className='w-6 h-6' /> : <EyeIcon className='w-6 h-6' />}</div>}
    autoComplete={autoComplete || 'current-password'}
    name='password'
    onBlur={onBlur}
    onKeyPress={onKeyPress}
    maxLetters={maxLetters}
    autoFocus={autoFocus}
  />
}

export default React.memo(PasswordField);