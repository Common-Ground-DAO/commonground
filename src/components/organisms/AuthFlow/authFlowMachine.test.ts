// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import {
  authFlowReducer,
  captchaAtCreateUser,
  initialAuthFlowState,
  moreLoginMethods,
  signupMethods,
  type AuthFlowConfig,
  type AuthFlowEvent,
  type AuthFlowState,
} from './authFlowMachine';

/**
 * The login / sign-up step machine (AuthFlow). Pins the maintainer decisions
 * that live in transitions: the email is verified BEFORE the account exists
 * (unless the instance sends no mail), sign-up offers passkey / password /
 * wallet only, and X / LUKSO / Farcaster / recovery phrase are login-only.
 */

const mailInstance: AuthFlowConfig = { emailEnabled: true, legacy: false, passkeysSupported: true };
const noMailInstance: AuthFlowConfig = { emailEnabled: false, legacy: false, passkeysSupported: true };
const legacyInstance: AuthFlowConfig = { emailEnabled: true, legacy: true, passkeysSupported: true };

const details = { displayName: 'alice', email: 'alice@example.org' };

function run(config: AuthFlowConfig, events: AuthFlowEvent[], start: AuthFlowState = initialAuthFlowState()) {
  const reducer = authFlowReducer(config);
  return events.reduce(reducer, start);
}

describe('AuthFlow sign-up', () => {
  it('verifies the email before asking for a sign-in method', () => {
    let state = run(mailInstance, [{ type: 'SHOW_SIGNUP' }]);
    expect(state.step).toBe('signup-details');
    state = run(mailInstance, [{ type: 'DETAILS_SUBMITTED', data: details }], state);
    expect(state.step).toBe('signup-verify');
    expect(state.signup).toEqual(details);
    // no way around the code
    expect(run(mailInstance, [{ type: 'CHOOSE_METHOD', method: 'password' }], state).step).toBe('signup-verify');
    state = run(mailInstance, [{ type: 'EMAIL_VERIFIED' }], state);
    expect(state.step).toBe('signup-method');
    expect(state.signup.verifiedEmail).toBe('alice@example.org');
  });

  it('solves the captcha with the code request, or on the createUser step without one', () => {
    expect(captchaAtCreateUser(mailInstance)).toBe(false);
    expect(captchaAtCreateUser(noMailInstance)).toBe(true);
    expect(captchaAtCreateUser(legacyInstance)).toBe(true);
  });

  it('goes back from the method step to the details, which skip the used-up code for the same address', () => {
    const atMethod = run(mailInstance, [
      { type: 'SHOW_SIGNUP' },
      { type: 'DETAILS_SUBMITTED', data: details },
      { type: 'EMAIL_VERIFIED' },
    ]);
    const back = run(mailInstance, [{ type: 'BACK' }], atMethod);
    expect(back.step).toBe('signup-details');
    // same address (another name): straight back to the method choice
    const same = run(mailInstance, [{ type: 'DETAILS_SUBMITTED', data: { displayName: 'alice2', email: 'Alice@example.org' } }], back);
    expect(same.step).toBe('signup-method');
    expect(same.signup).toMatchObject({ displayName: 'alice2', verifiedEmail: 'alice@example.org' });
    // another address: a new code
    const other = run(mailInstance, [{ type: 'DETAILS_SUBMITTED', data: { displayName: 'alice', email: 'bob@example.org' } }], back);
    expect(other.step).toBe('signup-verify');
    expect(other.signup.verifiedEmail).toBeUndefined();
  });

  it('skips the code step on an instance without mail', () => {
    const state = run(noMailInstance, [{ type: 'SHOW_SIGNUP' }, { type: 'DETAILS_SUBMITTED', data: details }]);
    expect(state.step).toBe('signup-method');
    expect(run(noMailInstance, [{ type: 'BACK' }], state).step).toBe('signup-details');
  });

  it('skips the code step on a legacy CG ID instance', () => {
    const state = run(legacyInstance, [{ type: 'SHOW_SIGNUP' }, { type: 'DETAILS_SUBMITTED', data: details }]);
    expect(state.step).toBe('signup-method');
  });

  it('offers passkey first, then password and wallet — nothing else', () => {
    expect(signupMethods(mailInstance)).toEqual(['passkey', 'password', 'wallet']);
    expect(signupMethods({ ...mailInstance, passkeysSupported: false })).toEqual(['password', 'wallet']);
    // the legacy gateway has no passkey registration
    expect(signupMethods(legacyInstance)).toEqual(['password', 'wallet']);
  });

  it('goes to the password and wallet steps and back', () => {
    const atMethod = run(mailInstance, [
      { type: 'SHOW_SIGNUP' },
      { type: 'DETAILS_SUBMITTED', data: details },
      { type: 'EMAIL_VERIFIED' },
    ]);
    const atPassword = run(mailInstance, [{ type: 'CHOOSE_METHOD', method: 'password' }], atMethod);
    expect(atPassword.step).toBe('signup-password');
    expect(run(mailInstance, [{ type: 'BACK' }], atPassword).step).toBe('signup-method');
    expect(run(mailInstance, [{ type: 'CHOOSE_METHOD', method: 'wallet' }], atMethod).step).toBe('signup-wallet');
    // back from the method choice: the details (the code is used up)
    expect(run(mailInstance, [{ type: 'BACK' }], atMethod).step).toBe('signup-details');
  });

  it('sends EMAIL_VERIFICATION_REQUIRED back to the details for a new code', () => {
    const atPassword = run(mailInstance, [
      { type: 'SHOW_SIGNUP' },
      { type: 'DETAILS_SUBMITTED', data: details },
      { type: 'EMAIL_VERIFIED' },
      { type: 'CHOOSE_METHOD', method: 'password' },
    ]);
    const state = run(mailInstance, [{ type: 'SIGNUP_FAILED', code: 'EMAIL_VERIFICATION_REQUIRED' }], atPassword);
    expect(state.step).toBe('signup-details');
    expect(state.signup.verifiedEmail).toBeUndefined();
    expect(state.error).toMatch(/confirm your email/i);
  });

  it('keeps a failed createUser captcha on its step when the captcha sits there (no mail)', () => {
    const atPassword = run(noMailInstance, [{ type: 'SHOW_SIGNUP' }, { type: 'DETAILS_SUBMITTED', data: details }, { type: 'CHOOSE_METHOD', method: 'password' }]);
    const state = run(noMailInstance, [{ type: 'SIGNUP_FAILED', code: 'CAPTCHA_FAILED' }], atPassword);
    expect(state.step).toBe('signup-password');
    expect(state.error).toMatch(/captcha/i);
    expect(state.signup.displayName).toBe('alice');
  });

  it('sends a createUser captcha failure after the email code back to the details (new code + captcha)', () => {
    const atMethod = run(mailInstance, [{ type: 'SHOW_SIGNUP' }, { type: 'DETAILS_SUBMITTED', data: details }, { type: 'EMAIL_VERIFIED' }]);
    const state = run(mailInstance, [{ type: 'SIGNUP_FAILED', code: 'CAPTCHA_FAILED' }], atMethod);
    expect(state.step).toBe('signup-details');
    expect(state.signup.verifiedEmail).toBeUndefined();
  });

  it('stays on the step for other failures, with a message', () => {
    const atMethod = run(noMailInstance, [{ type: 'SHOW_SIGNUP' }, { type: 'DETAILS_SUBMITTED', data: details }]);
    const state = run(noMailInstance, [{ type: 'SIGNUP_FAILED', code: 'RATE_LIMIT_EXCEEDED', retryAfterSeconds: 240 }], atMethod);
    expect(state.step).toBe('signup-method');
    // the account limit says when, and what else works
    expect(state.error).toContain('in 4 minutes');
    expect(state.error).toContain('another network');
    expect(state.error).toContain('Log in instead');
    // the next transition clears it
    expect(run(noMailInstance, [{ type: 'CHOOSE_METHOD', method: 'wallet' }], state).error).toBeUndefined();
  });

  it('ends in done/signup when the account was created', () => {
    const state = run(noMailInstance, [{ type: 'SHOW_SIGNUP' }, { type: 'DETAILS_SUBMITTED', data: details }, { type: 'ACCOUNT_CREATED' }]);
    expect(state).toMatchObject({ step: 'done', outcome: 'signup' });
  });
});

