// SPDX-License-Identifier: AGPL-3.0-or-later
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md
import type express from "express";
import errors from "../common/errors";
import passkeyHelper from "../repositories/passkeys";
import { hasRecentAuth } from "./authSession";
import { requireAuthToAdd, SECURITY_STEP_AUTH_MAX_AGE_MS } from "./securityStep";

/** true: use the atomic first-passkey insert; false: ordinary authorized addition. */
export async function requirePasskeyAddition(request: express.Request, rpId: string, emailRequired: boolean): Promise<boolean> {
  try {
    await requireAuthToAdd(request, 'sign-in-method', { emailRequired });
    return false;
  }
  catch (e) {
    if (!(e instanceof Error) || e.message !== errors.server.REAUTH_REQUIRED) throw e;
    const user = request.session?.user;
    if (user && request.session.transferPasskeyRpId === rpId
      && hasRecentAuth(request, { allow: ['transfer'], maxAgeMs: SECURITY_STEP_AUTH_MAX_AGE_MS })
      && !await passkeyHelper.hasUserPasskeys(user.id, rpId)) {
      return true;
    }
    throw e;
  }
}
