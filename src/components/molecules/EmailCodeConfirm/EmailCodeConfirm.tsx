// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useState } from 'react';
import Button from 'components/atoms/Button/Button';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import errors from 'common/errors';
import userApi from 'data/api/user';

/** the text for a failed `User/verifyEmail` (null: nothing to show) */
export function emailCodeErrorMessage(e: unknown): string | null {
  const code = e instanceof Error ? e.message : typeof e === 'string' ? e : undefined;
  switch (code) {
    case errors.server.REAUTH_REQUIRED:
      // "Confirm it's you" was cancelled
      return null;
    case errors.server.VERIFY_EMAIL_EXPIRED_TOKEN:
      return "This code has expired. Send a new one.";
    case errors.server.RATE_LIMIT_EXCEEDED:
      return "Too many wrong codes. Send a new one.";
    case errors.server.EXISTS_ALREADY:
      return "This address already belongs to another account.";
    default:
      return "That code isn't right. Check the email and try again.";
  }
}

type Props = {
  /** the address the code was sent to */
  email: string;
  onConfirmed: () => void | Promise<void>;
  label?: string;
  subLabel?: string;
  buttonText?: string;
};

/**
 * The 6-digit code from a confirmation mail (`User/requestEmailVerification`)
 * → `User/verifyEmail`. The address becomes the account's address once this
 * succeeds (docs/auth-identity §8).
 */
const EmailCodeConfirm: React.FC<Props> = ({ email, onConfirmed, label = 'Code', subLabel, buttonText = 'Confirm email' }) => {
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | undefined>();
  const [loading, setLoading] = useState(false);

  const confirm = useCallback(async () => {
    const value = code.replace(/\s+/g, '');
    if (!/^[0-9]{6}$/.test(value)) {
      setError("Enter the 6-digit code from the email.");
      return;
    }
    setLoading(true);
    setError(undefined);
    try {
      await userApi.verifyEmail({ email, token: value });
      setCode('');
      await onConfirmed();
    }
    catch (e) {
      setError(emailCodeErrorMessage(e) ?? undefined);
    }
    finally {
      setLoading(false);
    }
  }, [code, email, onConfirmed]);

  return (
    <form className='flex flex-col gap-2 w-full' onSubmit={ev => { ev.preventDefault(); ev.stopPropagation(); confirm(); }}>
      <TextInputField
        label={label}
        subLabel={subLabel ?? `We sent a 6-digit code to ${email}.`}
        value={code}
        onChange={value => { setCode(value); setError(undefined); }}
        placeholder='123456'
        autoComplete='one-time-code'
        name='code'
        maxLetters={7}
        error={error}
      />
      <Button className='w-full' role='primary' text={buttonText} loading={loading} disabled={loading} />
    </form>
  );
};

export default EmailCodeConfirm;
