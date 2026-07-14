// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    UpdateDateColumn,
    DeleteDateColumn,
    CreateDateColumn,
    Index,
    OneToMany,
    PrimaryColumn,
    ManyToOne,
    JoinColumn
} from "typeorm";
import { Device } from "./device"
import { UserRoleClaim } from "./roles";
import { Notification } from "./notifications";
import { CallMembership } from "./call";
import { UserProfileTypeEnum, OnlineStatusEnum } from "../common/enums";
import { UserAccount } from "./user-accounts";
import { UserPremium } from "./users-premium";
import { Passkey } from "./passkeys";
import { TokenSaleRegistration } from "./tokensale";

@Entity({ name: 'users' })
export class User {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'text', nullable: true, select: false })
    password!: string | null;

    @Column({ type: 'enum', enum: OnlineStatusEnum, default: OnlineStatusEnum.OFFLINE })
    onlineStatus!: OnlineStatusEnum;

    @Column({ type: 'timestamptz', precision: 3, select: false, default: () => 'now()' })
    onlineStatusUpdatedAt!: Date;

    @Column({ type: 'varchar', length: 64, nullable: true, select: false, default: null })
    bannerImageId!: string | null;

    @Column({ type: 'varchar', length: 64, nullable: true, select: false, default: null })
    previewImageId!: string | null;

    @Index('idx_users_email', { synchronize: false })
    @Column({ type: 'varchar', length: 128, nullable: true, select: false, default: null })
    email!: string | null;

    @Column({ type: 'varchar', length: 20, array: true, default: [], select: false })
    finishedTutorials!: string[];

    @Column({ type: 'boolean', nullable: false, select: false, default: false })
    newsletter!: boolean;

    @Column({ type: 'boolean', nullable: false, select: false, default: false })
    weeklyNewsletter!: boolean;

    @Column({ type: 'boolean', nullable: false, select: false, default: true })
    dmNotifications!: boolean;

    @Column({ type: 'enum', enum: UserProfileTypeEnum, nullable: false, select: false })
    displayAccount!: Models.User.ProfileItemType;

    @Column({ name: 'is_bot', type: 'boolean', nullable: false, default: false })
    isBot!: boolean;

    @OneToMany(() => UserAccount, (userAccount) => userAccount.user)
    userAccounts!: UserAccount[];

    @Column({ type: 'jsonb', nullable: false, default: {} })
    features!: Models.User.UserFeatures;

    @Column({ type: 'jsonb', nullable: true })
    platformBan!: Models.User.PlatformBan | null;

    @Column({ type: 'integer', nullable: false, default: 0 })
    followerCount!: number;

    @Column({ type: 'integer', nullable: false, default: 0 })
    followingCount!: number;

    @Column({ type: 'numeric', nullable: false, precision: 10, scale: 6, default: 1, select: false })
    trustScore!: string;

    @Column({ type: 'uuid', array: true, nullable: false, select: false, default: [] })
    communityOrder!: string[];

    @OneToMany(() => Device, (device) => device.user)
    devices!: Device[];

    @OneToMany(() => UserRoleClaim, (userRoleClaim) => userRoleClaim.user)
    userRoleClaims!: UserRoleClaim[];

    @OneToMany(() => Notification, (notification) => notification.user)
    notifications!: Notification[];

    @OneToMany(() => CallMembership, (callMembership) => callMembership.user)
    callMemberships!: CallMembership[];

    @OneToMany(() => UserPremium, (userPremium) => userPremium.user)
    premiumFeatures!: UserPremium[];

    @Column({ type: 'boolean', nullable: false, default: false })
    emailVerified!: boolean;

    @OneToMany(() => TokenSaleRegistration, (tokenSaleRegistration) => tokenSaleRegistration.referredBy)
    tokenSaleReferrals!: TokenSaleRegistration[];

    @OneToMany(() => TokenSaleRegistration, (tokenSaleRegistration) => tokenSaleRegistration.user)
    tokenSaleRegistrations!: TokenSaleRegistration[];

    @Column({ type: 'jsonb', nullable: false, default: {} })
    extraData!: Models.User.ExtraData;

    @Index('idx_users_verification_codes', { synchronize: false })
    @Column({ type: 'varchar', length: 32, nullable: true, select: false })
    verificationCode!: string | null;

    @Column({ type: 'timestamptz', precision: 3, nullable: true, select: false })
    verificationCodeExpiration!: Date | null;

    @Column({ type: 'integer', nullable: false, default: 0 })
    pointBalance!: number;

    @OneToMany(() => Passkey, (passkey) => passkey.user)
    passkeys!: Passkey[];

    @Index()
    @Column({ type: 'text', array: true, nullable: true })
    tags!: string[];
    
    @CreateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    createdAt!: Date;

    @UpdateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    updatedAt!: Date;

    @Index()
    @DeleteDateColumn({ type: 'timestamptz', precision: 3, select: false })
    deletedAt!: Date | null;
}

@Entity({ name: 'followers' })
export class Follower {
    @PrimaryColumn({ type: 'uuid' })
    userId!: string;

    @Index()
    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({
        name: 'userId',
        referencedColumnName: 'id'
    })
    user!: User;

    @PrimaryColumn({ type: 'uuid' })
    otherUserId!: string;

    @Index()
    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({
        name: 'otherUserId',
        referencedColumnName: 'id'
    })
    otherUser!: User;

    @CreateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    createdAt!: Date;

    @UpdateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    updatedAt!: Date;

    @DeleteDateColumn({ type: 'timestamptz', precision: 3, select: false })
    deletedAt!: Date | null;
}

@Entity({ name: 'user_newsletter_status' })
export class UserNewsletterStatus {
    @PrimaryColumn({ type: 'uuid', nullable: false })
    userId!: string;

    @PrimaryColumn({ type: 'integer', nullable: false })
    newsletterId!: number;

    @Column({ type: 'boolean', nullable: false, default: false })
    emailClicked!: boolean;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({
        name: 'userId',
        referencedColumnName: 'id'
    })
    user!: User;

    @Column({ type: 'timestamptz', precision: 3, nullable: true })
    sentAt!: Date;
}
