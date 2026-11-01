// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
  SIGNUP_CODE_MAX_ATTEMPTS,
  SIGNUP_CODE_TTL_MS,
  SIGNUP_VERIFIED_TTL_MS,
  checkSignupEmailCode,
  generateSignupCode,
  getVerifiedSignupEmail,
  hasSignupCaptcha,
  SIGNUP_CAPTCHA_TTL_MS,
  startSignupEmailVerification,
  startSignupWithoutCode,
  verifiedSignupPassedCaptcha,
} from '../util/signupEmail';

const NOW = Date.parse('2026-10-31T12:00:00Z');

function wrongCode(code: string) {
  return code === '00000000' ? '00000001' : '00000000';
}

describe('sign-up email verification', () => {
  it('codes are eight digits, leading zeros included', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSignupCode()).toMatch(/^[0-9]{8}$/);
    }
  });

  it('verifies the address the code was sent to, and nothing else', () => {
    const session: any = {};
    const code = startSignupEmailVerification(session, 'Alice@Example.org', NOW);
    expect(getVerifiedSignupEmail(session, NOW)).toBeNull();
    expect(() => checkSignupEmailCode(session, 'mallory@example.org', code, NOW)).toThrow('VERIFY_EMAIL_INVALID_TOKEN');
    checkSignupEmailCode(session, 'alice@example.org', code, NOW);
    expect(getVerifiedSignupEmail(session, NOW)).toBe('Alice@Example.org');
    // the code is single-use
    expect(() => checkSignupEmailCode(session, 'alice@example.org', code, NOW)).toThrow('VERIFY_EMAIL_INVALID_TOKEN');
    // and the verified state expires
    expect(getVerifiedSignupEmail(session, NOW + SIGNUP_VERIFIED_TTL_MS + 1)).toBeNull();
  });

  it('codes expire', () => {
    const session: any = {};
    const code = startSignupEmailVerification(session, 'a@example.org', NOW);
    expect(() => checkSignupEmailCode(session, 'a@example.org', code, NOW + SIGNUP_CODE_TTL_MS + 1)).toThrow('VERIFY_EMAIL_EXPIRED_TOKEN');
    // the code is gone, the address stays (a new code needs no new captcha)
    expect(session.signupEmail.codeHash).toBeUndefined();
    expect(session.signupEmail.email).toBe('a@example.org');
    expect(() => checkSignupEmailCode(session, 'a@example.org', code, NOW + SIGNUP_CODE_TTL_MS + 2)).toThrow('VERIFY_EMAIL_EXPIRED_TOKEN');
  });

  it('a taken address (no code) answers like a real one, also once expired', () => {
    const session: any = {};
    startSignupWithoutCode(session, 'a@example.org', NOW, NOW);
    expect(() => checkSignupEmailCode(session, 'a@example.org', '12345678', NOW)).toThrow('VERIFY_EMAIL_INVALID_TOKEN');
    expect(() => checkSignupEmailCode(session, 'a@example.org', '12345678', NOW + SIGNUP_CODE_TTL_MS + 1)).toThrow('VERIFY_EMAIL_EXPIRED_TOKEN');
    expect(hasSignupCaptcha(session, 'a@example.org', NOW + SIGNUP_CODE_TTL_MS + 1)).toBe(true);
  });

  it(`gives up after ${SIGNUP_CODE_MAX_ATTEMPTS} wrong guesses`, () => {
    const session: any = {};
    const code = startSignupEmailVerification(session, 'a@example.org', NOW);
    for (let i = 0; i < SIGNUP_CODE_MAX_ATTEMPTS; i++) {
      expect(() => checkSignupEmailCode(session, 'a@example.org', wrongCode(code), NOW)).toThrow('VERIFY_EMAIL_INVALID_TOKEN');
    }
    expect(() => checkSignupEmailCode(session, 'a@example.org', code, NOW)).toThrow('VERIFY_EMAIL_INVALID_TOKEN');
  });

  it('a spent code keeps the solved captcha for a new code to the same address', () => {
    const session: any = {};
    const code = startSignupEmailVerification(session, 'a@example.org', NOW, NOW);
    for (let i = 0; i < SIGNUP_CODE_MAX_ATTEMPTS; i++) {
      expect(() => checkSignupEmailCode(session, 'a@example.org', wrongCode(code), NOW)).toThrow('VERIFY_EMAIL_INVALID_TOKEN');
    }
    expect(hasSignupCaptcha(session, 'a@example.org', NOW + 1)).toBe(true);
    expect(hasSignupCaptcha(session, 'b@example.org', NOW + 1)).toBe(false);
  });

  it('a new request replaces the previous verification', () => {
    const session: any = {};
    const first = startSignupEmailVerification(session, 'a@example.org', NOW);
    checkSignupEmailCode(session, 'a@example.org', first, NOW);
    startSignupEmailVerification(session, 'b@example.org', NOW);
    expect(getVerifiedSignupEmail(session, NOW)).toBeNull();
  });

  it('carries the solved captcha through verification, bound to the address and its window', () => {
    const session: any = {};
    const code = startSignupEmailVerification(session, 'a@example.org', NOW, NOW);
    expect(hasSignupCaptcha(session, 'A@example.org', NOW)).toBe(true);
    expect(hasSignupCaptcha(session, 'b@example.org', NOW)).toBe(false);
    expect(verifiedSignupPassedCaptcha(session, NOW)).toBe(false);
    checkSignupEmailCode(session, 'a@example.org', code, NOW);
    expect(verifiedSignupPassedCaptcha(session, NOW)).toBe(true);
    expect(verifiedSignupPassedCaptcha(session, NOW + SIGNUP_CAPTCHA_TTL_MS + 1)).toBe(false);
  });

  it('a verified address without a captcha does not skip createUser\'s captcha', () => {
    const session: any = {};
    const code = startSignupEmailVerification(session, 'a@example.org', NOW);
    checkSignupEmailCode(session, 'a@example.org', code, NOW);
    expect(getVerifiedSignupEmail(session, NOW)).toBe('a@example.org');
    expect(verifiedSignupPassedCaptcha(session, NOW)).toBe(false);
  });
});
