// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import pool from "../util/postgres";
import { getStakingConfig, type StakingConfig } from "../util/stakingConfig";

const YEAR_SECONDS = 365 * 86400;

/**
 * Pro-rata Spark target for a position at time t (docs/staking/README.md §6):
 *   total(A, d)  = A_tokens × rate × (d/Y) × (1 + d/Y)
 *   target(t)    = floor(total × min(t - stakedAt, d) / d)
 * expressed as a SQL fragment over a staking_positions row `sp` with
 * parameters $rate (numeric) and Postgres exact numeric arithmetic. Token
 * amounts are 18-decimal base units.
 */
function targetSparkSql(spAlias: string, rateParam: string): string {
  const dsec = `extract(epoch from ${spAlias}."unlockAt" - ${spAlias}."stakedAt")::numeric`;
  const elapsed = `LEAST(extract(epoch from now() - ${spAlias}."stakedAt")::numeric, ${dsec})`;
  const total =
    `(${spAlias}."amount" / 1e18) * ${rateParam}::numeric` +
    ` * (${dsec} * (${YEAR_SECONDS}::numeric + ${dsec}) / (${YEAR_SECONDS}::numeric * ${YEAR_SECONDS}::numeric))`;
  // matured positions get the exact total: the pro-rata ratio can floor one
  // Spark short of it through sub-millisecond timestamp residue otherwise
  return `(CASE
    WHEN now() >= ${spAlias}."unlockAt" THEN floor(GREATEST(${total}, 0))
    ELSE floor(GREATEST(${total} * ${elapsed} / ${dsec}, 0))
  END)::bigint`;
}

/**
 * Staking positions indexed from CgStaking contract events
 * (docs/staking/README.md §5). All writes are idempotent so the onchain
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
        $1, $2, $3::varchar, $4,
        (
          SELECT "userId" FROM wallets
          WHERE "walletIdentifier" = $3::text AND "deletedAt" IS NULL AND "userId" IS NOT NULL
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
   * accruing from claim time, never retroactively: accruedSpark is raised
   * to the position's current pro-rata target without crediting it, so the
   * accrual job only pays out growth from here on.
   */
  public async syncClaimsForUser(userId: string): Promise<void> {
    const config = getStakingConfig();
    const baseline = config
      ? `GREATEST(sp."accruedSpark", ${targetSparkSql('sp', '$2')})`
      : `sp."accruedSpark"`;
    const params: unknown[] = config ? [userId, config.baseRate.toString()] : [userId];
    await pool.query(`
      UPDATE staking_positions sp
      SET
        "userId" = $1,
        "accruedSpark" = ${baseline},
        "updatedAt" = now()
      FROM wallets w
      WHERE sp."userId" IS NULL
        AND w."userId" = $1
        AND w."deletedAt" IS NULL
        AND lower(w."walletIdentifier") = sp."walletAddress"
    `, params);
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
  /** All positions belonging to the user's linked wallets, newest first. */
  public async getPositionsByUser(userId: string): Promise<API.Staking.PositionView[]> {
    const config = getStakingConfig();
    const dsec = `extract(epoch from sp."unlockAt" - sp."stakedAt")::numeric`;
    const totalExpr = config
      ? `floor(GREATEST((sp."amount" / 1e18) * $2::numeric * (${dsec} * (${YEAR_SECONDS}::numeric + ${dsec}) / (${YEAR_SECONDS}::numeric * ${YEAR_SECONDS}::numeric)), 0))::bigint`
      : `0::bigint`;
    const params: unknown[] = config ? [userId, config.baseRate.toString()] : [userId];
    const result = await pool.query(`
      SELECT
        sp."id",
        sp."chain",
        sp."contractAddress",
        sp."walletAddress",
        sp."positionId"::text AS "positionId",
        sp."amount"::text AS "amount",
        sp."stakedAt",
        sp."unlockAt",
        sp."unstakedAt",
        sp."accruedSpark"::bigint AS "accruedSpark",
        ${totalExpr} AS "totalSpark"
      FROM staking_positions sp
      WHERE sp."userId" = $1
      ORDER BY sp."stakedAt" DESC
    `, params);
    return result.rows.map(row => ({
      id: row.id,
      chain: row.chain,
      contractAddress: row.contractAddress,
      walletAddress: row.walletAddress,
      positionId: row.positionId,
      amount: row.amount,
      stakedAt: (row.stakedAt as Date).toISOString(),
      unlockAt: (row.unlockAt as Date).toISOString(),
      unstakedAt: row.unstakedAt ? (row.unstakedAt as Date).toISOString() : null,
      accruedSpark: Number(row.accruedSpark),
      totalSpark: Number(row.totalSpark),
    }));
  }

  /**
   * Credit every claimed position up to its current pro-rata target
   * (docs/staking/README.md §6). Runs as one atomic statement: position
   * rows are locked (SKIP LOCKED makes concurrent runs no-ops), the delta
   * vs. accruedSpark is written to the point_transactions ledger, and user
   * balances are bumped. Absolutely idempotent — a rerun computes delta 0 —
   * and self-catching-up after downtime, since the target is a function of
   * elapsed time, not of job executions.
   *
   * @returns updated users for client event emission
   */
  public async runAccrual(config: StakingConfig): Promise<{
    userId: string;
    pointBalance: number;
    updatedAt: Date;
    creditedSpark: number;
  }[]> {
    const result = await pool.query(`
      WITH due AS (
        SELECT
          sp."id",
          sp."userId",
          sp."chain",
          sp."contractAddress",
          sp."positionId",
          sp."accruedSpark",
          ${targetSparkSql('sp', '$1')} AS "targetSpark"
        FROM staking_positions sp
        WHERE sp."userId" IS NOT NULL
        FOR UPDATE OF sp SKIP LOCKED
      ),
      deltas AS (
        SELECT *, "targetSpark" - "accruedSpark" AS "delta"
        FROM due
        WHERE "targetSpark" > "accruedSpark"
      ),
      upd_positions AS (
        UPDATE staking_positions sp
        SET
          "accruedSpark" = d."targetSpark",
          "accruedThroughDay" = (now() AT TIME ZONE 'utc')::date,
          "updatedAt" = now()
        FROM deltas d
        WHERE sp."id" = d."id"
      ),
      ins_ledger AS (
        INSERT INTO point_transactions ("userId", "amount", "data")
        SELECT
          d."userId",
          d."delta",
          jsonb_build_object(
            'type', 'staking-accrual',
            'chain', d."chain",
            'contractAddress', d."contractAddress",
            'positionId', d."positionId"::text,
            'periodEnd', to_char(now() AT TIME ZONE 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
          )
        FROM deltas d
      ),
      user_totals AS (
        SELECT "userId", sum("delta")::bigint AS "creditedSpark"
        FROM deltas
        GROUP BY "userId"
      )
      UPDATE users u
      SET
        "pointBalance" = u."pointBalance" + t."creditedSpark",
        "updatedAt" = now()
      FROM user_totals t
      WHERE u.id = t."userId"
      RETURNING u.id AS "userId", u."pointBalance", u."updatedAt", t."creditedSpark"
    `, [config.baseRate.toString()]);
    return result.rows.map(row => ({
      userId: row.userId as string,
      pointBalance: Number(row.pointBalance),
      updatedAt: row.updatedAt as Date,
      creditedSpark: Number(row.creditedSpark),
    }));
  }
}

const stakingHelper = new StakingHelper();
export default stakingHelper;
