// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { type JsonWebKey } from "crypto";
import {
    Entity,
    ManyToOne,
    JoinColumn,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    DeleteDateColumn,
    UpdateDateColumn,
    Index
} from "typeorm";
import { User } from "./users";

@Entity({ name: 'devices' })
export class Device {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'uuid', nullable: false })
    userId!: string;

    @Index()
    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({
        name: 'userId',
        referencedColumnName: 'id'
    })
    user!: User;

    @CreateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    createdAt!: Date;

    @UpdateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    updatedAt!: Date;

    @DeleteDateColumn({ type: 'timestamptz', precision: 3, select: false })
    deletedAt!: Date | null;

    @Column({ type: 'jsonb', nullable: false })
    publicKey!: JsonWebKey;

    /**
     * The session generation of the login that created the key (or of the
     * account's last sign-out of other devices, for the device that did it);
     * valid only while not below the user's `sessionGeneration`.
     */
    @Column({ type: 'bigint', nullable: false, default: 0, select: false })
    generation!: string;

    @Column({ type: 'jsonb', nullable: true })
    webPushSubscription!: Models.Notification.PushSubscription | null;

    @Column({ type: 'jsonb', nullable: true })
    deviceInfo!: Common.DeviceInfo | null;
}