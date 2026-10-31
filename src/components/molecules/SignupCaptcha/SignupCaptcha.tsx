// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect } from 'react';
import ReCAPTCHA from 'react-google-recaptcha';
import AltchaWidget from 'components/molecules/AltchaWidget/AltchaWidget';
import config from 'common/config';
import { useDarkModeContext } from 'context/DarkModeProvider';
import { CAPTCHA_MISCONFIGURED_TEXT, useCaptchaProvider } from 'context/CaptchaContext';

type Props = {
  /** the token User/createUser sends as `recaptchaToken`; '' = not solved */
  onChange: (token: string) => void;
};

/**
 * Registration captcha (ALTCHA or reCAPTCHA, whichever the backend verifies).
 * Dev skips the captcha server-side and "off" is an explicit opt-out: both
 * report a placeholder token so sign-up is not blocked.
 */
const SignupCaptcha: React.FC<Props> = ({ onChange }) => {
  const { provider, resolved, misconfigured } = useCaptchaProvider();
  const mode = useDarkModeContext();
  const skipped = config.DEPLOYMENT === 'dev' || (resolved ? provider === 'off' : config.CAPTCHA_PROVIDER === 'off');

  useEffect(() => {
    if (skipped) {
      onChange('stub');
    }
  }, [skipped, onChange]);

  if (skipped || !resolved) {
    return null;
  }
  if (misconfigured) {
    return <span className='cg-text-error text-center'>{CAPTCHA_MISCONFIGURED_TEXT}</span>;
  }
  return (
    <div className='grid justify-items-center items-center'>
      {provider === 'altcha' ? (
        <AltchaWidget
          onVerified={token => onChange(token)}
          onReset={() => onChange('')}
        />
      ) : (
        <ReCAPTCHA
          sitekey={config.GOOGLE_RECAPTCHA_SITE_KEY || ''}
          theme={mode.isDarkMode ? 'dark' : 'light'}
          onChange={token => onChange(token || '')}
        />
      )}
    </div>
  );
};

export default React.memo(SignupCaptcha);
