// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * An API call answered `{status:"ERROR"}`. The message is the server's error
 * code (as before: `e.message === errors.server.X` checks keep working);
 * RATE_LIMIT_EXCEEDED also carries how long to wait (docs/auth-identity,
 * "Limits").
 */
export type LimitKind = 'accounts' | 'mail' | 'attempts';

export class ApiRequestError extends Error {
  readonly retryAfterSeconds?: number;
  /** RATE_LIMIT_EXCEEDED: what was limited (accounts from the network, mails, attempts) */
  readonly limit?: LimitKind;

  constructor(code: string, retryAfterSeconds?: number, limit?: LimitKind) {
    super(code);
    this.name = 'ApiRequestError';
    if (typeof retryAfterSeconds === 'number' && Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0) {
      this.retryAfterSeconds = retryAfterSeconds;
    }
    if (limit === 'accounts' || limit === 'mail' || limit === 'attempts') {
      this.limit = limit;
    }
  }
}

/** what kind of limit refused a request, if the server said so */
export function limitKindOf(e: unknown): LimitKind | undefined {
  const limit = typeof e === 'object' && e !== null && 'limit' in e ? (e as { limit?: unknown }).limit : undefined;
  return limit === 'accounts' || limit === 'mail' || limit === 'attempts' ? limit : undefined;
}

/** seconds to wait that came with a refused request, if any */
export function retryAfterSecondsOf(e: unknown): number | undefined {
  if (typeof e === 'object' && e !== null && 'retryAfterSeconds' in e) {
    const value = (e as { retryAfterSeconds?: unknown }).retryAfterSeconds;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
  }
  return undefined;
}
