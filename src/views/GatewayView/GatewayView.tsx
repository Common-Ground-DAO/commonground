// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import Button from 'components/atoms/Button/Button';
import CgLogoIcon from 'components/atoms/icons/misc/Logo/logo.svg?react';
import AuthFlow from 'components/organisms/AuthFlow/AuthFlow';
import { StepError, StepHeader, errorCode } from 'components/organisms/AuthFlow/shared';
import { useConnectionContext } from 'context/ConnectionProvider';
import { getInstanceConfig } from 'common/instance';
import errors from 'common/errors';
import { safeNextPath } from 'common/safeNextPath';
import { rateLimitMessage } from 'data/auth/authErrors';
import loginManager from 'data/appstate/login';
import gatewayApi from './gatewayApi';
import 'components/organisms/AuthFlow/AuthFlow.css';
import 'components/organisms/SecurityStep/SecurityStep.css';

/**
 * The whole web app of a gateway (docs/auth-identity §12): Common Ground
 * moved to another instance (`gatewayTargetUrl`). People sign in here with
 * any of their old methods — no sign-up — and continue with a one-time link
 * that signs them in there (User/createTransferLink). The path they opened
 * here (an old deep link) goes along, so `<old>/<path>` ends on
 * `<new>/<path>` after the move.
 */
const GatewayView: React.FC = () => {
  const { loginState } = useConnectionContext();
  const target = getInstanceConfig()?.gatewayTargetUrl ?? '';
  const targetHost = useMemo(() => {
    try {
      return new URL(target).host;
    }
    catch {
      return target;
    }
  }, [target]);
  // the deep link this page was opened with; the target checks it again
  const [nextPath] = useState(() => {
    const path = safeNextPath(`${window.location.pathname}${window.location.search}`, window.location.origin);
    return path && path !== '/' && !path.startsWith('/login') ? path : null;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const continueToTarget = useCallback(async () => {
    setBusy(true);
    setError(undefined);
    try {
      const { url } = await gatewayApi.createTransferLink(nextPath ? { nextPath } : {});
      window.location.assign(url);
    }
    catch (e) {
      const code = errorCode(e);
      setError(code === errors.server.RATE_LIMIT_EXCEEDED
        ? rateLimitMessage(e, { what: 'Too many sign-in links were requested.' })
        : code === errors.server.LOGIN_REQUIRED
          ? 'Your session has ended. Please sign in again.'
          : "The link to the new site couldn't be created. Please try again.");
      setBusy(false);
    }
  }, [nextPath]);

  // a gateway opens no data socket, whose connection would start the
  // automatic sign-in with this browser's device key: start it here
  useEffect(() => {
    void loginManager.autoLogin();
  }, []);

  // right after a sign-in with a sign-in method in this tab the move
  // continues by itself; a page that opens signed in (the device key) or a
  // tab that took over another tab's sign-in shows the button instead
  const continued = useRef(false);
  useEffect(() => {
    if (loginState === 'anonymous') {
      continued.current = false;
    }
    else if (loginState === 'loggedin' && loginManager.signedInInThisTab && !continued.current) {
      continued.current = true;
      void continueToTarget();
    }
  }, [loginState, continueToTarget]);

  const settling = loginState === 'pending' || loginState === 'loggingin' || loginState === 'loggingout';

  return (
    <div className='transfer-view gateway-view'>
      {loginState !== 'loggedin' && !settling && <div className='flex flex-col items-center gap-2 px-4 pt-8 text-center max-w-md mx-auto'>
        <h1 className='cg-heading-2 cg-text-main'>Common Ground has moved to {targetHost}</h1>
        <span className='cg-text-md-400 cg-text-secondary'>
          Sign in with your account as before. You then continue on {targetHost} with everything you had here.
          New accounts are created on <a className='underline' href={target}>{targetHost}</a>.
        </span>
      </div>}
      {loginState !== 'loggedin' && !settling && <AuthFlow
        variant='page'
        initialMode='login'
        allowSignup={false}
        // the move continues by itself once this tab's sign-in is done (above)
        onLoggedIn={() => undefined}
        onSignedUp={() => undefined}
      />}
      {(loginState === 'loggedin' || settling) && <div className='auth-flow auth-flow-page'>
        <div className='auth-flow-logo'>
          <CgLogoIcon />
        </div>
        <div className='auth-flow-step'>
          {settling && <StepHeader title='Loading…' />}
          {loginState === 'loggedin' && <>
            <StepHeader
              title={`Common Ground has moved to ${targetHost}`}
              subtitle={`A one-time link signs you in on ${targetHost}. There you set up a way to sign in that works on the new site.`}
            />
            <Button className='w-full' role='primary' text={`Continue to ${targetHost}`} onClick={continueToTarget} loading={busy} disabled={busy} />
            <Button className='w-full' role='textual' text='Sign out' onClick={() => { void loginManager.logout(); }} disabled={busy} />
            <StepError message={error} />
          </>}
        </div>
      </div>}
    </div>
  );
};

export default GatewayView;
