// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useRef } from 'react';
import 'altcha-widget-element';
import urlConfig from 'data/util/urls';

// Thin React wrapper around the ALTCHA web component (<altcha-widget>). The
// widget fetches a proof-of-work challenge from the backend, solves it in the
// browser and emits a base64 payload on success which is forwarded to
// `onVerified`. Used both by the trust-score CaptchaModal and the registration
// form (SetupProfile).

type Props = {
  onVerified: (payload: string) => void;
  onReset?: () => void;
  className?: string;
};

const challengeUrl = `${urlConfig.API_URL.replace(/\/$/, '')}/Captcha/challenge`;

const AltchaWidget: React.FC<Props> = ({ onVerified, onReset, className }) => {
  const ref = useRef<HTMLElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) {
      return;
    }
    const onStateChange = (ev: Event) => {
      const detail = (ev as CustomEvent).detail;
      if (detail?.state === 'verified' && typeof detail?.payload === 'string') {
        onVerified(detail.payload);
      } else if (detail?.state && detail.state !== 'verified' && onReset) {
        onReset();
      }
    };
    el.addEventListener('statechange', onStateChange);
    return () => el.removeEventListener('statechange', onStateChange);
  }, [onVerified, onReset]);

  return (
    <div className={className}>
      {React.createElement('altcha-widget', {
        ref,
        challengeurl: challengeUrl,
      })}
    </div>
  );
};

export default AltchaWidget;
