// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { isMainThread } from 'worker_threads';
import redisManager from '../redis';
import { setStaleUsersOffline } from '../repositories/userPresence';

if (isMainThread) {
  throw new Error("OnlineStatusCheck can only be run as a worker job");
}

(async () => {
  const updatedUserIds = await setStaleUsersOffline(90);
  if (updatedUserIds.length > 0) {
    console.log("Setting userIds to offline due to > 90s stale: ", JSON.stringify(updatedUserIds));
    // the emitter publishes without waiting for Redis: a PING on the same
    // connection returns after the PUBLISHes before it, so none is lost when
    // the worker exits
    await redisManager.getClient('socketIOPub').ping();
  }
  process.exit(0);
})().catch(e => {
  console.error("OnlineStatusCheck job failed", e);
  process.exit(1);
});
