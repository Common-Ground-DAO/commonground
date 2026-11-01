// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/**
 * Login failure budgets (srv/util/rateLimit.ts failureBudget /
 * reserveFailures): a slot is reserved atomically before the check, so
 * parallel attempts cannot overrun the budget; success gives it back.
 *
 * Runs against an in-memory stand-in whose MULTI applies all commands at
 * once (as Valkey does), and — when CG_TEST_VALKEY_URL is set (e.g.
 * redis://localhost:6379 of a throwaway `valkey/valkey` container) — once
 * more against a real server.
 */

process.env.DEPLOYMENT = 'prod';

import type * as RateLimit from '../util/rateLimit';

/** sorted sets in memory; exec() runs the queued commands in one go */
function memoryClient() {
  const sets = new Map<string, Map<string, number>>();
  const set = (key: string) => {
    if (!sets.has(key)) sets.set(key, new Map());
    return sets.get(key)!;
  };
  const client = {
    multi() {
      const ops: (() => unknown)[] = [];
      const chain = {
        zAdd(key: string, entry: { value: string; score: number }) { ops.push(() => { set(key).set(entry.value, entry.score); return 1; }); return chain; },
        expire() { ops.push(() => 1); return chain; },
        zRemRangeByScore(key: string, min: number, max: number) {
          ops.push(() => { let n = 0; for (const [v, s] of set(key)) if (s >= min && s <= max) { set(key).delete(v); n++; } return n; });
          return chain;
        },
        zCount(key: string, min: number, max: number) {
          ops.push(() => [...set(key).values()].filter(s => s >= min && s <= max).length);
          return chain;
        },
        async execTyped() {
          // a tick of network latency, then all at once
          await new Promise(resolve => setImmediate(resolve));
          return ops.map(op => op());
        },
      };
      return chain;
    },
    async zRem(key: string, value: string) {
      return set(key).delete(value) ? 1 : 0;
    },
  };
  return client;
}

function suite(name: string, load: () => typeof RateLimit) {
  describe(name, () => {
    let rateLimit: typeof RateLimit;
    beforeAll(() => {
      rateLimit = load();
    });
    const unique = () => `test-${Date.now()}-${Math.random()}`;

    it('of 30 parallel attempts at most `limit` get through to the (slow) check', async () => {
      const budget = rateLimit.failureBudget({ bucket: unique(), windowMs: 60_000, limit: 10 });
      let checked = 0;
      const results = await Promise.allSettled(Array.from({ length: 30 }, async () => {
        await budget.reserve('someone|v4:203.0.113');
        checked++;
        // the password check takes a while; the attempt fails (keeps its slot)
        await new Promise(resolve => setTimeout(resolve, 20));
      }));
      expect(checked).toBe(10);
      expect(results.filter(r => r.status === 'rejected').map(r => (r as PromiseRejectedResult).reason.message))
        .toEqual(Array(20).fill('RATE_LIMIT_EXCEEDED'));
      await expect(budget.reserve('someone|v4:203.0.113')).rejects.toThrow('RATE_LIMIT_EXCEEDED');
      // another network, another budget
      await expect(budget.reserve('someone|v4:198.51.100')).resolves.toBeDefined();
    });

    it('successful attempts give their slot back', async () => {
      const budget = rateLimit.failureBudget({ bucket: unique(), windowMs: 60_000, limit: 3 });
      for (let i = 0; i < 20; i++) {
        const reservation = await budget.reserve('someone');
        await reservation.release();
      }
      for (let i = 0; i < 3; i++) {
        await budget.reserve('someone');
      }
      await expect(budget.reserve('someone')).rejects.toThrow('RATE_LIMIT_EXCEEDED');
    });

    it('several budgets: if one is spent, the others are given back', async () => {
      const network = rateLimit.failureBudget({ bucket: unique(), windowMs: 60_000, limit: 5 });
      const all = rateLimit.failureBudget({ bucket: unique(), windowMs: 60_000, limit: 2 });
      await rateLimit.reserveFailures([{ budget: network, key: 'a|n1' }, { budget: all, key: 'a' }]);
      await rateLimit.reserveFailures([{ budget: network, key: 'a|n2' }, { budget: all, key: 'a' }]);
      // the overall budget is spent: refused, and the network slot is not kept
      for (let i = 0; i < 5; i++) {
        await expect(rateLimit.reserveFailures([{ budget: network, key: 'a|n1' }, { budget: all, key: 'a' }])).rejects.toThrow('RATE_LIMIT_EXCEEDED');
      }
      // 'a|n1' holds 1 of 5: the refused attempts gave theirs back
      for (let i = 0; i < 4; i++) {
        await network.reserve('a|n1');
      }
      await expect(network.reserve('a|n1')).rejects.toThrow('RATE_LIMIT_EXCEEDED');
    });

    it('the client network: IPv4 /24, IPv6 /56', () => {
      const request = (xff: string) => ({ headers: { 'x-forwarded-for': xff } }) as any;
      expect(rateLimit.clientPrefixKey(request('203.0.113.7'))).toBe('v4:203.0.113');
      expect(rateLimit.clientPrefixKey(request('203.0.113.200'))).toBe('v4:203.0.113');
      expect(rateLimit.clientPrefixKey(request('2001:db8:1234:5678::1'))).toBe(rateLimit.clientPrefixKey(request('2001:db8:1234:56ff::2')));
      expect(rateLimit.clientPrefixKey(request('2001:db8:1234:5678::1'))).not.toBe(rateLimit.clientPrefixKey(request('2001:db8:1234:5778::1')));
      expect(() => rateLimit.clientPrefixKey(request('nonsense'))).toThrow('INVALID_REQUEST');
    });
  });
}

suite('failure budgets (in-memory server)', () => {
  let loaded!: typeof RateLimit;
  jest.isolateModules(() => {
    const client = memoryClient();
    jest.doMock('../redis', () => ({ __esModule: true, default: { getClient: () => client } }));
    loaded = require('../util/rateLimit');
  });
  return loaded;
});

const VALKEY = process.env.CG_TEST_VALKEY_URL;
if (VALKEY) {
  let manager: any;
  suite('failure budgets (Valkey)', () => {
    let loaded!: typeof RateLimit;
    jest.isolateModules(() => {
      jest.dontMock('../redis');
      process.env.REDIS_URL = VALKEY;
      // no Docker secrets here: the redis module warns about it
      const warn = jest.spyOn(console, 'warn').mockImplementation(() => undefined);
      manager = require('../redis').default;
      warn.mockRestore();
      loaded = require('../util/rateLimit');
    });
    return loaded;
  });
  afterAll(async () => {
    await manager?.getClient('data').quit().catch(() => undefined);
  });
}
