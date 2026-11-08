// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from "common/errors";
import { retryAfterSecondsOf } from "data/api/apiError";

export const LAST_LOGIN_METHOD_MESSAGE =
  "This is your last way to sign in. Add another sign-in method (a passkey, a password or a wallet) first.";

/**
 * Message for a failed account-security action, or null when there is
 * nothing to show: REAUTH_REQUIRED reaching a caller means the user cancelled
 * the "Confirm it's you" dialog.
 */
function sameDay(a: Date, b: Date) {
  return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
}

function clockTime(date: Date) {
  return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
}

/**
 * When a wait ends, in words: "in 45 seconds", "in 4 minutes", "at 14:05",
 * "tomorrow at 09:30", "on Mon, 3 Nov at 09:30" — in the browser's locale
 * for the clock time (the app has no translations; the words are English).
 */
export function formatRetryAfter(seconds: number, now: Date = new Date()): string {
  const s = Math.max(1, Math.ceil(seconds));
  if (s < 60) {
    return `in ${s} second${s === 1 ? '' : 's'}`;
  }
  const minutes = Math.ceil(s / 60);
  if (minutes < 60) {
    return `in ${minutes} minute${minutes === 1 ? '' : 's'}`;
  }
  const at = new Date(now.getTime() + s * 1000);
  // a minute later than the exact end, so "at 14:05" never comes too early
  at.setSeconds(0, 0);
  at.setMinutes(at.getMinutes() + 1);
  if (sameDay(at, now)) {
    return `at ${clockTime(at)}`;
  }
  const tomorrow = new Date(now);
  tomorrow.setDate(now.getDate() + 1);
  if (sameDay(at, tomorrow)) {
    return `tomorrow at ${clockTime(at)}`;
  }
  return `on ${at.toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' })} at ${clockTime(at)}`;
}

/**
 * The message for a refused request (RATE_LIMIT_EXCEEDED): what happened,
 * when it works again (from the server's `retryAfterSeconds`), and — if the
 * caller knows one — what the person can do instead right now.
 */
export function rateLimitMessage(
  e: unknown,
  options: { what?: string; alternative?: string; now?: Date } = {},
): string {
  const { what = "Too many attempts.", alternative, now } = options;
  const seconds = retryAfterSecondsOf(e);
  const when = seconds !== undefined
    ? `You can try again ${formatRetryAfter(seconds, now)}.`
    : "Please try again in a few minutes.";
  return [what, when, alternative].filter(Boolean).join(' ');
}

export function isRateLimited(e: unknown): boolean {
  const code = e instanceof Error ? e.message : typeof e === "string" ? e : undefined;
  return code === errors.server.RATE_LIMIT_EXCEEDED;
}

export function securityActionErrorMessage(e: unknown, fallback: string): string | null {
  const code = e instanceof Error ? e.message : typeof e === "string" ? e : undefined;
  switch (code) {
    case errors.server.REAUTH_REQUIRED:
      return null;
    case errors.server.LAST_LOGIN_METHOD:
      return LAST_LOGIN_METHOD_MESSAGE;
    case errors.server.RATE_LIMIT_EXCEEDED:
      return rateLimitMessage(e);
    default:
      return fallback;
  }
}

const SERVER_CODES: ReadonlySet<string> = new Set(Object.values(errors.server));

/**
 * Like securityActionErrorMessage, but keeps a message that is already meant
 * for people (an Error thrown by UI code); raw server codes never reach the
 * screen.
 */
export function userFacingErrorMessage(e: unknown, fallback: string): string | null {
  const message = e instanceof Error ? e.message : typeof e === "string" ? e : "";
  if (message && !SERVER_CODES.has(message)) {
    return message;
  }
  return securityActionErrorMessage(e, fallback);
}
