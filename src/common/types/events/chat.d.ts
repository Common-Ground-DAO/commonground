// SPDX-License-Identifier: AGPL-3.0-or-later
//
// Additional terms: see LICENSE-ADDITIONAL-TERMS.md

declare namespace Events {
  namespace Chat {
    type Chat = {
      type: 'cliChatEvent';
    } & ({
      action: 'new';
      data: Models.Chat.ChatFromApi;
    } | {
      action: 'update';
      data: (
        Pick<Models.Chat.ChatFromApi, "id" | "channelId"> &
        Partial<Models.Chat.ChatFromApi>
      );
    } | {
      action: 'delete';
      data: Pick<Models.Chat.ChatFromApi, "id">;
    });

    type Event = Chat;
  }
}