// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useSyncExternalStore } from 'react';
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import Button from 'components/atoms/Button/Button';
import { useUserOnboardingContext } from 'context/UserOnboarding';
import signedOutNotice from 'data/auth/signedOut';
import '../ReauthDialog/ReauthDialog.css';

/**
 * "You were signed out on this device" (docs/auth-identity §2): shown after
 * this device was signed out from elsewhere — another device used "Sign out
 * other devices", or the account's password, email or sign-in methods
 * changed there. Offers to sign in again.
 */
const SignedOutNotice: React.FC = () => {
  const shown = useSyncExternalStore(
    listener => signedOutNotice.subscribe(listener),
    () => signedOutNotice.shown,
  );
  const { setUserOnboardingVisibility } = useUserOnboardingContext();

  const signIn = useCallback(() => {
    signedOutNotice.dismiss();
    setUserOnboardingVisibility(true);
  }, [setUserOnboardingVisibility]);

  if (!shown) {
    return null;
  }

  return (
    <ScreenAwareModal
      isOpen
      hideHeader
      onClose={() => signedOutNotice.dismiss()}
      customClassname='reauth-dialog-modal'
    >
      <div className='reauth-dialog'>
        <div className='flex flex-col gap-1'>
          <span className='cg-heading-3 cg-text-main'>You were signed out</span>
          <span className='cg-text-md-400 cg-text-secondary'>
            Your account was signed out on this device from another device, or its password, email address or sign-in methods were changed there. Sign in again to continue.
          </span>
        </div>
        <Button className='w-full' role='primary' text='Sign in' onClick={signIn} />
        <Button className='w-full' role='textual' text='Not now' onClick={() => signedOutNotice.dismiss()} />
      </div>
    </ScreenAwareModal>
  );
};

export default React.memo(SignedOutNotice);
