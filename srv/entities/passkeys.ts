// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import {
    Entity,
    Column,
    PrimaryGeneratedColumn,
    CreateDateColumn,
    Index,
    ManyToOne,
    JoinColumn,
    DeleteDateColumn,
    UpdateDateColumn
} from "typeorm";
import { User } from "./users";

@Entity({ name: 'passkeys' })
// expression index (rpId, data->>'credentialID'), created by migration
@Index('IDX_passkeys_rpId_credentialID', { synchronize: false })
@Index('IDX_passkeys_userId_rpId', ['userId', 'rpId'])
export class Passkey {
    @PrimaryGeneratedColumn('uuid')
    id!: string;

    @Column({ type: 'uuid', nullable: true })
    userId!: string;

    @ManyToOne(() => User, { onDelete: 'CASCADE' })
    @JoinColumn({
        name: 'userId',
        referencedColumnName: 'id'
    })
    user!: User | null;

    @Index('IDX_passkeys_data_credentialID_webAuthnUserID', { synchronize: false })
    @Column({ type: 'jsonb', nullable: false })
    data!: Models.Passkey.FullData;

    @Column({ type: 'bigint', nullable: false, default: 0 })
    counter!: number;

    // WebAuthn relying party the credential was registered for. A credential
    // is only offered and accepted where this equals the process's RP ID;
    // NULL matches no relying party (docs/auth-identity §7).
    @Column({ type: 'text', nullable: true })
    rpId!: string | null;

    // origin from clientDataJSON at registration (audit only)
    @Column({ type: 'text', nullable: true })
    origin!: string | null;

    // user-chosen label
    @Column({ type: 'text', nullable: true })
    name!: string | null;

    @Column({ type: 'timestamptz', precision: 3, nullable: true })
    lastUsedAt!: Date | null;

    @CreateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    createdAt!: Date;

    @UpdateDateColumn({ type: 'timestamptz', precision: 3, select: false })
    updatedAt!: Date;

    @DeleteDateColumn({ type: 'timestamptz', precision: 3, select: false })
    deletedAt!: Date | null;
}
