// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useSyncExternalStore } from 'react';
import securityStepState from 'data/auth/securityStep';

/** whether the signed-in account has to finish the account-security step */
export function useSecurityStepRequired(): boolean {
  return useSyncExternalStore(
    listener => securityStepState.subscribe(listener),
    () => securityStepState.required,
  );
}
