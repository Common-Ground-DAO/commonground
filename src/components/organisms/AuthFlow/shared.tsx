// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react';
import { ArrowLeftIcon } from '@heroicons/react/20/solid';
import type { AuthFlowConfig, AuthFlowEvent, AuthFlowState } from './authFlowMachine';

export type LoginMethodName =
  | 'password'
  | 'passkey'
  | 'code'
  | 'wallet'
  | 'lukso'
  | 'farcaster'
  | 'twitter'
  | 'recovery-phrase';

export type StepProps = {
  state: AuthFlowState;
  dispatch: React.Dispatch<AuthFlowEvent>;
  config: AuthFlowConfig;
};

/** may take a moment (passkey offer after a password login); callers keep their spinner until it resolves */
export type LoggedInHandler = (method: LoginMethodName, response: API.User.login.Response) => void | Promise<void>;

export function errorCode(e: unknown): string | undefined {
  if (e instanceof Error) {
    return e.message;
  }
  return typeof e === 'string' ? e : undefined;
}

export const StepHeader: React.FC<{ title: string; subtitle?: React.ReactNode; onBack?: () => void }> = ({ title, subtitle, onBack }) => (
  <div className='auth-flow-header'>
    {!!onBack && <button type='button' className='auth-flow-back' onClick={onBack} aria-label='Back'>
      <ArrowLeftIcon className='w-5 h-5' />
    </button>}
    <span className='cg-heading-2 cg-text-main'>{title}</span>
    {!!subtitle && <span className='cg-text-md-400 cg-text-secondary'>{subtitle}</span>}
  </div>
);

export const StepError: React.FC<{ message?: string }> = ({ message }) => (
  message ? <div className='cg-text-md-400 cg-text-error' role='alert'>{message}</div> : null
);

export const Divider: React.FC<{ text?: string }> = ({ text = 'or' }) => (
  <div className='auth-flow-divider cg-text-sm-400 cg-text-secondary'>
    <div className='cg-separator' />
    <span>{text}</span>
    <div className='cg-separator' />
  </div>
);
