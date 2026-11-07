// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import redisManager from '../redis';
import { enforceLimits, keyRateLimitHandler } from './rateLimit';
import { withTimeout } from '../redis/client';

// Budget of the mails an event change or cancellation sends to its
// participants (Community/updateCommunityEvent, deleteCommunityEvent; docs/
// email-notifications, "Send limits"). Unlike the mails to an address the
// caller chooses, these go to every participant with a verified address on
// each change, so they are capped by what triggers them:
//   - per event: a few change mails per hour, however often it is edited;
//   - per acting account: across all events it changes or cancels;
//   - per instance: the participant mails of all events together, counted in
//     mails, so event mails cannot use up the outbound budget of the relay
//     that sign-in codes and verification mails rely on.
// Over budget, the change itself still goes through; it just mails no one.

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;

export const EVENT_MAIL_LIMITS = {
  /** change/cancellation mail rounds per event */
  perEvent: { windowMs: HOUR, limit: 3 },
  /** change/cancellation mail rounds per acting account (all events) */
  perActor: { windowMs: HOUR, limit: 10 },
  /** participant mails per instance (all events), counted per recipient */
  perInstance: { windowMs: HOUR, limit: 10_000 },
};

// made on first use: loading the module sets up nothing
let roundLimiters: { perEvent: ReturnType<typeof keyRateLimitHandler>; perActor: ReturnType<typeof keyRateLimitHandler> } | undefined;
function limiters() {
  return roundLimiters ??= {
    perEvent: keyRateLimitHandler({ bucket: 'mail:event:round:event', kind: 'mail', ...EVENT_MAIL_LIMITS.perEvent }),
    perActor: keyRateLimitHandler({ bucket: 'mail:event:round:actor', kind: 'mail', ...EVENT_MAIL_LIMITS.perActor }),
  };
}

/** the instance counter of the current window (fixed windows: one key per hour) */
function instanceKey(now: number): string {
  return `ratelimit:mail:event:instance:${Math.floor(now / EVENT_MAIL_LIMITS.perInstance.windowMs)}`;
}

/**
 * Whether a round of `recipients` participant mails about `eventId`, caused
 * by `actorId`, may be sent now; counts it when it may. False when any of
 * the three budgets is used up (nothing is counted then). An unreachable
 * Valkey sends no mails either.
 */
export async function reserveEventMailRound(options: { eventId: string; actorId: string; recipients: number }, now = Date.now()): Promise<boolean> {
  const { eventId, actorId, recipients } = options;
  if (recipients <= 0) {
    return true;
  }
  const client = redisManager.getClient('data');
  const key = instanceKey(now);
  try {
    // count and TTL in one MULTI: the window's key outlives the window a
    // little, then goes; it never stays without a TTL
    const [sent] = await withTimeout(client
      .multi()
      .incrBy(key, recipients)
      .expire(key, Math.ceil((2 * EVENT_MAIL_LIMITS.perInstance.windowMs) / 1000))
      .execTyped(), 'event-mail MULTI');
    if (sent > EVENT_MAIL_LIMITS.perInstance.limit) {
      await client.decrBy(key, recipients);
      console.warn(`Event participant mails skipped: the instance's hourly budget (${EVENT_MAIL_LIMITS.perInstance.limit}) is used up`);
      return false;
    }
    try {
      const { perEvent, perActor } = limiters();
      await enforceLimits([...perEvent.buckets(eventId), ...perActor.buckets(actorId)]);
    }
    catch (e) {
      await client.decrBy(key, recipients);
      throw e;
    }
    return true;
  }
  catch (e) {
    console.warn("Event participant mails skipped (budget used up or not checkable)", e instanceof Error ? e.message : e);
    return false;
  }
}
