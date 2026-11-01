// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useState } from 'react';
import Button from 'components/atoms/Button/Button';
import userApi from 'data/api/user';
import { isRateLimited, rateLimitMessage, securityActionErrorMessage } from 'data/auth/authErrors';
import { retryAfterSecondsOf } from 'data/api/apiError';
import { cooldownLabel, useCooldown } from 'hooks/useCooldown';
import EmailCodeConfirm from './EmailCodeConfirm';

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
  const { left, start } = useCooldown(undefined, `verify:${email.toLowerCase()}`);
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
      if (isRateLimited(e)) {
        start(retryAfterSecondsOf(e));
      }
      setError((isRateLimited(e) && sent
        ? rateLimitMessage(e, { what: "We can't send another confirmation right now.", alternative: "Use the code from the last email (check your spam folder)." })
        : securityActionErrorMessage(e, "The confirmation could not be sent. Please try again later.")) ?? undefined);
    }
    finally {
      setLoading(false);
    }
  }, [email, sent, start]);

  return (
    <div className='flex flex-col gap-2 w-full'>
      <span className='cg-text-md-400 cg-text-secondary'>
        Your address <b>{email}</b> is not confirmed yet{sent ? '.' : '. If the confirmation mail got lost, ask for a new one.'}
      </span>
      <Button
        className='w-full'
        role='secondary'
        text={cooldownLabel('Send confirmation again', left)}
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
