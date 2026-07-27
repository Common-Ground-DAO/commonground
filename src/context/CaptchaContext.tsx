// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useEffect, useState } from "react";
import { useOwnUser } from "./OwnDataProvider";
import CaptchaModal from "components/molecules/CaptchaModal/CaptchaModal";
import config from "common/config";
import urlConfig from "data/util/urls";

type CaptchaContextState = {
  captchaVisible: boolean;
};

export type CaptchaProvider = 'altcha' | 'recaptcha' | 'off';

export type CaptchaProviderState = {
  // the provider to render a widget for: the backend's answer once it arrived,
  // the instance-config hint before that
  provider: CaptchaProvider;
  // false while the backend answer is still pending
  resolved: boolean;
  // the resolved provider cannot be rendered on this instance
  misconfigured: boolean;
};

// The backend is the single source of truth for the captcha provider: it is the
// side that verifies tokens, so anything else (build-time defaults, injected
// instance config) is only a hint until this answers. Fetched once per page
// load and shared by every captcha surface.
let providerPromise: Promise<CaptchaProvider | undefined> | undefined;

function fetchCaptchaProvider() {
  if (!providerPromise) {
    const request = fetch(`${urlConfig.API_URL.replace(/\/$/, '')}/Captcha/config`)
      .then(response => response.ok ? response.json() : undefined)
      .then((body: any) => {
        const provider = body?.provider;
        return provider === 'altcha' || provider === 'recaptcha' || provider === 'off'
          ? provider as CaptchaProvider
          : undefined;
      })
      .catch(() => undefined);
    const timeout = new Promise<CaptchaProvider | undefined>(
      resolve => setTimeout(resolve, 5000, undefined)
    );
    providerPromise = Promise.race([request, timeout]).then(provider => {
      // a failed or timed-out lookup must not poison the page-load cache
      if (!provider) {
        providerPromise = undefined;
      }
      return provider;
    });
  }
  return providerPromise;
}

export function useCaptchaProvider(): CaptchaProviderState {
  const [provider, setProvider] = useState<CaptchaProvider>(config.CAPTCHA_PROVIDER);
  const [resolved, setResolved] = useState(false);

  useEffect(() => {
    let mounted = true;
    fetchCaptchaProvider().then(resolvedProvider => {
      if (!mounted) return;
      // unreachable backend falls back to the hint, but the state still counts
      // as resolved so the UI can commit to an error instead of waiting forever
      if (resolvedProvider) setProvider(resolvedProvider);
      setResolved(true);
    });
    return () => { mounted = false; };
  }, []);

  return {
    provider,
    resolved,
    misconfigured: resolved && provider === 'recaptcha' && !config.GOOGLE_RECAPTCHA_SITE_KEY,
  };
}

export const CAPTCHA_MISCONFIGURED_TEXT =
  'Captcha is misconfigured on this instance — please contact the operator.';

export const CaptchaContext = React.createContext<CaptchaContextState>({
  captchaVisible: false,
});

export function CaptchaContextProvider(props: React.PropsWithChildren<{}>) {
  const ownUser = useOwnUser();
  const captchaVisible = ownUser ? parseFloat(ownUser.trustScore) < 1 : false;

  return (
    <CaptchaContext.Provider value={{ captchaVisible }}>
      {captchaVisible && <CaptchaModal />}
      {props.children}
    </CaptchaContext.Provider>
  )
}

export function useCaptchaContext() {
  const context = React.useContext(CaptchaContext);
  return context;
}