// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { useCallback, useEffect, useState } from 'react';
import { EMAIL_CODE_RESEND_SECONDS } from 'common/authInputRules';
import { formatRetryAfter } from 'data/auth/authErrors';

/** cooldowns that outlive the component (a step left and opened again), by key */
const untilByKey = new Map<string, number>();

/** starts the countdown of `key` from outside a component (e.g. the step that sent the code) */
export function startCooldownFor(key: string, seconds = EMAIL_CODE_RESEND_SECONDS) {
  untilByKey.set(key, Date.now() + seconds * 1000);
}

/** seconds left of the countdown of `key` (0 = none) */
export function cooldownLeftFor(key: string): number {
  return Math.max(0, Math.ceil(((untilByKey.get(key) ?? 0) - Date.now()) / 1000));
}

/**
 * A countdown in seconds for "send again" buttons: `left` is what remains
 * (0 = the button may be used), `start(seconds?)` restarts it — after a
 * successful send with the server's per-address cooldown, after a refusal
 * with the server's `retryAfterSeconds`. With a `key` (e.g. the address) the
 * countdown survives the component being unmounted and mounted again.
 */
export function useCooldown(defaultSeconds = EMAIL_CODE_RESEND_SECONDS, key?: string) {
  const [until, setUntil] = useState(() => (key ? untilByKey.get(key) ?? 0 : 0));
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    setUntil(key ? untilByKey.get(key) ?? 0 : 0);
    setNow(Date.now());
  }, [key]);

  useEffect(() => {
    if (until <= now) {
      return;
    }
    const timer = setTimeout(() => setNow(Date.now()), Math.min(1000, until - now));
    return () => clearTimeout(timer);
  }, [until, now]);

  const start = useCallback((seconds = defaultSeconds) => {
    const next = Date.now() + seconds * 1000;
    if (key) {
      untilByKey.set(key, next);
    }
    setUntil(next);
    setNow(Date.now());
  }, [defaultSeconds, key]);

  return { left: Math.max(0, Math.ceil((until - now) / 1000)), start };
}

/** "Send again (42 s)", "Send again (in 12 minutes)", or just the text */
export function cooldownLabel(text: string, left: number): string {
  if (left <= 0) {
    return text;
  }
  return left <= 120 ? `${text} (${left} s)` : `${text} (${formatRetryAfter(left)})`;
}
