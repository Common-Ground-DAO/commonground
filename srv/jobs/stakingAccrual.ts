// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { isMainThread } from 'worker_threads';
import stakingHelper from '../repositories/staking';
import eventHelper from '../repositories/event';
import { getStakingConfig } from '../util/stakingConfig';

if (isMainThread) {
  throw new Error("StakingAccrual can only be run as a worker job");
}

(async () => {
  const config = getStakingConfig();
  if (!config) {
    // staking not configured on this instance — nothing to do
    process.exit(0);
  }
  const credited = await stakingHelper.runAccrual(config);
  if (credited.length > 0) {
    const totalSpark = credited.reduce((sum, c) => sum + c.creditedSpark, 0);
    console.log(`StakingAccrual: credited ${totalSpark} Spark to ${credited.length} users`);
    for (const user of credited) {
      const event: Events.User.OwnData = {
        type: 'cliUserOwnData',
        data: {
          pointBalance: user.pointBalance,
          updatedAt: user.updatedAt.toISOString(),
        },
      };
      await eventHelper.emit(event, { userIds: [user.userId] });
    }
  }
  process.exit(0);
})().catch(e => {
  console.error("StakingAccrual job failed", e);
  process.exit(1);
});
