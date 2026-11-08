// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  PrimaryGeneratedColumn,
} from "typeorm";
import { User } from "./users";

/**
 * A one-time sign-in link to this instance, minted by an instance that shares
 * the database (the app.cg gateway during the move) for its session's own
 * user (srv/util/transferLink.ts, docs/auth-identity §11). Only the SHA-256
 * hash of the token is stored; a row is redeemed at most once (`usedAt`) and
 * only until `expiresAt`. Old rows are deleted when new links are minted.
 */
@Entity({ name: 'transfer_tokens' })
@Index('idx_transfer_tokens_userId', ['userId'])
@Index('idx_transfer_tokens_expiresAt', ['expiresAt'])
export class TransferToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId', referencedColumnName: 'id', foreignKeyConstraintName: 'FK_transfer_tokens_userId' })
  user!: User;

  @Column({ type: 'char', length: 64, nullable: false, unique: true, select: false })
  tokenHash!: string;

  /** a same-site path to continue to after the transfer */
  @Column({ type: 'varchar', length: 2048, nullable: true })
  nextPath!: string | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: false })
  expiresAt!: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  usedAt!: Date | null;

  /** First passkey only: target RP, attested by a fresh legacy passkey login. */
  @Column({ type: 'text', nullable: true })
  passkeySetupRpId!: string | null;

  /** the session generation of the session that minted it; redeemable only while not below the user's */
  @Column({ type: 'bigint', nullable: false, default: 0 })
  generation!: string;
}
