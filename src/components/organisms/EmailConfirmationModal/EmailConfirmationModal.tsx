// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import './EmailConfirmationModal.css';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import ScreenAwareModal from 'components/atoms/ScreenAwareModal/ScreenAwareModal';
import Button from 'components/atoms/Button/Button';
import { useWindowSizeContext } from 'context/WindowSizeProvider';
import TextInputField from 'components/molecules/inputs/TextInputField/TextInputField';
import { validateEmailInput } from 'common/validators';
import Tag from 'components/atoms/Tag/Tag';
import userApi from 'data/api/user';
import EmailCodeConfirm from 'components/molecules/EmailCodeConfirm/EmailCodeConfirm';

export type EmailConfirmationModalState = 'signup' | 'pending' | 'confirmed';

type Props = {
  onClose: () => void;
  modalState: EmailConfirmationModalState;
  setModalState: (state: EmailConfirmationModalState) => void
  userEmail: string;
};

const useCountdown = () => {
  const [countdown, setCountdown] = useState(0);
  const countdownRef = useRef<any>(null);
  
  if (countdown > 0 && !countdownRef.current) {
    countdownRef.current = setTimeout(() => {
      setCountdown(old => old - 1);
      countdownRef.current = null;
    }, 1000);
  }

  return [countdown, setCountdown] as const;
}

const EmailConfirmationModal: React.FC<Props> = ({ onClose, modalState, setModalState, userEmail}) => {
  const { isMobile, isTablet } = useWindowSizeContext();
  const [email, setEmail] = useState(userEmail);
  const [showEmailError, setShowEmailError] = useState(false);
  const [countdown, setCountdown] = useCountdown();

  const primaryButtonText = useMemo(() => {
    if (modalState === 'signup') return 'Turn on Newsletters';
    else if (modalState === 'pending') return 'Please confirm email';
    else if (modalState === 'confirmed') return 'Done';

    throw new Error('Unexpected modal state');
  }, [modalState]);

  const onPrimaryClick = useCallback(async () => {
    if (modalState === 'signup') {
      if (!!validateEmailInput(email)) {
        setShowEmailError(true);
        return;
      }
      // the address becomes the account's address once it is confirmed
      await userApi.requestEmailVerification({ email });
      setModalState('pending');
      setCountdown(60);
    } else if (modalState === 'confirmed') {
      onClose();
    }
  }, [email, modalState, onClose, setCountdown, setModalState]);

  useEffect(() => {
    //set countdown on first render of pending state
    if (modalState === 'pending' && countdown === 0) {
      setCountdown(60);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const onResendEmail = useCallback(() => {
    userApi.requestEmailVerification({email});
    setCountdown(60);
  }, [email, setCountdown]);

  return (<ScreenAwareModal
    isOpen={true}
    onClose={onClose}
    hideHeader
    noDefaultScrollable
    modalRootStyle={{ zIndex: 10101 }}
  >
    <div className='flex flex-col pt-2 gap-10 cg-text-main'>
      <div className='flex flex-col gap-6'>
        {modalState === 'signup' && <>
          <h2 className='text-center'>Get news from your communities in your inbox</h2>
          <div className='flex flex-col gap-2'>
            <TextInputField
              label={<span className='flex'>Email<span className='cg-text-warning'>*</span></span>}
              value={email}
              onChange={setEmail}
              placeholder='your@email.com'
            />
            {showEmailError && <Tag
              className='w-full gap-2'
              variant='warning'
              label='Please add your email above'
              largeFont
            />}
          </div>
        </>}
        {modalState === 'pending' && <>
          <h2 className='text-center'>Check your email</h2>
          <span className='cg-text-lg-400 text-center'>{`We’ve sent a code to ${email}. Enter it below, or open the link in the mail.`}</span>
          <EmailCodeConfirm email={email} subLabel='' onConfirmed={() => setModalState('confirmed')} />
        </>}
        {modalState === 'confirmed' && <>
          <h2 className='text-center'>Your email was confirmed!</h2>
          <span className='cg-text-lg-400 text-center'>You’ll now get news from your communities.</span>
        </>}
      </div>

      <div className='flex flex-col gap-4'>
        {modalState !== 'pending' && <span className='cg-text-md-400 cg-text-secondary text-center'>You can manage emails in your user settings</span>}
        {modalState === 'pending' && <Button
          role='secondary'
          text={`Send confirmation again${countdown > 0 ? ` (${countdown} s)`: ''}`}
          className='flex-1'
          onClick={onResendEmail}
          disabled={countdown > 0}
        />}
        <div className='flex gap-2'>
          {modalState !== 'confirmed' && <Button
            role='secondary'
            text={modalState === 'pending' ? 'Close' : 'Not now'}
            className='flex-1'
            onClick={onClose}
          />}
          {modalState !== 'pending' && <Button
            role='primary'
            className='flex-1'
            text={primaryButtonText}
            onClick={onPrimaryClick}
          />}
        </div>
      </div>

    </div>
  </ScreenAwareModal>);
}

export default EmailConfirmationModal