// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// Minimal in-memory stand-in for srv/redis (GET, SET with NX, DEL, INCR, and the
// compare-and-delete script of srv/util/emailCodes.ts), for
// jest.mock('../redis', ...). TTLs are not modelled.

export const keys = new Map<string, string>();

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
  async expire() {
    return 1;
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
