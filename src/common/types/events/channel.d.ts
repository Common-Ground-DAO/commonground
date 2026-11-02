// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Events {
  namespace Channel {
    type LastRead = {
      type: 'cliChannelLastRead';
      channelId: string;
      /** the stored (max-merged) value once the server has G13; ISO */
      lastRead: string;
      /**
       * chat-sync: unread count right after the write (capped at
       * API.Messages.UnreadCap). Absent on older servers.
       */
      unread?: number;
      /** chat-sync: channel syncSeq that `unread` is valid at */
      syncSeq?: number;
      /** chat-sync: set for community channels */
      communityId?: string;
      /** chat-sync: set for DMs */
      chatId?: string;
    }

    type Event = (
      LastRead
    );
  }
}