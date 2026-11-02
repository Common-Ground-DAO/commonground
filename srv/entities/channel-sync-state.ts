// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

import { Entity, PrimaryColumn, Column } from "typeorm";

/**
 * Per-channel message change sequence (chat-sync, docs/database "Message sync
 * sequence"). Written only by the `messages_sync_seq_*` triggers on
 * `messages` (migration 1793635200000-chatSyncSeq): every insert and every
 * real update of a message increments `seq` of its channel and stores the
 * new value in `messages."syncSeq"`. A channel without a row has seq 0.
 * Read by `Message/getChanges`, `Message/getSyncState` and
 * `Message/setChannelLastRead`.
 */
@Entity({ name: 'channel_sync_state' })
export class ChannelSyncState {
    @PrimaryColumn({ type: 'uuid', primaryKeyConstraintName: 'PK_channel_sync_state' })
    channelId!: string;

    /** bigint: node-postgres returns it as a string */
    @Column({ type: 'bigint', nullable: false })
    seq!: string;
}
