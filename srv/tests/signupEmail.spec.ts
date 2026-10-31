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
  verifiedSignupPassedCaptcha,
} from '../util/signupEmail';

const NOW = Date.parse('2026-10-31T12:00:00Z');

function wrongCode(code: string) {
  return code === '000000' ? '000001' : '000000';
}

describe('sign-up email verification', () => {
  it('codes are six digits', () => {
    for (let i = 0; i < 50; i++) {
      expect(generateSignupCode()).toMatch(/^[0-9]{6}$/);
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
    expect(session.signupEmail).toBeUndefined();
  });

  it(`gives up after ${SIGNUP_CODE_MAX_ATTEMPTS} wrong guesses`, () => {
    const session: any = {};
    const code = startSignupEmailVerification(session, 'a@example.org', NOW);
    for (let i = 0; i < SIGNUP_CODE_MAX_ATTEMPTS; i++) {
      expect(() => checkSignupEmailCode(session, 'a@example.org', wrongCode(code), NOW)).toThrow('VERIFY_EMAIL_INVALID_TOKEN');
    }
    expect(() => checkSignupEmailCode(session, 'a@example.org', code, NOW)).toThrow('VERIFY_EMAIL_INVALID_TOKEN');
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
