// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
  Entity,
  Column,
  PrimaryGeneratedColumn,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
  Index,
  ManyToOne,
  JoinColumn,
} from "typeorm";
import { User } from "./users";

/**
 * One onchain CgStaking position (docs/ROADMAP-staking.md §5.1). Rows are
 * created by the onchain listener from Staked events and never deleted;
 * unstaking sets unstakedAt. userId is resolved from the wallet mapping at
 * indexing time and backfilled/cleared as wallets are linked and deleted —
 * only positions with a userId accrue Spark.
 */
@Entity({ name: 'staking_positions' })
@Unique(['chain', 'contractAddress', 'walletAddress', 'positionId'])
@Unique(['chain', 'stakeTxHash', 'stakeLogIndex'])
@Index("idx_staking_positions_userId", { synchronize: false })
@Index("idx_staking_positions_unclaimed_wallet", { synchronize: false })
@Index("idx_staking_positions_accrual_scan", { synchronize: false })
export class StakingPosition {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'varchar', length: 64, nullable: false })
  chain!: Models.Contract.ChainIdentifier;

  @Column({ type: 'varchar', length: 50, nullable: false })
  contractAddress!: Common.Address;

  @Column({ type: 'varchar', length: 50, nullable: false })
  walletAddress!: Common.Address;

  /** Per-owner position index inside the staking contract. */
  @Column({ type: 'bigint', nullable: false })
  positionId!: string;

  @Column({ type: 'uuid', nullable: true })
  userId!: string | null;

  @ManyToOne(() => User, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'userId' })
  user!: User | null;

  /** Token base units (uint128), stored as numeric string. */
  @Column({ type: 'numeric', precision: 39, scale: 0, nullable: false })
  amount!: string;

  @Column({ type: 'timestamptz', precision: 3, nullable: false })
  stakedAt!: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: false })
  unlockAt!: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  unstakedAt!: Date | null;

  @Column({ type: 'varchar', length: 80, nullable: false })
  stakeTxHash!: string;

  @Column({ type: 'integer', nullable: false })
  stakeLogIndex!: number;

  @Column({ type: 'varchar', length: 80, nullable: true })
  unstakeTxHash!: string | null;

  /** Last UTC day (inclusive) the accrual job credited for this position. */
  @Column({ type: 'date', nullable: true })
  accruedThroughDay!: string | null;

  /** Running total of Spark credited for this position. */
  @Column({ type: 'bigint', nullable: false, default: 0 })
  accruedSpark!: string;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', precision: 3 })
  updatedAt!: Date;
}
