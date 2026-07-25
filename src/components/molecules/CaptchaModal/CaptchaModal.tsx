// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import Modal from '../../atoms/Modal/Modal';
import ReCAPTCHA from 'react-google-recaptcha';
import config from 'common/config';
import { useDarkModeContext } from 'context/DarkModeProvider';
import userApi from 'data/api/user';
import AltchaWidget from '../AltchaWidget/AltchaWidget';
import { ReactComponent as CircleLogo } from "components/atoms/icons/misc/Logo/logo.svg";
import './CaptchaModal.css';

const CaptchaModal = () => {
  const mode = useDarkModeContext();
  const provider = config.CAPTCHA_PROVIDER;

  // Provider "off" is an explicit opt-out (dev/private instances): auto-clear
  // the trust-score gate instead of showing a widget the backend won't check.
  React.useEffect(() => {
    if (provider === 'off') {
      userApi.verifyCaptcha({ token: 'off' });
    }
  }, [provider]);

  if (provider === 'off') {
    return null;
  }

  if (provider === 'recaptcha' && !config.GOOGLE_RECAPTCHA_SITE_KEY) {
    return null;
  }

  return (
    <Modal hideHeader modalInnerClassName={`captcha-modal-outer`}>
      <div className='captcha-modal-content mt-2'>
        <CircleLogo style={{ width: '100px', height: '100px' }} />
      </div>
      <div className='my-6'>
        <h1 className='text-center cg-heading-3'>Help keep Common Ground safe</h1>
        <p className='text-center cg-text-lg-500'>We may ask again in the future, thanks for your understanding! 🙏</p>
      </div>
      {provider === 'altcha' ? (
        <AltchaWidget
          className='captcha-modal-inner mb-2'
          onVerified={(token) => { userApi.verifyCaptcha({ token }); }}
        />
      ) : (
        <ReCAPTCHA
          sitekey={config.GOOGLE_RECAPTCHA_SITE_KEY || ''}
          theme={mode.isDarkMode ? 'dark' : 'light'}
          className='captcha-modal-inner mb-2'
          onChange={async (token) => {
            if (!!token) {
              await userApi.verifyCaptcha({ token });
            }
          }}
        />
      )}
    </Modal>
  );
}

export default React.memo(CaptchaModal);
