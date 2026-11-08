// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
  createUnsubscribeToken,
  deriveUnsubscribeKey,
  UNSUBSCRIBE_TOKEN_REGEX,
  verifyUnsubscribeToken,
} from '../util/unsubscribeToken';

const key = deriveUnsubscribeKey('session-secret');
const userId = '6f1c2a3b-4d5e-4f60-8a7b-9c0d1e2f3a4b';
const communityId = '0a1b2c3d-4e5f-4a6b-8c7d-8e9f0a1b2c3d';

describe('unsubscribe tokens', () => {
  it('round-trips both topics', () => {
    const digest = createUnsubscribeToken(key, { userId, topic: { kind: 'digest' } });
    const community = createUnsubscribeToken(key, { userId, topic: { kind: 'community', communityId } });
    expect(digest).toMatch(UNSUBSCRIBE_TOKEN_REGEX);
    expect(community).toMatch(UNSUBSCRIBE_TOKEN_REGEX);
    expect(verifyUnsubscribeToken(key, digest)).toEqual({ userId, topic: { kind: 'digest' } });
    expect(verifyUnsubscribeToken(key, community)).toEqual({ userId, topic: { kind: 'community', communityId } });
  });

  it('is URL-safe', () => {
    const token = createUnsubscribeToken(key, { userId, topic: { kind: 'community', communityId } });
    expect(encodeURIComponent(token)).toBe(token);
  });

  it('rejects tokens signed with another key', () => {
    const token = createUnsubscribeToken(deriveUnsubscribeKey('other-secret'), { userId, topic: { kind: 'digest' } });
    expect(verifyUnsubscribeToken(key, token)).toBeNull();
  });

  it('rejects tampered tokens', () => {
    const token = createUnsubscribeToken(key, { userId, topic: { kind: 'community', communityId } });
    const otherUser = token.replace(userId, '00000000-0000-4000-8000-000000000000');
    const asDigest = `d.${userId}.${token.split('.').pop()}`;
    for (const forged of [otherUser, asDigest, token.slice(0, -1) + (token.endsWith('A') ? 'B' : 'A'), '', 'd.x.y']) {
      expect(verifyUnsubscribeToken(key, forged)).toBeNull();
    }
  });

  it('does not use the session secret itself as the key', () => {
    expect(deriveUnsubscribeKey('session-secret').toString('utf8')).not.toBe('session-secret');
  });
});
