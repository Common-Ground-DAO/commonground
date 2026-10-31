// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from "common/errors";

export const LAST_LOGIN_METHOD_MESSAGE =
  "This is your last way to sign in. Add another sign-in method (a passkey, a password or a wallet) first.";

/**
 * Message for a failed account-security action, or null when there is
 * nothing to show: REAUTH_REQUIRED reaching a caller means the user cancelled
 * the "Confirm it's you" dialog.
 */
export function securityActionErrorMessage(e: unknown, fallback: string): string | null {
  const code = e instanceof Error ? e.message : typeof e === "string" ? e : undefined;
  switch (code) {
    case errors.server.REAUTH_REQUIRED:
      return null;
    case errors.server.LAST_LOGIN_METHOD:
      return LAST_LOGIN_METHOD_MESSAGE;
    case errors.server.RATE_LIMIT_EXCEEDED:
      return "Too many attempts. Please wait a few minutes and try again.";
    default:
      return fallback;
  }
}

const SERVER_CODES: ReadonlySet<string> = new Set(Object.values(errors.server));

/**
 * Like securityActionErrorMessage, but keeps a message that is already meant
 * for people (an Error thrown by UI code); raw server codes never reach the
 * screen.
 */
export function userFacingErrorMessage(e: unknown, fallback: string): string | null {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (message && !SERVER_CODES.has(message)) {
    return message;
  }
  return securityActionErrorMessage(e, fallback);
}
