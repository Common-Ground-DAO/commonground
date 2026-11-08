// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The auth limits (srv/util/authLimits.ts): the defaults decision 21 asks for,
 * the test hook that may only lower them, and the wait arithmetic of
 * srv/util/rateLimitError.ts.
 */

import { AUTH_LIMIT_DEFAULTS, applyLimitOverrides } from '../util/authLimits';
import { longestWait, RateLimitError } from '../util/rateLimitError';

describe('auth limits', () => {
  it('account creation: about 20 per hour and 50 per day per network', () => {
    expect(AUTH_LIMIT_DEFAULTS.createUser.hour).toMatchObject({ windowMs: 3_600_000, limit_v4_v6_64: 20 });
    expect(AUTH_LIMIT_DEFAULTS.createUser.day).toMatchObject({ windowMs: 86_400_000, limit_v4_v6_64: 50 });
  });

  it('the sign-up code mails per network allow at least the accounts per hour, with a resend each', () => {
    expect(AUTH_LIMIT_DEFAULTS.signupCodeMail.ip.limit_v4_v6_64).toBeGreaterThanOrEqual(2 * AUTH_LIMIT_DEFAULTS.createUser.hour.limit_v4_v6_64);
    // options + verification per passkey sign-up, one retry each
    expect(AUTH_LIMIT_DEFAULTS.passkey.signupRegistration.limit_v4_v6_64).toBeGreaterThanOrEqual(2 * AUTH_LIMIT_DEFAULTS.createUser.hour.limit_v4_v6_64);
  });

  it('the guessing budgets stay per identifier', () => {
    expect(AUTH_LIMIT_DEFAULTS.passwordLogin.identifierFailuresPerNetwork.limit).toBeLessThanOrEqual(10);
    expect(AUTH_LIMIT_DEFAULTS.codeLogin.identifierFailuresPerNetwork).toEqual({ windowMs: 3_600_000, limit: 10 });
    expect(AUTH_LIMIT_DEFAULTS.codeLogin.identifierFailures).toEqual({ windowMs: 3_600_000, limit: 30 });
  });

  describe('test overrides (CG_TEST_AUTH_LIMITS)', () => {
    let warn: jest.SpyInstance;
    beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined); });
    afterEach(() => warn.mockRestore());

    it('nothing set: the defaults themselves', () => {
      expect(applyLimitOverrides(AUTH_LIMIT_DEFAULTS, undefined)).toBe(AUTH_LIMIT_DEFAULTS);
      expect(applyLimitOverrides(AUTH_LIMIT_DEFAULTS, ' ')).toBe(AUTH_LIMIT_DEFAULTS);
    });

    it('lowers single limits, never raises one, and leaves the defaults alone', () => {
      const limits = applyLimitOverrides(AUTH_LIMIT_DEFAULTS, JSON.stringify({
        'createUser.hour': 1,
        'passwordLogin.identifierFailuresPerNetwork': 2,
        'codeLogin.identifierFailures': 100_000,
      }));
      // the wider IPv6 prefixes scale with it
      expect(limits.createUser.hour).toMatchObject({ limit_v4_v6_64: 1, limit_v6_56: 3, limit_v6_48: 6 });
      expect(limits.createUser.day).toEqual(AUTH_LIMIT_DEFAULTS.createUser.day);
      expect(limits.passwordLogin.identifierFailuresPerNetwork.limit).toBe(2);
      expect(limits.codeLogin.identifierFailures.limit).toBe(AUTH_LIMIT_DEFAULTS.codeLogin.identifierFailures.limit);
      expect(AUTH_LIMIT_DEFAULTS.createUser.hour.limit_v4_v6_64).toBe(20);
      expect(warn).toHaveBeenCalledWith(expect.stringContaining('createUser.hour'));
    });

    it('refuses unknown names and odd values', () => {
      expect(() => applyLimitOverrides(AUTH_LIMIT_DEFAULTS, '{"createUser.week": 1}')).toThrow('not a known limit');
      expect(() => applyLimitOverrides(AUTH_LIMIT_DEFAULTS, '{"createUser.hour": 0}')).toThrow('not a known limit');
      expect(() => applyLimitOverrides(AUTH_LIMIT_DEFAULTS, '{"createUser.hour": "1"}')).toThrow('not a known limit');
      expect(() => applyLimitOverrides(AUTH_LIMIT_DEFAULTS, 'nonsense')).toThrow();
    });
  });

  // the wait arithmetic against the (in-memory) Valkey: failureBudget.spec.ts
  describe('the limit error', () => {
    it('several limits: the longest wait counts', () => {
      expect(longestWait([null, 30, 12])).toBe(30);
      expect(longestWait([null, null])).toBeNull();
    });

    it('the error keeps the plain code as its message, with whole seconds', () => {
      const error = new RateLimitError(0.2);
      expect(error.message).toBe('RATE_LIMIT_EXCEEDED');
      expect(error.retryAfterSeconds).toBe(1);
      expect(new RateLimitError(61.5).retryAfterSeconds).toBe(62);
      expect(error.limit).toBe('attempts');
      expect(new RateLimitError(5, 'accounts').limit).toBe('accounts');
    });
  });
});
