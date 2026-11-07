// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// Minimal in-memory stand-in for srv/redis (GET, SET with NX, DEL, INCR/INCRBY/DECRBY, the
// compare-and-delete script of srv/util/emailCodes.ts, and the sorted-set
// commands of srv/util/rateLimit.ts with MULTI), for jest.mock('../redis', ...).
// TTLs are not modelled.

export const keys = new Map<string, string>();
export const sortedSets = new Map<string, Map<string, number>>();

function sortedSet(key: string) {
  if (!sortedSets.has(key)) {
    sortedSets.set(key, new Map());
  }
  return sortedSets.get(key)!;
}

const zRemRangeByScore = (key: string, min: number, max: number) => {
  let removed = 0;
  for (const [value, score] of sortedSet(key)) {
    if (score >= min && score <= max) {
      sortedSet(key).delete(value);
      removed++;
    }
  }
  return removed;
};
const zCount = (key: string, min: number, max: number) =>
  [...sortedSet(key).values()].filter(score => score >= min && score <= max).length;

const client = {
  async get(key: string) {
    return keys.get(key) ?? null;
  },
  async set(key: string, value: string, options?: { condition?: string }) {
    if (options?.condition === "NX" && keys.has(key)) {
      return null;
    }
    keys.set(key, value);
    return "OK";
  },
  async del(key: string) {
    return keys.delete(key) ? 1 : 0;
  },
  async incr(key: string) {
    const next = Number(keys.get(key) ?? 0) + 1;
    keys.set(key, String(next));
    return next;
  },
  async incrBy(key: string, by: number) {
    const next = Number(keys.get(key) ?? 0) + by;
    keys.set(key, String(next));
    return next;
  },
  async decrBy(key: string, by: number) {
    const next = Number(keys.get(key) ?? 0) - by;
    keys.set(key, String(next));
    return next;
  },
  async expire() {
    return 1;
  },
  // MULTI: the queued commands run in one go, like on the server
  multi() {
    const ops: (() => unknown)[] = [];
    const chain = {
      incrBy(key: string, by: number) { ops.push(() => { const next = Number(keys.get(key) ?? 0) + by; keys.set(key, String(next)); return next; }); return chain; },
      zAdd(key: string, entry: { value: string; score: number }) { ops.push(() => { sortedSet(key).set(entry.value, entry.score); return 1; }); return chain; },
      expire() { ops.push(() => 1); return chain; },
      zRemRangeByScore(key: string, min: number, max: number) { ops.push(() => zRemRangeByScore(key, min, max)); return chain; },
      zCount(key: string, min: number, max: number) { ops.push(() => zCount(key, min, max)); return chain; },
      async execTyped() { return ops.map(op => op()) as any; },
    };
    return chain;
  },
  async zRem(key: string, value: string) {
    return sortedSet(key).delete(value) ? 1 : 0;
  },
  async zRangeWithScores(key: string, start: number, stop: number) {
    return [...sortedSet(key).entries()]
      .map(([value, score]) => ({ value, score }))
      .sort((a, b) => a.score - b.score)
      .slice(start, stop + 1);
  },
  // only "delete KEYS[1] if it still holds ARGV[1]" is supported
  async eval(_script: string, options: { keys: string[]; arguments: string[] }) {
    const [key] = options.keys;
    if (keys.get(key) === options.arguments[0]) {
      keys.delete(key);
      return 1;
    }
    return 0;
  },
};

const redisManager = {
  getClient: () => client,
  get: async (_type: string, key: string) => keys.get(key) ?? null,
};

export default redisManager;
