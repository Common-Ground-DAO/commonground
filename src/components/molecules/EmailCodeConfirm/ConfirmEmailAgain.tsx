// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useState } from 'react';
import Button from 'components/atoms/Button/Button';
import userApi from 'data/api/user';
import { securityActionErrorMessage } from 'data/auth/authErrors';
import EmailCodeConfirm from './EmailCodeConfirm';

/** seconds before the next confirmation mail may be asked for */
export const RESEND_COOLDOWN_SECONDS = 60;

/** A countdown in seconds; `start()` restarts it. */
export function useCooldown(seconds = RESEND_COOLDOWN_SECONDS) {
  const [left, setLeft] = useState(0);
  useEffect(() => {
    if (left <= 0) {
      return;
    }
    const timer = setTimeout(() => setLeft(value => value - 1), 1000);
    return () => clearTimeout(timer);
  }, [left]);
  const start = useCallback(() => setLeft(seconds), [seconds]);
  return { left, start };
}

type Props = {
  /** the account's current, unconfirmed address */
  email: string;
  onConfirmed: () => void | Promise<void>;
};

/**
 * For a signed-in account whose address was never confirmed (the mail got
 * lost): "Send confirmation again" (the send limits apply; a cooldown in
 * between), then the code field. Only ever for the session's own account
 * (docs/auth-identity §8).
 */
const ConfirmEmailAgain: React.FC<Props> = ({ email, onConfirmed }) => {
  const { left, start } = useCooldown();
  const [sent, setSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const send = useCallback(async () => {
    setLoading(true);
    setError(undefined);
    try {
      await userApi.requestEmailVerification({ email });
      setSent(true);
      start();
    }
    catch (e) {
      setError(securityActionErrorMessage(e, "The confirmation could not be sent. Please try again later.") ?? undefined);
    }
    finally {
      setLoading(false);
    }
  }, [email, start]);

  return (
    <div className='flex flex-col gap-2 w-full'>
      <span className='cg-text-md-400 cg-text-secondary'>
        Your address <b>{email}</b> is not confirmed yet{sent ? '.' : '. If the confirmation mail got lost, ask for a new one.'}
      </span>
      <Button
        className='w-full'
        role='secondary'
        text={left > 0 ? `Send confirmation again (${left} s)` : 'Send confirmation again'}
        onClick={send}
        loading={loading}
        disabled={loading || left > 0}
      />
      {!!error && <span className='cg-text-md-400 cg-text-error' role='alert'>{error}</span>}
      {sent && <EmailCodeConfirm email={email} onConfirmed={onConfirmed} />}
    </div>
  );
};

export default ConfirmEmailAgain;
