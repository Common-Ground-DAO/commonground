// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React, { useCallback, useState } from 'react';
import { Navigate, useNavigate, useSearchParams } from 'react-router';
import AuthFlow from 'components/organisms/AuthFlow/AuthFlow';
import loginManager from 'data/appstate/login';
import { useUserOnboardingContext } from 'context/UserOnboarding';
import { getUrl } from 'common/util';
import { safeNextPath } from 'common/safeNextPath';

/**
 * /login (and /login?mode=signup): the login / sign-up flow as a page, the
 * same AuthFlow the onboarding modal shows. After a login it goes to `next`
 * (a same-site path) or home; after a sign-up the onboarding modal continues
 * with its tail steps.
 */
const LoginView: React.FC = () => {
  const navigate = useNavigate();
  const [params] = useSearchParams();
  // only a session that existed when the page opened redirects right away;
  // a login on this page may still show the passkey offer before it leaves
  const [alreadyLoggedIn] = useState(() => loginManager.currentUser !== null);
  const { continueAfterSignup } = useUserOnboardingContext();
  const next = safeNextPath(params.get('next'), window.location.origin) || getUrl({ type: 'home' });

  const onLoggedIn = useCallback(() => {
    navigate(next, { replace: true });
  }, [navigate, next]);

  const onSignedUp = useCallback(({ email }: { email: string | null }) => {
    navigate(getUrl({ type: 'home' }), { replace: true });
    continueAfterSignup(email);
  }, [navigate, continueAfterSignup]);

  if (alreadyLoggedIn) {
    return <Navigate to={next} replace />;
  }

  return (
    <div className='login-view'>
      <AuthFlow
        variant='page'
        initialMode={params.get('mode') === 'signup' ? 'signup' : 'login'}
        onLoggedIn={onLoggedIn}
        onSignedUp={onSignedUp}
      />
    </div>
  );
};

export default LoginView;
