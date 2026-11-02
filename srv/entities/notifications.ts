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
    DeleteDateColumn,
    UpdateDateColumn
} from "typeorm";
import { User } from "./users";
import { Community } from "./communities";
import { NotificationType } from "../common/enums";
import { Article } from "./articles";

@Entity({ name: 'notifications' })
export class Notification {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'enum', enum: NotificationType, nullable: false })
    type!: NotificationType;

    @Index()
    // partial index (unread notifications, "read" = FALSE), created by the migration
    @Index('idx_notifications_userId_unread', { synchronize: false })
    @Column({ type: 'uuid', nullable: false })
    userId!: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({
        name: 'userId',
        referencedColumnName: 'id'
    })
    user!: User;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    subjectUserId!: string | null;

    @ManyToOne(() => User)
    @JoinColumn({
        name: 'subjectUserId',
        referencedColumnName: 'id'
    })
    subjectUser!: User | null;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    subjectCommunityId!: string | null;

    @ManyToOne(() => Community)
    @JoinColumn({
        name: 'subjectCommunityId',
        referencedColumnName: 'id'
    })
    subjectCommunity!: Community | null;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    subjectArticleId!: string | null;

    @ManyToOne(() => Article, { nullable: true })
    @JoinColumn({
        name: 'subjectArticleId',
        referencedColumnName: 'id'
    })
    subjectArticle!: Article | null;

    @Index()
    @Column({ type: 'uuid', nullable: true })
    subjectItemId!: string | null;

    @Column({ type: 'varchar', length: 256, nullable: false })
    text!: string;

    @CreateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    createdAt!: Date;

    @UpdateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    updatedAt!: Date;

    @DeleteDateColumn({ type: 'timestamptz', precision: 3, select: false })
    deletedAt!: Date | null;

    @Index()
    @Column({ type: 'boolean', nullable: false, default: false })
    read!: boolean;

    @Column({ type: 'jsonb', nullable: true })
    extraData!: Models.Notification.ExtraData | null;
}
