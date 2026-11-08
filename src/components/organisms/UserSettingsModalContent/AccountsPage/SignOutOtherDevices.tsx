// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useState } from 'react';
import { SignOut } from '@phosphor-icons/react';
import Button from 'components/atoms/Button/Button';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import UserSettingsButton from 'components/molecules/UserSettingsButton/UserSettingsButton';
import { useStepUp } from 'context/StepUpProvider';
import { useSnackbarContext } from 'context/SnackbarContext';
import userApi from 'data/api/user';
import { securityActionErrorMessage } from 'data/auth/authErrors';
import { signedOutDevicesText } from 'data/auth/signedOut';

type Props = {
  lockModal: (lock: boolean) => void;
};

/**
 * "Sign out other devices" (User/signOutOtherDevices, docs/auth-identity
 * §2): every other session of the account ends and every other device key is
 * deleted; this device stays signed in. Asks first, then "Confirm it's you",
 * and says what it did.
 */
const SignOutOtherDevices: React.FC<Props> = ({ lockModal }) => {
  const { ensureRecentAuth } = useStepUp();
  const { showSnackbar } = useSnackbarContext();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);

  const setDialog = useCallback((open: boolean) => {
    setConfirming(open);
    lockModal(open);
  }, [lockModal]);

  const signOut = useCallback(async () => {
    setBusy(true);
    try {
      const auth = await ensureRecentAuth('sign out your other devices');
      if (auth === 'cancelled') {
        return;
      }
      const { devices, delayed } = await userApi.signOutOtherDevices();
      const text = signedOutDevicesText(devices, delayed) ?? 'No other device was signed in.';
      setResult(text);
      setDialog(false);
      showSnackbar({ type: 'info', text });
    }
    catch (e) {
      const message = securityActionErrorMessage(e, 'Your other devices could not be signed out');
      if (message) {
        showSnackbar({ type: 'warning', text: message });
      }
    }
    finally {
      setBusy(false);
    }
  }, [ensureRecentAuth, setDialog, showSnackbar]);

  return (<>
    <UserSettingsButton
      leftElement={<SignOut weight='duotone' className='w-5 h-5' />}
      text='Sign out other devices'
      onClick={() => setDialog(true)}
    />
    {!!result && <span className='cg-text-md-400 cg-text-secondary px-1' role='status'>{result}</span>}

    <ScreenAwareModal
      isOpen={confirming}
      onClose={() => setDialog(false)}
      hideHeader
    >
      <div className='flex flex-col p-4 gap-6'>
        <div className='flex flex-col gap-2'>
          <span className='cg-heading-3 cg-text-main'>Sign out other devices?</span>
          <span className='cg-text-md-400 cg-text-secondary'>
            Every other browser and app signed in to your account is signed out and has to sign in again. This device stays signed in.
          </span>
        </div>
        <div className="btnList justify-end align-center">
          <Button role="secondary" text="Cancel" onClick={() => setDialog(false)} disabled={busy} />
          <Button role="primary" text="Sign out other devices" onClick={signOut} loading={busy} disabled={busy} />
        </div>
      </div>
    </ScreenAwareModal>
  </>);
};

export default React.memo(SignOutOtherDevices);
