// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { createHmac, timingSafeEqual } from 'crypto';

/**
 * Signed one-click unsubscribe tokens (RFC 8058) for notification mails.
 *
 * A token names one user and one mail preference, and is signed with a key
 * derived from the session secret (REDIS_SECRET), so the unsubscribe endpoint
 * needs no login and no database lookup to trust it. Tokens don't expire —
 * an unsubscribe link must keep working in an old mail — and only ever turn a
 * preference OFF.
 *
 * Format: `<kind>.<userId>[.<communityId>].<mac>`
 *   kind `d` = weekly digest (users.weeklyNewsletter)
 *   kind `c` = one community's article mails (user_community_state newsletter)
 *   mac      = base64url HMAC-SHA256 over everything before it
 */

export type UnsubscribeTopic =
  | { kind: 'digest' }
  | { kind: 'community'; communityId: string };

export type UnsubscribeTarget = { userId: string; topic: UnsubscribeTopic };

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
export const UNSUBSCRIBE_TOKEN_REGEX = new RegExp(`^(?:d\\.${UUID}|c\\.${UUID}\\.${UUID})\\.[A-Za-z0-9_-]{43}$`);

// key separation: the session secret signs cookies, this derived key signs
// unsubscribe tokens
const KEY_LABEL = 'cg-email-unsubscribe-v1';

export function deriveUnsubscribeKey(sessionSecret: string): Buffer {
  return createHmac('sha256', sessionSecret).update(KEY_LABEL).digest();
}

function mac(key: Buffer, payload: string): string {
  return createHmac('sha256', key).update(payload).digest('base64url');
}

export function createUnsubscribeToken(key: Buffer, target: UnsubscribeTarget): string {
  const userId = target.userId.toLowerCase();
  const payload = target.topic.kind === 'digest'
    ? `d.${userId}`
    : `c.${userId}.${target.topic.communityId.toLowerCase()}`;
  return `${payload}.${mac(key, payload)}`;
}

/** The target of a valid token, or null for anything malformed or forged. */
export function verifyUnsubscribeToken(key: Buffer, token: string): UnsubscribeTarget | null {
  if (!UNSUBSCRIBE_TOKEN_REGEX.test(token)) {
    return null;
  }
  const lastDot = token.lastIndexOf('.');
  const payload = token.slice(0, lastDot);
  const given = Buffer.from(token.slice(lastDot + 1));
  const expected = Buffer.from(mac(key, payload));
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return null;
  }
  const parts = payload.split('.');
  if (parts[0] === 'd') {
    return { userId: parts[1], topic: { kind: 'digest' } };
  }
  return { userId: parts[1], topic: { kind: 'community', communityId: parts[2] } };
}
