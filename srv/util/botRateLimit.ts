// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import errors from '../common/errors';
import redisManager from '../redis';
import serverconfig from '../serverconfig';

const WINDOW_MS = 60 * 1000;

export async function enforceBotRateLimit(tokenId: string, scope: 'api' | 'message') {
  await redisManager.isReady;
  const limit = scope === 'api'
    ? serverconfig.BOT_API_RATE_LIMIT_PER_MINUTE
    : serverconfig.BOT_MESSAGE_RATE_LIMIT_PER_MINUTE;
  const window = Math.floor(Date.now() / WINDOW_MS);
  const key = `bot-ratelimit:${scope}:${tokenId}:${window}`;
  const results = await redisManager.getClient('data')
    .multi()
    .incr(key)
    .expire(key, Math.ceil(WINDOW_MS / 1000) + 1)
    // `execTyped()` (node-redis 5+) preserves the per-command reply types;
    // plain `exec()` now collapses them to `ReplyUnion[]`.
    .execTyped();
  const count = results[0];
  if (count > limit) {
    throw new Error(errors.server.RATE_LIMIT_EXCEEDED);
  }
}
