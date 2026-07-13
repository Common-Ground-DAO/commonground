// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from 'react'
import Modal from '../../atoms/Modal/Modal';
import ReCAPTCHA from 'react-google-recaptcha';
import config from 'common/config';
import { useDarkModeContext } from 'context/DarkModeProvider';
import userApi from 'data/api/user';
import { ReactComponent as CircleLogo } from "components/atoms/icons/misc/Logo/logo.svg";
import './CaptchaModal.css';

const CaptchaModal = () => {
  const mode = useDarkModeContext();

  // instances without a reCAPTCHA site key (self-hosted) verify with a stub
  // token; the backend skips captcha checks when it has no secret key either
  React.useEffect(() => {
    if (!config.GOOGLE_RECAPTCHA_SITE_KEY) {
      userApi.verifyCaptcha({ token: 'stub' });
    }
  }, []);

  if (!config.GOOGLE_RECAPTCHA_SITE_KEY) {
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
      <ReCAPTCHA
        sitekey={config.GOOGLE_RECAPTCHA_SITE_KEY || ''}
        theme={mode.isDarkMode ? 'dark' : 'light'}
        className='captcha-modal-inner mb-2'
        onChange={async (token) => {
          if (!!token) {
            const verifyResult = await userApi.verifyCaptcha({
              token,
            });
          }
        }}
      />
    </Modal>
  );
}

export default React.memo(CaptchaModal);