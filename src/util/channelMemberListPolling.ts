// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from 'common/errors';
import { ApiRequestError } from 'data/api/apiError';

export const MEMBER_LIST_POLL_INTERVAL_MS = 5000;

/**
 * The server answers a channel member list only to callers who may read the
 * channel; a refusal stays a refusal until the caller's roles change, so
 * asking again does not help.
 */
export function isMemberListRefusal(error: unknown): boolean {
  return error instanceof ApiRequestError && (
    error.message === errors.server.NOT_ALLOWED ||
    error.message === errors.server.LOGIN_REQUIRED
  );
}

/**
 * Loads a channel member list now and then every `intervalMs`, but only while
 * `canRead` (gated preview channels have no member list to show). Stops after
 * a refusal, and drops answers that arrive after `stop()`. Returns `stop`.
 */
export function pollChannelMemberList<T>(options: {
  canRead: boolean;
  load: () => Promise<T>;
  onResult: (result: T) => void;
  onError: (error: unknown) => void;
  intervalMs?: number;
}): () => void {
  const { canRead, load, onResult, onError, intervalMs = MEMBER_LIST_POLL_INTERVAL_MS } = options;
  if (!canRead) {
    return () => undefined;
  }
  let stopped = false;
  let timer: ReturnType<typeof setInterval> | undefined;
  const stop = () => {
    stopped = true;
    if (timer !== undefined) {
      clearInterval(timer);
      timer = undefined;
    }
  };
  const tick = () => {
    load().then(result => {
      if (!stopped) {
        onResult(result);
      }
    }, (error: unknown) => {
      if (stopped) {
        return;
      }
      onError(error);
      if (isMemberListRefusal(error)) {
        stop();
      }
    });
  };
  tick();
  timer = setInterval(tick, intervalMs);
  return stop;
}
