// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import redisManager from "../redis";

/**
 * A per-account counter in Valkey that changes whenever something outside a
 * session may have made the account need the account-security step again
 * (a password below the policy signed in, the verified address was reset by
 * the bounce policy). Sessions that found the account complete remember the
 * counter (srv/util/securityStep.ts) and check again once it moved.
 */

const versionKey = (userId: string) => `security-step-version:${userId}`;
const VERSION_TTL_SECONDS = 30 * 24 * 60 * 60;

export async function getSecurityStepVersion(userId: string): Promise<string | null> {
  return await redisManager.getClient("data").get(versionKey(userId));
}

/** Never throws: a failed bump only delays the re-check until the next login. */
export async function bumpSecurityStepVersion(userIds: string[]): Promise<void> {
  const client = redisManager.getClient("data");
  await Promise.all(userIds.map(async userId => {
    try {
      await client.incr(versionKey(userId));
      await client.expire(versionKey(userId), VERSION_TTL_SECONDS);
    }
    catch (e) {
      console.error("Could not record an account-security change", e instanceof Error ? e.message : e);
    }
  }));
}
