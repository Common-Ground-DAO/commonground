// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import { reauthMethods, shownReauthMethod } from './reauthMethods';

describe('reauthMethods', () => {
  it('offers only what the account has, a passkey first', () => {
    expect(reauthMethods({ canUsePasskey: true, hasPassword: true, hasLoginWallet: true })).toEqual(['passkey', 'password', 'wallet']);
    expect(reauthMethods({ canUsePasskey: true, hasPassword: false, hasLoginWallet: false })).toEqual(['passkey']);
    // e.g. a session from a transfer link of an account that signs in with a wallet only
    expect(reauthMethods({ canUsePasskey: false, hasPassword: false, hasLoginWallet: true })).toEqual(['wallet']);
    expect(reauthMethods({ canUsePasskey: false, hasPassword: true, hasLoginWallet: false })).toEqual(['password']);
  });

  it('offers the password while it is not known whether there is one', () => {
    expect(reauthMethods({ canUsePasskey: false, hasPassword: null, hasLoginWallet: true })).toEqual(['password', 'wallet']);
    expect(reauthMethods({ canUsePasskey: false, hasPassword: null, hasLoginWallet: false })).toEqual(['password']);
  });

  it('nothing to confirm with: nothing offered', () => {
    expect(reauthMethods({ canUsePasskey: false, hasPassword: false, hasLoginWallet: false })).toEqual([]);
  });
});

describe('shownReauthMethod', () => {
  const account = { canUsePasskey: false, hasPassword: null as boolean | null, hasLoginWallet: false, passwordPending: true };

  it('shows a passkey or a wallet right away, the password form only once it is known to exist', () => {
    expect(shownReauthMethod(null, { ...account, canUsePasskey: true, hasLoginWallet: true })).toBe('passkey');
    expect(shownReauthMethod(null, { ...account, hasLoginWallet: true })).toBe('wallet');
    expect(shownReauthMethod(null, account)).toBeNull();
    expect(shownReauthMethod(null, { ...account, hasPassword: true, passwordPending: false })).toBe('password');
    expect(shownReauthMethod(null, { ...account, hasPassword: false, passwordPending: false })).toBeNull();
  });

  it('keeps the current choice while the account has it', () => {
    expect(shownReauthMethod('wallet', { ...account, canUsePasskey: true, hasPassword: true, hasLoginWallet: true, passwordPending: false })).toBe('wallet');
    // chosen while still unknown, then found missing: the next one the account has
    expect(shownReauthMethod('password', { ...account, hasPassword: false, hasLoginWallet: true, passwordPending: false })).toBe('wallet');
  });

  it('a failed lookup offers the password, and the server answers', () => {
    expect(shownReauthMethod(null, { ...account, passwordPending: false })).toBe('password');
  });
});


describe('email confirmation availability', () => {
  it('keeps email available even when a password and wallets are recorded', () => {
    expect(reauthMethods({ canUsePasskey: false, hasPassword: true, hasLoginWallet: true, canUseEmail: true }))
      .toEqual(['password', 'wallet', 'email']);
  });
  it('uses email as the remaining method only when the server permits it', () => {
    const account = { canUsePasskey: false, hasPassword: false, hasLoginWallet: false, passwordPending: false };
    expect(shownReauthMethod(null, { ...account, canUseEmail: true })).toBe('email');
    expect(shownReauthMethod(null, { ...account, canUseEmail: false })).toBeNull();
  });
});
