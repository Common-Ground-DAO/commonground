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
    UpdateDateColumn,
    OneToMany,
    ManyToMany,
    PrimaryGeneratedColumn
} from "typeorm";
import { Area } from "./areas";
import { CommunityChannel } from "./communities-channels";
import { Role } from "./roles";
import { User } from "./users";
import { CommunityPremium } from "./communities-premium";
import { CommunityToken } from "./communities-tokens";

@Entity({ name: 'communities' })
@Index("idx_communities_title_gin_trgm", { synchronize: false })
export class Community {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'uuid', nullable: true })
    creatorId!: string;

    @ManyToOne(() => User, { onDelete: 'SET NULL' })
    @JoinColumn({
        name: 'creatorId',
        referencedColumnName: 'id'
    })
    creator!: User;

    @Column({ type: 'varchar', length: 30, nullable: false, unique: true })
    url!: string;

    @Column({ type: 'varchar', length: 50, nullable: false })
    title!: string;

    @Column({ type: 'varchar', length: 1000, nullable: false })
    description!: string;

    @Column({ type: 'varchar', length: 50, nullable: false })
    shortDescription!: string;

    @Column({ type: 'varchar', length: 50, nullable: true })
    password!: string;

    @Column({ type: 'varchar', length: 64, nullable: true })
    logoSmallId!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    logoLargeId!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    headerImageId!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true })
    previewImageId!: string;

    @Index()
    @Column({ type: 'varchar', length: 50, array: true, nullable: false })
    tags!: string[];

    @Column({ type: 'jsonb', nullable: false })
    links!: Common.Link[];

    @Column({ type: 'jsonb', nullable: true })
    onboardingOptions!: Models.Community.OnboardingOptions[] | null;

    @Index()
    @Column({ type: 'double precision', nullable: false, default: 0 })
    activityScore!: number;

    @Column({ type: 'integer', nullable: false, default: 1 })
    memberCount!: number;

    @Column({ type: 'integer', nullable: false, default: 0 })
    pointBalance!: number;

    // @Column({ type: 'boolean', nullable: false, default: false })
    // verified!: boolean;

    @OneToMany(() => Role, (role) => role.community)
    roles!: Role[];

    @OneToMany(() => Area, (area) => area.community)
    areas!: Area[];

    @OneToMany(() => CommunityPremium, (communityPremium) => communityPremium.community)
    premiumFeatures!: CommunityPremium[];

    @OneToMany(() => CommunityToken, (communityToken) => communityToken.community)
    tokens!: CommunityToken[];

    @ManyToMany(() => CommunityChannel, (communityChannel) => communityChannel.community)
    communityChannels!: CommunityChannel[];

    @Index('idx_groups_tsv_description', { fulltext: true })
    @Column({ type: 'tsvector', nullable: true, select: false, default: () => `to_tsvector('simple', '')` })
    tsv_description!: string;

    @Column({ type: 'boolean', nullable: false, default: false })
    official!: boolean;

    @Column({ type: 'boolean', nullable: false, default: false })
    enablePersonalNewsletter!: boolean;

    @Column({ type: 'boolean', nullable: false, default: false })
    allowUserBots!: boolean;

    @CreateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    createdAt!: Date;

    @UpdateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    updatedAt!: Date;

    @DeleteDateColumn({ type: 'timestamptz', precision: 3, select: false })
    deletedAt!: Date | null;
}
