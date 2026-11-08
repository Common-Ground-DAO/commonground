// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

export type ReauthMethod = 'passkey' | 'password' | 'wallet';

/**
 * The ways the "Confirm it's you" dialog offers, the first one shown first:
 * a passkey of this site, the password, a sign-in wallet — only those the
 * account has. Whether it has a password comes from User/getSecurityStatus;
 * while that is unknown (`null`), the password is offered and the server
 * answers.
 */
export function reauthMethods(account: {
  canUsePasskey: boolean;
  hasPassword: boolean | null;
  hasLoginWallet: boolean;
}): ReauthMethod[] {
  const methods: ReauthMethod[] = [];
  if (account.canUsePasskey) {
    methods.push('passkey');
  }
  if (account.hasPassword !== false) {
    methods.push('password');
  }
  if (account.hasLoginWallet) {
    methods.push('wallet');
  }
  return methods;
}

/**
 * The method the dialog shows: the current one while the account has it,
 * otherwise the first one it has. While it is still being looked up whether
 * the account has a password (`passwordPending`), a passkey or a wallet is
 * shown right away, but the password form only once it is known to exist —
 * null: nothing to show yet. If the lookup failed (`hasPassword` null, no
 * longer pending), the password is offered and the server answers.
 */
export function shownReauthMethod(
  current: ReauthMethod | null,
  account: Parameters<typeof reauthMethods>[0] & { passwordPending: boolean },
): ReauthMethod | null {
  const methods = reauthMethods(account);
  if (current && methods.includes(current)) {
    return current;
  }
  const ready = account.passwordPending ? methods.filter(method => method !== 'password') : methods;
  return ready[0] ?? null;
}
