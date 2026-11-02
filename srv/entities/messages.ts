// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
    Entity,
    ManyToOne,
    JoinColumn,
    Column,
    PrimaryGeneratedColumn,
    Index,
    CreateDateColumn,
    UpdateDateColumn,
    DeleteDateColumn,
    Unique
} from "typeorm";
import { User } from "./users";
import { Channel } from "./channels";

@Entity({ name: 'messages' })
@Unique(['channelId', 'createdAt'])
// partial ("syncSeq" IS NOT NULL), see migration 1793635200000-chatSyncSeq
@Index('idx_messages_channelId_syncSeq', { synchronize: false })
export class Message {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'uuid', nullable: false })
    creatorId!: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({
        name: 'creatorId',
        referencedColumnName: 'id'
    })
    creator!: User;

    @Index()
    @Column({ type: 'uuid', nullable: false })
    channelId!: string;

    @ManyToOne(() => Channel, { onDelete: 'CASCADE' })
    @JoinColumn([{
        name: 'channelId',
        referencedColumnName: 'id'
    }])
    channel!: Channel;

    @Column({ type: 'jsonb', nullable: false })
    body!: Models.Message.Body;

    @Column({ type: 'jsonb', nullable: true })
    attachments!: Models.Message.Attachment[] | null;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    parentMessageId!: string;

    @ManyToOne(() => Message, { onDelete: 'SET NULL' })
    @JoinColumn({
        name: 'parentMessageId',
        referencedColumnName: 'id'
    })
    parentMessage!: Message | null;

    @Column({ type: 'jsonb', nullable: true })
    reactions!: Models.Message.ApiMessage["reactions"] | null;

    @Index('idx_posts_tsv_tags', { fulltext: true })
    @Column({ type: 'tsvector', nullable: true, select: false, default: () => `to_tsvector('simple', '')` })
    tsv_tags!: string;

    @Column({ type: 'timestamptz', precision: 3, nullable: true })
    editedAt!: Date | null;

    @Index()
    @CreateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    createdAt!: Date;

    @Index()
    @UpdateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    updatedAt!: Date;

    @Index()
    @DeleteDateColumn({ type: 'timestamptz', precision: 3, select: false })
    deletedAt!: Date | null;

    /**
     * Channel change sequence of this row's last write (chat-sync). Set only
     * by the `messages_sync_seq_*` triggers (from channel_sync_state); NULL
     * for rows not written since the migration. bigint: node-postgres returns
     * it as a string.
     */
    @Column({ type: 'bigint', nullable: true, select: false })
    syncSeq!: string | null;
}
