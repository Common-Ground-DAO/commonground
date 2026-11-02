// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Events {
  namespace Message {
    type Message = {
      type: 'cliMessageEvent';
    } & ({
      action: 'new';
      data: Models.Message.ApiMessage & {
        // Present when the message belongs to a community channel. Bot API
        // clients use it to route one connection across all installations.
        communityId?: string;
        // Stable Bot API v1 signal used to prevent accidental bot-to-bot loops.
        creatorIsBot: boolean;
      };
    } | {
      action: 'update';
      data:
        Pick<Models.Message.ApiMessage, "id" | "channelId" | "updatedAt">
        & { communityId?: string }
        // ownReaction: only in the copy sent to the reacting user's own room;
        // syncSeq: chat-sync, absent on older servers
        & Partial<Pick<Models.Message.ApiMessage, "body" | "attachments" | "parentMessageId" | "reactions" | "ownReaction" | "syncSeq" | "editedAt">>;
    } | {
      action: 'delete';
      data: {
        communityId?: string;
        channelId: string;
        deletedIds: string[];
        /**
         * chat-sync: highest syncSeq of the deleted rows; absent on older
         * servers. (`new` carries `syncSeq` in its ApiMessage, `update` in
         * its data; both are optional for the same reason.)
         */
        syncSeq?: number;
        /**
         * chat-sync: the syncSeq of every deleted row (a multi-row delete
         * bumps several), so the client records all of them and sees no
         * spurious gap; absent on older servers
         */
        syncSeqs?: number[];
      };
    });

    type Event = (
      Message
    );
  }
}
