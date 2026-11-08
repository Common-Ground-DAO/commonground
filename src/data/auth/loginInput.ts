// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { PROFILE_NAME_PATTERN } from 'common/authInputRules';
import { validateEmailInput } from 'common/validators';

/**
 * What is wrong with the identifier typed into the login form, before
 * anything is sent: the server takes an email address or a username
 * (srv/validators, `aliasOrEmail`). Undefined when it can be sent.
 */
export function identifierProblem(value: string): string | undefined {
  const identifier = value.trim();
  if (!identifier) {
    return "Enter your email address or username.";
  }
  if (identifier.includes('@')) {
    return validateEmailInput(identifier) === undefined ? undefined : "That email address doesn't look right. Please check it.";
  }
  return PROFILE_NAME_PATTERN.test(identifier)
    ? undefined
    : "Usernames have 3-30 letters, numbers, - and _. Or enter your email address.";
}