describe('AuthFlow login', () => {
  it('starts on the one login form', () => {
    expect(initialAuthFlowState().step).toBe('login');
    expect(initialAuthFlowState('signup').step).toBe('signup-details');
  });

  it('offers the email code only when the instance sends mail', () => {
    expect(run(mailInstance, [{ type: 'USE_EMAIL_CODE' }]).step).toBe('login-code');
    expect(run(noMailInstance, [{ type: 'USE_EMAIL_CODE' }]).step).toBe('login');
  });

  it('keeps X / LUKSO / Farcaster as login-only "More" methods; the recovery phrase only on the legacy gateway', () => {
    expect(moreLoginMethods(mailInstance)).toEqual(['lukso', 'farcaster']);
    expect(moreLoginMethods(legacyInstance)).toEqual(['lukso', 'farcaster', 'recovery-phrase']);
    expect(run(mailInstance, [{ type: 'USE_MORE', method: 'recovery-phrase' }]).step).toBe('login');
    expect(run(legacyInstance, [{ type: 'USE_MORE', method: 'recovery-phrase' }]).step).toBe('login-recovery-phrase');
    expect(run(mailInstance, [{ type: 'USE_MORE', method: 'lukso' }]).step).toBe('login-lukso');
    expect(run(mailInstance, [{ type: 'USE_MORE', method: 'farcaster' }, { type: 'BACK' }]).step).toBe('login');
  });

  it('stops at the one-time passkey offer after a password login', () => {
    const offered = run(mailInstance, [{ type: 'LOGGED_IN', offerPasskey: true }]);
    expect(offered.step).toBe('offer-passkey');
    expect(run(mailInstance, [{ type: 'PASSKEY_OFFER_DONE' }], offered)).toMatchObject({ step: 'done', outcome: 'login' });
    expect(run(mailInstance, [{ type: 'LOGGED_IN', offerPasskey: false }])).toMatchObject({ step: 'done', outcome: 'login' });
  });

  it('shows errors without leaving the step', () => {
    const state = run(mailInstance, [{ type: 'ERROR', message: 'nope' }]);
    expect(state).toMatchObject({ step: 'login', error: 'nope' });
  });
});

describe('AuthFlow on a gateway (sign-in only)', () => {
  const gatewayInstance: AuthFlowConfig = { ...legacyInstance, signup: false };

  it('never leaves the login for a sign-up', () => {
    const state = run(gatewayInstance, [{ type: 'SHOW_SIGNUP' }]);
    expect(state.step).toBe('login');
    expect(run(gatewayInstance, [{ type: 'USE_WALLET' }]).step).toBe('login-wallet');
  });

  it('starts at the login even when asked for the sign-up', () => {
    // the gateway page always starts with the login; a sign-up event is ignored
    expect(run(gatewayInstance, [{ type: 'SHOW_SIGNUP' }], initialAuthFlowState('login')).step).toBe('login');
  });
});
