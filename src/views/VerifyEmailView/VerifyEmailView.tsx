// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import React from "react";
import { useNavigate } from "react-router-dom";
import userApi from "data/api/user";
import Button from "components/atoms/Button/Button";
import errors from "common/errors";
import { useConnectionContext } from "context/ConnectionProvider";

/**
 * The link in a confirmation mail (`/verify-email?email=…&token=<code>`).
 * The code belongs to the account that asked for it, so this only works while
 * signed in to that account (docs/auth-identity §8).
 */
export default function VerifyEmailView() {
  const navigate = useNavigate();
  // the code belongs to an account: wait until the app knows whether (and
  // as whom) this browser is signed in (autoLogin)
  const { loginState } = useConnectionContext();
  const settled = loginState === "loggedin" || loginState === "anonymous";
  const attempted = React.useRef(false);
  const [isVerified, setIsVerified] = React.useState(false);
  const [loading, setLoading] = React.useState(true);
  const [errorMessage, setErrorMessage] = React.useState("");
  const [needsLogin, setNeedsLogin] = React.useState(false);
  const params = React.useMemo(() => new URLSearchParams(window.location.search), []);
  const email = params.get('email') || '';
  const token = params.get('token') || '';

  React.useEffect(() => {
    if (!settled) {
      return;
    }
    if (loginState === "anonymous") {
      setNeedsLogin(true);
      setLoading(false);
      return;
    }
    if (token && email && !attempted.current) {
      attempted.current = true;
      userApi
        .verifyEmail({ email, token })
        .then(() => {
          setIsVerified(true);
        })
        .catch((error) => {
          switch (error?.message) {
            case errors.server.LOGIN_REQUIRED:
              setNeedsLogin(true);
              break;
            case errors.server.VERIFY_EMAIL_EXPIRED_TOKEN:
              setErrorMessage('The code has expired. Ask for a new one in your account settings.');
              break;
            case errors.server.RATE_LIMIT_EXCEEDED:
              setErrorMessage('Too many attempts. Ask for a new code in your account settings.');
              break;
            case errors.server.EXISTS_ALREADY:
              setErrorMessage('This address already belongs to another account.');
              break;
            default:
              setErrorMessage('This link is not valid (any more), or it belongs to another account than the one you are signed in to.');
              break;
          }
          setIsVerified(false);
        })
        .finally(() => {
          setLoading(false);
        });
    }
    else if (!token || !email) {
      setLoading(false);
    }
  }, [email, token, settled, loginState]);

  if (!token || !email) {
    return (
      <div className="flex items-center justify-center w-screen h-screen cg-text-main cg-heading-2">
        <span>This confirmation link is incomplete.</span>
      </div>
    );
  }
  if (needsLogin) {
    const next = `${window.location.pathname}${window.location.search}`;
    return (
      <div className="flex flex-col items-center justify-center w-screen h-screen gap-4 cg-text-main cg-heading-2">
        <span className="text-center">Sign in to the account that asked for this confirmation, then open the link again.</span>
        <Button role="primary" text="Sign in" onClick={() => navigate(`/login?next=${encodeURIComponent(next)}`)} />
      </div>
    );
  }
  return (
    <div className="flex flex-col items-center justify-center w-screen h-screen cg-text-main cg-heading-2">
      <span className="mb-4 text-center">
        {loading
          ? "Confirming your email address..."
          : isVerified
          ? "Your email address is confirmed. You can close this window."
          : `Confirmation failed: ${errorMessage}`}
      </span>
      <Button role={"primary"} text={"Close tab"} onClick={() => window.close()} />
    </div>
  );
}
