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
import { Bot } from "./bots";

@Entity({ name: 'bot_tokens' })
@Index('idx_bot_tokens_active_bot', ['botUserId'], { where: '"revokedAt" IS NULL' })
export class BotToken {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ type: 'uuid', nullable: false })
  botUserId!: string;

  @ManyToOne(() => Bot, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'botUserId', referencedColumnName: 'userId' })
  bot!: Bot;

  @Column({ type: 'char', length: 64, nullable: false, unique: true, select: false })
  tokenHash!: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name!: string | null;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  lastUsedAt!: Date | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  createdAt!: Date;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  revokedAt!: Date | null;
}
