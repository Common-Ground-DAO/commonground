// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import userHelper from "../repositories/users";
import emailUtils, { emailEnabled } from "../api/emails";

/**
 * Best-effort mail to the account's verified address that a sign-in method
 * was added (passkey, X/LUKSO/Farcaster account). Never throws and never
 * delays the response.
 */
export function notifyNewSignInMethod(userId: string, method: string): void {
  if (!emailEnabled()) {
    return;
  }
  userHelper.getOwnDataById(userId)
    .then(ownData => {
      if (ownData.email && ownData.emailVerified) {
        return emailUtils.sendNewSignInMethodEmail(ownData.email, method);
      }
    })
    .catch(e => console.error("Error sending the new sign-in method notice", e instanceof Error ? e.message : e));
}
