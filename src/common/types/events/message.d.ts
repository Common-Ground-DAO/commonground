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
        & Partial<Pick<Models.Message.ApiMessage, "body" | "attachments" | "parentMessageId" | "reactions">>;
    } | {
      action: 'delete';
      data: {
        communityId?: string;
        channelId: string;
        deletedIds: string[];
      };
    });

    type Event = (
      Message
    );
  }
}
