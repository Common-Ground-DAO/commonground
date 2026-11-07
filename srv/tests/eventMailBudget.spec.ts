// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * The budget of the participant mails an event change or cancellation sends
 * (srv/util/eventMailBudget.ts): per event, per acting account and per
 * instance (in mails); over budget nothing is counted and nothing is sent.
 */

jest.doMock('../redis', () => require('./helpers/memoryRedis'));

import * as memoryRedis from './helpers/memoryRedis';
import { EVENT_MAIL_LIMITS, reserveEventMailRound } from '../util/eventMailBudget';

const EVENT = 'event-1';
const ACTOR = 'actor-1';

let warn: jest.SpyInstance;
beforeEach(() => {
  memoryRedis.keys.clear();
  memoryRedis.sortedSets.clear();
  warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
});
afterEach(() => warn.mockRestore());

describe('event participant mails', () => {
  it('a few rounds per event, then none; another event of the same actor still mails', async () => {
    for (let i = 0; i < EVENT_MAIL_LIMITS.perEvent.limit; i++) {
      await expect(reserveEventMailRound({ eventId: EVENT, actorId: ACTOR, recipients: 5 })).resolves.toBe(true);
    }
    await expect(reserveEventMailRound({ eventId: EVENT, actorId: ACTOR, recipients: 5 })).resolves.toBe(false);
    await expect(reserveEventMailRound({ eventId: 'event-2', actorId: ACTOR, recipients: 5 })).resolves.toBe(true);
  });

  it('caps an actor across events', async () => {
    let sent = 0;
    for (let i = 0; i < EVENT_MAIL_LIMITS.perActor.limit + 5; i++) {
      if (await reserveEventMailRound({ eventId: `event-${i}`, actorId: ACTOR, recipients: 1 })) sent++;
    }
    expect(sent).toBe(EVENT_MAIL_LIMITS.perActor.limit);
    await expect(reserveEventMailRound({ eventId: 'event-x', actorId: 'actor-2', recipients: 1 })).resolves.toBe(true);
  });

  it('caps the mails of the whole instance; a refused round counts nowhere', async () => {
    const limit = EVENT_MAIL_LIMITS.perInstance.limit;
    const now = Date.UTC(2026, 10, 7, 12, 0, 0);
    await expect(reserveEventMailRound({ eventId: 'big', actorId: 'a', recipients: limit - 10 }, now)).resolves.toBe(true);
    // 11 more would be one too many: refused, and not counted in the event's or the actor's budget
    await expect(reserveEventMailRound({ eventId: EVENT, actorId: ACTOR, recipients: 11 }, now)).resolves.toBe(false);
    await expect(reserveEventMailRound({ eventId: EVENT, actorId: ACTOR, recipients: 10 }, now)).resolves.toBe(true);
    await expect(reserveEventMailRound({ eventId: 'other', actorId: 'b', recipients: 1 }, now)).resolves.toBe(false);
    // the next window starts empty
    await expect(reserveEventMailRound({ eventId: 'other', actorId: 'b', recipients: 1 }, now + EVENT_MAIL_LIMITS.perInstance.windowMs)).resolves.toBe(true);
  });

  it('a round refused by the event budget gives its mails back to the instance', async () => {
    const now = Date.now();
    for (let i = 0; i < EVENT_MAIL_LIMITS.perEvent.limit; i++) {
      await reserveEventMailRound({ eventId: EVENT, actorId: `actor-${i}`, recipients: 100 }, now);
    }
    await expect(reserveEventMailRound({ eventId: EVENT, actorId: 'late', recipients: 100 }, now)).resolves.toBe(false);
    const counter = [...memoryRedis.keys.entries()].find(([key]) => key.startsWith('ratelimit:mail:event:instance:'));
    expect(Number(counter?.[1])).toBe(EVENT_MAIL_LIMITS.perEvent.limit * 100);
  });

  it('no recipients: nothing to count', async () => {
    await expect(reserveEventMailRound({ eventId: EVENT, actorId: ACTOR, recipients: 0 })).resolves.toBe(true);
    expect(memoryRedis.keys.size).toBe(0);
    expect(memoryRedis.sortedSets.size).toBe(0);
  });
});
