// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from '../common/errors';

/**
 * What kind of limit refused a request, so the client can word its message:
 * too many accounts from the network, too many mails (to an address or from
 * the network), or too many attempts. It depends only on which IP- or
 * address-keyed limiter refused, never on whether an account exists.
 */
export type LimitKind = 'accounts' | 'mail' | 'attempts';

/**
 * RATE_LIMIT_EXCEEDED together with how long the caller has to wait before
 * the limit lets the next attempt through, and which kind of limit it was.
 * The message stays the plain error code, so every
 * `e.message === RATE_LIMIT_EXCEEDED` check keeps working; handleError
 * (srv/api/util.ts) adds `retryAfterSeconds` and `limit` to the error
 * envelope and a `Retry-After` header (docs/auth-identity §4, "Limits").
 */
export class RateLimitError extends Error {
  readonly retryAfterSeconds: number;
  readonly limit: LimitKind;

  constructor(retryAfterSeconds: number, limit: LimitKind = 'attempts') {
    super(errors.server.RATE_LIMIT_EXCEEDED);
    this.name = 'RateLimitError';
    this.retryAfterSeconds = Math.max(1, Math.ceil(retryAfterSeconds));
    this.limit = limit;
  }
}

/** the longest wait of several limits that refused a request */
export function longestWait(waits: (number | null)[]): number | null {
  const refused = waits.filter((wait): wait is number => wait !== null);
  return refused.length > 0 ? Math.max(...refused) : null;
}
