// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it, vi } from 'vitest';
import securityStepState, { nextSecurityStepTask, showSecurityStep } from './securityStep';
import { captureTransferToken, forgetTransferToken, getTransferToken } from './transferToken';
import { PASSWORD_MIN_LENGTH, passwordMeetsPolicy } from 'common/passwordPolicy';

const COMPLETE: API.User.getSecurityStatus.Response = {
  required: false,
  needsSignInMethod: false,
  needsVerifiedEmail: false,
  needsNewPassword: false,
  email: 'someone@example.org',
  emailVerified: true,
  hasPassword: true,
  passkeys: 0,
  loginWallets: 0,
};

describe('account-security step', () => {
  it('asks for the email first, then a new password, then a sign-in method', () => {
    expect(nextSecurityStepTask(COMPLETE)).toBeNull();
    const all = { ...COMPLETE, required: true, needsSignInMethod: true, needsVerifiedEmail: true, needsNewPassword: true };
    expect(nextSecurityStepTask(all)).toBe('email');
    expect(nextSecurityStepTask({ ...all, needsVerifiedEmail: false })).toBe('new-password');
    expect(nextSecurityStepTask({ ...all, needsVerifiedEmail: false, needsNewPassword: false })).toBe('sign-in-method');
  });

  it('tells listeners when the state changes', () => {
    const listener = vi.fn();
    const unsubscribe = securityStepState.subscribe(listener);
    securityStepState.set(true);
    securityStepState.set(true);
    securityStepState.set(false);
    unsubscribe();
    securityStepState.set(true);
    expect(listener.mock.calls).toEqual([[true], [false]]);
    securityStepState.set(false);
  });
});

describe('security step after a reload (gating)', () => {
  const USER = 'u-1';
  const OTHER = 'u-2';

  function stubStorage() {
    const values = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => { values.set(key, value); },
      removeItem: (key: string) => { values.delete(key); },
    });
    return values;
  }

  it('the remembered flag is known before the re-login answers, and the routes wait for it', () => {
    stubStorage();
    securityStepState.setUser(USER);
    securityStepState.set(true);
    // a reload: the page starts without a user, then the cached user is restored
    securityStepState.setUser(null);
    expect(securityStepState.required).toBe(false);
    securityStepState.setUser(USER);
    expect(securityStepState.required).toBe(true);
    // the automatic re-login has not answered yet: the step, not the app
    expect(showSecurityStep(securityStepState.required, 'pending')).toBe(true);
    expect(showSecurityStep(securityStepState.required, 'loggingin')).toBe(true);
    expect(showSecurityStep(securityStepState.required, 'loggedin')).toBe(true);
    expect(showSecurityStep(securityStepState.required, 'anonymous')).toBe(false);
    expect(showSecurityStep(securityStepState.required, 'loggingout')).toBe(false);
    vi.unstubAllGlobals();
  });

  it('another account does not inherit it; clearing it forgets it', () => {
    stubStorage();
    securityStepState.setUser(USER);
    securityStepState.set(true);
    securityStepState.setUser(OTHER);
    expect(securityStepState.required).toBe(false);
    securityStepState.setUser(USER);
    expect(securityStepState.required).toBe(true);
    securityStepState.set(false);
    securityStepState.setUser(null);
    securityStepState.setUser(USER);
    expect(securityStepState.required).toBe(false);
    expect(showSecurityStep(false, 'pending')).toBe(false);
    securityStepState.setUser(null);
    vi.unstubAllGlobals();
  });

  it('without storage it still works for the page', () => {
    securityStepState.setUser(USER);
    securityStepState.set(true);
    expect(securityStepState.required).toBe(true);
    securityStepState.set(false);
    securityStepState.setUser(null);
  });
});

describe('transfer link token', () => {
  const TOKEN = 'A'.repeat(21) + '_-' + 'b'.repeat(20);

  function at(pathname: string, hash: string, search = '') {
    const history = { state: { x: 1 }, replaceState: vi.fn() };
    captureTransferToken({ pathname, hash, search }, history);
    return history.replaceState;
  }

  it('takes the token out of the address bar and keeps it in memory', () => {
    const replaceState = at('/transfer', `#${TOKEN}`);
    expect(replaceState).toHaveBeenCalledWith({ x: 1 }, '', '/transfer');
    expect(getTransferToken()).toBe(TOKEN);
    forgetTransferToken();
    expect(getTransferToken()).toBeNull();
  });

  it('removes a malformed fragment too, and ignores other pages', () => {
    expect(at('/transfer/', '#not-a-token')).toHaveBeenCalled();
    expect(getTransferToken()).toBeNull();
    expect(at('/c/abc/', `#${TOKEN}`)).not.toHaveBeenCalled();
    expect(at('/transfer', '')).not.toHaveBeenCalled();
    expect(getTransferToken()).toBeNull();
  });
});

describe('password policy', () => {
  it('only a minimum length', () => {
    expect(PASSWORD_MIN_LENGTH).toBe(8);
    expect(passwordMeetsPolicy('1234567')).toBe(false);
    expect(passwordMeetsPolicy('12345678')).toBe(true);
    expect(passwordMeetsPolicy('aaaaaaaa')).toBe(true);
  });
});
