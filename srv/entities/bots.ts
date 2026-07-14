// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
  Column,
  CreateDateColumn,
  DeleteDateColumn,
  Entity,
  Index,
  JoinColumn,
  ManyToOne,
  OneToOne,
  PrimaryColumn,
  UpdateDateColumn,
} from "typeorm";
import { BotOwnerType, BotPlatformPresenceMode } from "../common/enums";
import { Device } from "./device";
import { User } from "./users";

@Entity({ name: 'bots' })
@Index('idx_bots_active_owner', ['ownerType', 'ownerId'], { where: '"deletedAt" IS NULL' })
export class Bot {
  @PrimaryColumn({ type: 'uuid' })
  userId!: string;

  @OneToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'userId',
    referencedColumnName: 'id',
  })
  user!: User;

  @Column({ type: 'uuid', nullable: false, unique: true })
  deviceId!: string;

  @OneToOne(() => Device)
  @JoinColumn({
    name: 'deviceId',
    referencedColumnName: 'id',
  })
  device!: Device;

  @Column({ type: 'enum', enum: BotOwnerType, enumName: 'bots_ownertype_enum', nullable: false })
  ownerType!: Models.User.BotOwnerType;

  @Column({ type: 'uuid', nullable: true })
  ownerId!: string | null;

  @Column({ type: 'enum', enum: BotPlatformPresenceMode, enumName: 'bots_platformpresencemode_enum', nullable: true })
  platformPresenceMode!: Models.User.BotPlatformPresenceMode | null;

  @Column({ type: 'text', nullable: true })
  description!: string | null;

  @CreateDateColumn({ type: 'timestamptz', precision: 3, select: false })
  createdAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', precision: 3, select: false })
  updatedAt!: Date;

  @Index()
  @DeleteDateColumn({ type: 'timestamptz', precision: 3, select: false })
  deletedAt!: Date | null;
}
