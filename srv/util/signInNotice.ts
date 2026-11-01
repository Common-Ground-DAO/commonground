// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import userHelper from "../repositories/users";
import emailUtils, { emailEnabled } from "../api/emails";

/**
 * Best-effort notices to the account's verified address about changes to how
 * the account is accessed. They never throw and never delay the response.
 */

function toVerifiedAddress(userId: string, send: (address: string) => Promise<void>, what: string): void {
  if (!emailEnabled()) {
    return;
  }
  userHelper.getOwnDataById(userId)
    .then(ownData => {
      if (ownData.email && ownData.emailVerified) {
        return send(ownData.email);
      }
    })
    .catch(e => console.error(`Error sending the ${what} notice`, e instanceof Error ? e.message : e));
}

/** a sign-in method was added (passkey, sign-in wallet, X/LUKSO/Farcaster account) */
export function notifyNewSignInMethod(userId: string, method: string): void {
  toVerifiedAddress(userId, address => emailUtils.sendNewSignInMethodEmail(address, method), "new sign-in method");
}

/** the password was set or replaced */
export function notifyPasswordChanged(userId: string): void {
  toVerifiedAddress(userId, address => emailUtils.sendPasswordChangedEmail(address), "password change");
}

/** the account's verified address was replaced: told to the previous one */
export function notifyEmailChanged(previousAddress: string): void {
  if (!emailEnabled()) {
    return;
  }
  emailUtils.sendEmailChangedEmail(previousAddress)
    .catch(e => console.error("Error sending the email change notice", e instanceof Error ? e.message : e));
}
