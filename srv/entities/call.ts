// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
  Entity,
  ManyToOne,
  JoinColumn,
  Column,
  Index,
  CreateDateColumn,
  DeleteDateColumn,
  PrimaryGeneratedColumn,
  OneToMany,
  UpdateDateColumn,
  PrimaryColumn,
} from "typeorm";
import { Community } from "./communities";
import { Channel } from "./channels";
import { CallServer } from "./callserver";
import { User } from "./users";
import { Role } from "./roles";
import { CallPermission, CallType } from "../common/enums";

@Entity({ name: 'calls' })
export class Call {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  // partial index (open calls, "endedAt" IS NULL), created by the migration
  @Index('idx_calls_communityId_open', { synchronize: false })
  @Column({ type: 'uuid' })
  communityId!: string;

  @ManyToOne(() => Community, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({
    name: 'communityId',
    referencedColumnName: 'id'
  })
  community!: Community;

  @Index()
  @Column({ type: 'uuid' })
  callCreator!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({
    name: 'callCreator',
    referencedColumnName: 'id'
  })
  creator!: User;

  @Index()
  @Column({ type: 'uuid' })
  channelId!: string;

  @ManyToOne(() => Channel, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({
    name: 'channelId',
    referencedColumnName: 'id'
  })
  channel!: Channel;

  @Index()
  @Column({ type: 'uuid', nullable: true })
  callServerId!: string;

  @ManyToOne(() => CallServer, { onDelete: 'CASCADE' })
  @JoinColumn({
    name: 'callServerId',
    referencedColumnName: 'id'
  })
  callServer!: CallServer | null;

  @Column({ type: 'enum', enum: CallType, nullable: false, default: CallType.DEFAULT })
  callType!: CallType;

  @OneToMany(() => CallMembership, (callMembership) => callMembership.call)
  callMemberships!: CallMembership[];

  @OneToMany(() => CallPermissions, (callPermissions) => callPermissions.call)
  callPermissions!: CallPermissions[];

  @Column({ type: 'varchar', length: 100, nullable: false })
  title!: string;

  @Column({ type: 'varchar', length: 200, nullable: true })
  description!: string;

  @Column({ type: 'uuid', array: true })
  previewUserIds!: string[];

  @Column({ type: 'int', nullable: false, default: 100 })
  slots!: number;
  
  @Column({ type: 'int', nullable: false })
  stageSlots!: number;

  @Column({ type: 'boolean', nullable: false, default: false })
  audioOnly!: boolean;
  
  @Column({ type: 'boolean', nullable: false, default: false })
  highQuality!: boolean;

  @Column({ type: 'timestamptz', precision: 3, nullable: true })
  scheduleDate!: Date;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  startedAt!: Date;

  @UpdateDateColumn({ type: 'timestamptz', precision: 3 })
  updatedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', precision: 3, select: false })
  endedAt!: Date | null;
}

@Entity({ name: 'callmembers' })
export class CallMembership {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Index()
  @Column({ type: 'uuid' })
  callId!: string;

  @ManyToOne(() => Call, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({
    name: 'callId',
    referencedColumnName: 'id'
  })
  call!: Call;

  @Index()
  @Column({ type: 'uuid' })
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({
    name: 'userId',
    referencedColumnName: 'id'
  })
  user!: User;

  @CreateDateColumn({ type: 'timestamptz', precision: 3 })
  joinedAt!: Date;

  @DeleteDateColumn({ type: 'timestamptz', precision: 3, select: false })
  leftAt!: Date | null;  
}

@Entity({ name: 'callpermissions' })
export class CallPermissions {
  @Index()
  @PrimaryColumn({ type: 'uuid' })
  callId!: string;

  @ManyToOne(() => Call, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({
    name: 'callId',
    referencedColumnName: 'id'
  })
  call!: Call;

  @Index()
  @PrimaryColumn({ type: 'uuid' })
  roleId!: string;

  @ManyToOne(() => Role, { onDelete: 'CASCADE', nullable: false })
  @JoinColumn({
    name: 'roleId',
    referencedColumnName: 'id'
  })
  role!: Role;

  @Column({ type: 'enum', enum: CallPermission, array: true })
  permissions!: CallPermission[];
}