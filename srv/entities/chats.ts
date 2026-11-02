// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Entity, Column, CreateDateColumn, DeleteDateColumn, UpdateDateColumn, Index, PrimaryGeneratedColumn, OneToOne, JoinColumn } from "typeorm";
import { Channel } from "./channels";

@Entity({ name: 'chats' })
export class Chat {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    // @ToDo: When one-to-one chats are expanded to group chats with potentially
    // a lot of users, this needs to be replaced by a proper db table
    @Index()
    // GIN index for membership lookups ("userIds" @> ARRAY[...]), created by the migration
    @Index('idx_chats_userIds_gin', { synchronize: false })
    @Column({ type: 'uuid', array: true, nullable: false })
    userIds!: string[];

    // @ToDo: When one-to-one chats are expanded to group chats with potentially
    // a lot of users, this needs to be replaced by a proper db table
    // Also, maybe add a moderator role in the future
    @Column({ type: 'uuid', array: true, nullable: false })
    adminIds!: string[];

    @Column({ type: 'uuid', nullable: false, unique: true })
    channelId!: string;

    @OneToOne(() => Channel, channel => channel.chat)
    @JoinColumn({
        name: 'channelId',
        referencedColumnName: 'id'
    })
    channel!: Channel;

    @CreateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    createdAt!: Date;

    @UpdateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    updatedAt!: Date;

    @DeleteDateColumn({ type: 'timestamptz', precision: 3, select: false })
    deletedAt!: Date | null;
}
