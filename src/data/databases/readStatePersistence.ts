// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

/*
 * ReadStatePersistence (data/chat/types.ts) over the shared Dexie entity
 * databases: a channelId is either a community channel (communities DB) or a
 * DM (chat DB). `apply` re-reads the row and merges with mergeReadState in
 * one rw transaction, so tabs applying the same inputs converge. Channels
 * without a row (article comments, call chats, channels not stored yet) are
 * ignored.
 */

import type { ChannelReadState, ReadStateInput, ReadStatePersistence } from 'data/chat/types';
import communityDatabase from './community';
import chatDatabase from './chats';

export interface EntityReadStatePersistence extends ReadStatePersistence {
  /** applies one input to the channel's row (no row: nothing happens) */
  apply(input: ReadStateInput): Promise<void>;
  /** the stored read state of a community channel or DM */
  get(channelId: string): Promise<ChannelReadState | undefined>;
}

const entityReadStatePersistence: EntityReadStatePersistence = {
  async apply(input) {
    const community = await communityDatabase.applyReadState(input);
    if (community === undefined) {
      await chatDatabase.applyReadState(input);
    }
  },
  async get(channelId) {
    return (await communityDatabase.getReadState(channelId)) ?? chatDatabase.getReadState(channelId);
  },
};

export default entityReadStatePersistence;
