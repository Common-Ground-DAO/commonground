// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { describe, expect, it } from 'vitest';
import errors from 'common/errors';
import { ApiRequestError } from 'data/api/apiError';
import { memberListRefusalPrompt } from './memberListRefusalPrompt';

const NOW = Date.parse('2026-11-03T12:00:00Z');
const notAllowed = new ApiRequestError(errors.server.NOT_ALLOWED);
const loginRequired = new ApiRequestError(errors.server.LOGIN_REQUIRED);

describe('memberListRefusalPrompt', () => {
  it('asks a signed-in non-member and a visitor to join', () => {
    expect(memberListRefusalPrompt({ error: notAllowed, isLoggedIn: true, community: {}, now: NOW })).toBe('join');
    expect(memberListRefusalPrompt({ error: loginRequired, isLoggedIn: false, community: {}, now: NOW })).toBe('join');
  });

  it('tells a pending applicant that the request waits', () => {
    expect(memberListRefusalPrompt({ error: notAllowed, isLoggedIn: true, community: { myApplicationStatus: 'PENDING' }, now: NOW })).toBe('pending');
  });

  it('does not offer joining while banned', () => {
    const forever = { state: 'BANNED', until: null };
    const later = { state: 'BANNED', until: '2026-11-04T00:00:00Z' };
    const over = { state: 'BANNED', until: '2026-11-02T00:00:00Z' };
    expect(memberListRefusalPrompt({ error: notAllowed, isLoggedIn: true, community: { blockState: forever }, now: NOW })).toBe('banned');
    expect(memberListRefusalPrompt({ error: notAllowed, isLoggedIn: true, community: { blockState: later }, now: NOW })).toBe('banned');
    expect(memberListRefusalPrompt({ error: notAllowed, isLoggedIn: true, community: { blockState: over }, now: NOW })).toBe('join');
  });

  it('asks a signed-in user whose session was not accepted to log in again', () => {
    expect(memberListRefusalPrompt({ error: loginRequired, isLoggedIn: true, community: {}, now: NOW })).toBe('login');
  });
});
