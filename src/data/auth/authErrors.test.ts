// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import { ApiRequestError, limitKindOf, retryAfterSecondsOf } from 'data/api/apiError';
import { formatRetryAfter, isRateLimited, rateLimitMessage, securityActionErrorMessage } from './authErrors';
import { identifierProblem } from './loginInput';

// a fixed local time: 13:00 on a Tuesday
const NOW = new Date(2026, 10, 3, 13, 0, 10);
const clock = (date: Date) => date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });

describe('formatRetryAfter', () => {
  it('seconds and minutes in words', () => {
    expect(formatRetryAfter(1, NOW)).toBe('in 1 second');
    expect(formatRetryAfter(45, NOW)).toBe('in 45 seconds');
    expect(formatRetryAfter(60, NOW)).toBe('in 1 minute');
    expect(formatRetryAfter(61, NOW)).toBe('in 2 minutes');
    expect(formatRetryAfter(59 * 60, NOW)).toBe('in 59 minutes');
  });

  it('an hour and more: the clock time, never too early', () => {
    // 13:00:10 + 2 h = 15:00:10 → "at 15:01"
    expect(formatRetryAfter(2 * 3600, NOW)).toBe(`at ${clock(new Date(2026, 10, 3, 15, 1))}`);
  });

  it('tomorrow, and later than that', () => {
    expect(formatRetryAfter(20 * 3600, NOW)).toBe(`tomorrow at ${clock(new Date(2026, 10, 4, 9, 1))}`);
    expect(formatRetryAfter(48 * 3600, NOW)).toMatch(/^on .+ at /);
  });
});

describe('rate-limit messages', () => {
  const limited = (seconds?: number) => new ApiRequestError('RATE_LIMIT_EXCEEDED', seconds);

  it('carries the wait from the server', () => {
    expect(retryAfterSecondsOf(limited(30))).toBe(30);
    expect(retryAfterSecondsOf(limited())).toBeUndefined();
    expect(retryAfterSecondsOf(new Error('RATE_LIMIT_EXCEEDED'))).toBeUndefined();
    expect(isRateLimited(limited(30))).toBe(true);
    expect(isRateLimited(new ApiRequestError('NOT_ALLOWED'))).toBe(false);
  });

  it('carries what kind of limit refused', () => {
    expect(limitKindOf(new ApiRequestError('RATE_LIMIT_EXCEEDED', 30, 'accounts'))).toBe('accounts');
    expect(limitKindOf(new ApiRequestError('RATE_LIMIT_EXCEEDED', 30, 'nonsense' as never))).toBeUndefined();
    expect(limitKindOf(new Error('RATE_LIMIT_EXCEEDED'))).toBeUndefined();
  });

  it('what happened, when it works again, what else to do', () => {
    expect(rateLimitMessage(limited(240), { what: 'Too many sign-in attempts.', alternative: 'Use a passkey.', now: NOW }))
      .toBe('Too many sign-in attempts. You can try again in 4 minutes. Use a passkey.');
    expect(rateLimitMessage(limited(), { now: NOW })).toBe('Too many attempts. Please try again in a few minutes.');
  });

  it('the account-security actions use it, too', () => {
    expect(securityActionErrorMessage(limited(30), 'fallback')).toBe('Too many attempts. You can try again in 30 seconds.');
  });
});

describe('login identifier', () => {
  it('takes an email address or a username', () => {
    expect(identifierProblem('jan@example.org')).toBeUndefined();
    expect(identifierProblem(' jan_h-1 ')).toBeUndefined();
  });

  it('says what is wrong before anything is sent', () => {
    expect(identifierProblem('  ')).toMatch(/Enter your email address or username/);
    expect(identifierProblem('jan@example')).toMatch(/email address doesn't look right/);
    expect(identifierProblem('jan h')).toMatch(/Usernames have 3-30/);
    expect(identifierProblem('ab')).toMatch(/Usernames have 3-30/);
  });
});
