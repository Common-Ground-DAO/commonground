// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
    Entity,
    Column,
    UpdateDateColumn,
    DeleteDateColumn,
    CreateDateColumn,
    Index,
    PrimaryColumn,
    ManyToOne,
    JoinColumn
} from "typeorm";
import { UserProfileTypeEnum } from "../common/enums";
import { User } from "./users";

@Entity({ name: 'user_accounts' })
@Index("idx_user_accounts_type_id", { synchronize: false })
@Index("idx_user_accounts_type_lower_id", { synchronize: false })
@Index("idx_user_accounts_cg_unique_displayName", { synchronize: false })
@Index("idx_user_accounts_bot_unique_displayName", { synchronize: false })
@Index("idx_user_accounts_displayName_gin_trgm", { synchronize: false })
export class UserAccount {
    @Index()
    @PrimaryColumn({ type: 'uuid' })
    userId!: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({
        name: 'userId',
        referencedColumnName: 'id'
    })
    user!: User;

    @PrimaryColumn({ type: 'enum', enum: UserProfileTypeEnum })
    type!: Models.User.ProfileItemType;

    @Column({ type: 'varchar', length: 255, nullable: false })
    displayName!: string;

    @Column({ type: 'varchar', length: 64, nullable: true })
    imageId!: string | null;

    @Column({ type: 'jsonb', nullable: true, select: false })
    data!: Models.User.UserAccountData | null;

    @Column({ type: 'jsonb', nullable: true })
    extraData!: Models.User.UserAccountExtraData | null;

    @CreateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    createdAt!: Date;

    @UpdateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    updatedAt!: Date;

    @Index()
    @DeleteDateColumn({ type: 'timestamptz', precision: 3, select: false })
    deletedAt!: Date | null;
}
