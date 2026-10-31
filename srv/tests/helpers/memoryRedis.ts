// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

// Minimal in-memory stand-in for srv/redis (SET with NX only), for
// jest.mock('../redis', ...).

export const keys = new Map<string, string>();

const client = {
  async set(key: string, value: string, options?: { condition?: string }) {
    if (options?.condition === "NX" && keys.has(key)) {
      return null;
    }
    keys.set(key, value);
    return "OK";
  },
};

const redisManager = {
  getClient: () => client,
  get: async (_type: string, key: string) => keys.get(key) ?? null,
};

export default redisManager;
