// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import pool from "../util/postgres";

/**
 * Staking positions indexed from CgStaking contract events
 * (docs/ROADMAP-staking.md §5.1). All writes are idempotent so the onchain
 * listener's at-least-once delivery yields exactly-once effects.
 */

export type StakedEvent = {
  chain: Models.Contract.ChainIdentifier;
  contractAddress: Common.Address;
  ownerAddress: Common.Address;
  positionId: bigint;
  amount: bigint;
  stakedAt: Date;
  unlockAt: Date;
  txHash: string;
  logIndex: number;
};

export type UnstakedEvent = {
  chain: Models.Contract.ChainIdentifier;
  contractAddress: Common.Address;
  ownerAddress: Common.Address;
  positionId: bigint;
  txHash: string;
};

class StakingHelper {
  /**
   * Insert a position seen in a Staked event. The owning user is resolved
   * from the wallet mapping at insert time; unmatched wallets stay
   * unclaimed (userId NULL) until the wallet is linked.
   */
  public async recordStaked(event: StakedEvent): Promise<void> {
    await pool.query(`
      INSERT INTO staking_positions (
        "chain",
        "contractAddress",
        "walletAddress",
        "positionId",
        "userId",
        "amount",
        "stakedAt",
        "unlockAt",
        "stakeTxHash",
        "stakeLogIndex"
      )
      VALUES (
        $1, $2, $3, $4,
        (
          SELECT "userId" FROM wallets
          WHERE "walletIdentifier" = $3 AND "deletedAt" IS NULL AND "userId" IS NOT NULL
          LIMIT 1
        ),
        $5, $6, $7, $8, $9
      )
      ON CONFLICT ON CONSTRAINT "UQ_staking_positions_stake_log" DO NOTHING
    `, [
      event.chain,
      event.contractAddress.toLowerCase(),
      event.ownerAddress.toLowerCase(),
      event.positionId.toString(),
      event.amount.toString(),
      event.stakedAt,
      event.unlockAt,
      event.txHash,
      event.logIndex,
    ]);
  }

  /** Mark a position withdrawn. Idempotent; unknown positions are ignored. */
  public async recordUnstaked(event: UnstakedEvent): Promise<void> {
    await pool.query(`
      UPDATE staking_positions
      SET
        "unstakedAt" = now(),
        "unstakeTxHash" = $5,
        "updatedAt" = now()
      WHERE "chain" = $1
        AND "contractAddress" = $2
        AND "walletAddress" = $3
        AND "positionId" = $4
        AND "unstakedAt" IS NULL
    `, [
      event.chain,
      event.contractAddress.toLowerCase(),
      event.ownerAddress.toLowerCase(),
      event.positionId.toString(),
      event.txHash,
    ]);
  }

  /**
   * Recompute position ownership from the user's current wallets. Called
   * after a wallet is linked or deleted. Newly claimed positions start
   * accruing from today (never retroactively): accruedThroughDay is bumped
   * to yesterday so pre-link days are skipped without being credited.
   */
  public async syncClaimsForUser(userId: string): Promise<void> {
    await pool.query(`
      UPDATE staking_positions sp
      SET
        "userId" = $1,
        "accruedThroughDay" = GREATEST(
          COALESCE(sp."accruedThroughDay", '-infinity'::date),
          (now() AT TIME ZONE 'utc')::date - 1
        ),
        "updatedAt" = now()
      FROM wallets w
      WHERE sp."userId" IS NULL
        AND w."userId" = $1
        AND w."deletedAt" IS NULL
        AND lower(w."walletIdentifier") = sp."walletAddress"
    `, [userId]);
    await pool.query(`
      UPDATE staking_positions sp
      SET "userId" = NULL, "updatedAt" = now()
      WHERE sp."userId" = $1
        AND NOT EXISTS (
          SELECT 1 FROM wallets w
          WHERE w."userId" = $1
            AND w."deletedAt" IS NULL
            AND lower(w."walletIdentifier") = sp."walletAddress"
        )
    `, [userId]);
  }
}

const stakingHelper = new StakingHelper();
export default stakingHelper;
