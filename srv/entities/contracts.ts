// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Entity, Unique, Column, PrimaryGeneratedColumn, CreateDateColumn, UpdateDateColumn, ManyToMany, OneToMany, PrimaryColumn } from "typeorm";
import { Role } from "./roles";
import { WalletBalance } from "./wallets";

@Entity({ name: 'contracts' })
@Unique(['chain', 'address'])
export class Contract {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'varchar', length: 64, nullable: false })
    chain!: Models.Contract.ChainIdentifier;

    @Column({ type: 'varchar', length: 50, nullable: false })
    address!: Common.Address;

    @Column({ type: 'jsonb', nullable: false })
    data!: Models.Contract.OnchainData;

    @Column({ type: 'bigint', nullable: true, select: false })
    updatedAtBlock!: string | null;

    // the junction's foreign key to contracts was created without actions
    // (migration 1676888170060); TypeORM 1.x defaults this inverse side to
    // CASCADE, so the entity keeps the database's NO ACTION explicitly
    @ManyToMany(() => Role, (role) => role.contracts, { onDelete: 'NO ACTION', onUpdate: 'NO ACTION' })
    roles!: Role[];

    @OneToMany(() => WalletBalance, (walletBalance) => walletBalance.contract)
    balances!: WalletBalance[];

    @CreateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    createdAt!: Date;

    @UpdateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    updatedAt!: Date;
}

/*
@Entity({ name: 'token_data' })
export class TokenData {
    @PrimaryColumn('uuid')
    contractId!: string;

    @PrimaryColumn({ type: 'varchar', length: 100, nullable: false })
    tokenId!: string;

    @Column({ type: 'jsonb', nullable: false })
    data!: any;

    @CreateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    createdAt!: Date;

    @UpdateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    updatedAt!: Date;
}
*/